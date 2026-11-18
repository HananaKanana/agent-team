// worker 的 token 用量：从 DeepSeek Harness 本机的会话记录里读。
// 记录在 ~/.dsh/sessions/<项目>/<会话号>/session.v4.jsonl.zstd：第一行是会话信息（带 cwd），模型每回一次有一行
// assistant/message，带 usage：inputTokens（没命中缓存的输入）、cacheReadTokens（命中缓存的输入）、outputTokens。
// 会话属于哪个 worker：从 worker 自己运行的 `ateam ... --as <编号>` 命令里认，认不出时用 hook 记下的对应关系。
// 每次调用按时间归到当时在做的卡（store.agentSegments），不在任何卡上的算「空转」（等活、加入、下线前后）；
// 认不出 worker 的会话（比如用户自己在项目里开的对话）算「其他会话」。
// WorkBuddy 的会话在云端，本机没有用量，读不到。只读，不改 DSH 的任何文件。
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import zlib from 'node:zlib';

const FILE = 'session.v4.jsonl.zstd';
const sessionsDir = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions');
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

const where = new Map(); // 会话号 → 记录文件
const parsed = new Map(); // 记录文件 → { stamp, info }
const cwdOf = new Map(); // 记录文件 → 会话的工作目录（不会变，读一次）

// DSH 每次追加写一个新的 zstd 帧，Node 自带的解压只解第一帧：按帧格式（RFC 8878）切开，逐帧解
function frames(buf) {
  const out = [];
  let p = 0;
  while (p + 8 <= buf.length) {
    const magic = buf.readUInt32LE(p);
    if ((magic & 0xfffffff0) === 0x184d2a50) { p += 8 + buf.readUInt32LE(p + 4); continue; } // 可跳过的帧
    if (magic !== 0xfd2fb528) throw new Error('不是 zstd 数据');
    const start = p;
    const fhd = buf[p + 4];
    const single = (fhd >> 5) & 1;
    p += 5 + (single ? 0 : 1) + [0, 1, 2, 4][fhd & 3] + [single, 2, 4, 8][fhd >> 6];
    for (;;) {
      if (p + 3 > buf.length) throw new Error('zstd 数据不完整');
      const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
      const type = (h >> 1) & 3;
      p += 3 + (type === 1 ? 1 : h >>> 3);
      if (h & 1) break;
    }
    if ((fhd >> 2) & 1) p += 4;
    if (p > buf.length) break; // 最后一帧还在写：先不要
    out.push(buf.subarray(start, p));
  }
  return out;
}

const hasZstd = typeof zlib.zstdDecompressSync === 'function';
function decompress(file) {
  // Node 22.15 起自带 zstd；更老的 Node 用系统的 zstd 命令（brew install zstd）
  if (!hasZstd) return execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return frames(readFileSync(file)).map((f) => zlib.zstdDecompressSync(f).toString('utf8')).join('');
}

// 会话的工作目录：只解第一帧读第一行
function sessionCwd(file) {
  if (cwdOf.has(file)) return cwdOf.get(file);
  let cwd = null;
  try {
    const text = hasZstd ? zlib.zstdDecompressSync(frames(readFileSync(file))[0]).toString('utf8') : decompress(file);
    const nl = text.indexOf('\n');
    cwd = JSON.parse(nl < 0 ? text : text.slice(0, nl)).cwd ?? null;
  } catch {}
  cwdOf.set(file, cwd);
  return cwd;
}

function locate(session) {
  if (!/^[\w-]{1,80}$/.test(session)) return null;
  const hit = where.get(session);
  if (hit && existsSync(hit)) return hit;
  let dirs = [];
  try { dirs = readdirSync(sessionsDir()); } catch { return null; }
  for (const d of dirs) {
    const file = join(sessionsDir(), d, session, FILE);
    if (existsSync(file)) { where.set(session, file); return file; }
  }
  return null;
}

// 项目目录下的所有 DSH 会话号
export function projectSessions(root) {
  const want = real(root);
  const out = [];
  let dirs = [];
  try { dirs = readdirSync(sessionsDir()); } catch { return out; }
  for (const d of dirs) {
    let subs = [];
    try { subs = readdirSync(join(sessionsDir(), d)); } catch { continue; }
    for (const s of subs) {
      const file = join(sessionsDir(), d, s, FILE);
      if (!existsSync(file)) continue;
      const cwd = sessionCwd(file);
      if (cwd && real(cwd) === want) { where.set(s, file); out.push(s); }
    }
  }
  return out;
}

// worker 运行的 ateam 命令里的编号（工具调用参数是转义过的 JSON 字符串，引号前可能有反斜杠）
const AS_RE = /--as[ =]\\?["']?([A-Za-z][\w.-]*)/;

// 一个会话：{ entries: [{ t, input, cacheRead, output }], ids: [{ t, id }] }；会话不在本机时返回 null
export function sessionInfo(session) {
  const file = session && locate(session);
  if (!file) return null;
  let st;
  try { st = statSync(file); } catch { return null; }
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = parsed.get(file);
  if (hit?.stamp === stamp) return hit.info;
  let text;
  try { text = decompress(file); } catch { return hit?.info ?? null; }
  const entries = [];
  const ids = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"assistant/message"')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.type !== 'assistant/message' || typeof j.time !== 'number') continue;
    const m = line.match(AS_RE);
    if (m && ids.at(-1)?.id !== m[1]) ids.push({ t: j.time, id: m[1] });
    const u = j.data?.usage;
    if (u) entries.push({ t: j.time, input: u.inputTokens || 0, cacheRead: u.cacheReadTokens || 0, output: u.outputTokens || 0 });
  }
  const info = { entries, ids };
  parsed.set(file, { stamp, info });
  return info;
}

export function sessionUsage(session) {
  return sessionInfo(session)?.entries ?? null;
}

const zero = () => ({ input: 0, cacheRead: 0, output: 0, calls: 0 });
const add = (s, e) => { s.input += e.input; s.cacheRead += e.cacheRead; s.output += e.output; s.calls += e.calls ?? 1; };
export const totalOf = (s) => s.input + s.cacheRead + s.output;

// 整个项目的用量明细。segments：store.agentSegments() 给的 Map(编号 → [{ task, from, to }])；
// bound：hook 记下的 [{ agentId, session }]。返回 { perTask: Map(卡号 → 合计), records: [{ t, agentId, task, ...用量 }], sessions, other }
// 异步：第一次要解压所有会话（几十个会话约几秒），每解一个让出一次，不卡住服务
export async function collect({ root, segments, bound }) {
  const boundTo = new Map();
  for (const b of bound) if (!boundTo.has(b.session)) boundTo.set(b.session, b.agentId);
  const sessions = new Set([...projectSessions(root), ...bound.map((b) => b.session)]);
  const perTask = new Map();
  const records = [];
  let found = 0;
  for (const s of sessions) {
    await new Promise((r) => setImmediate(r));
    const info = sessionInfo(s);
    if (!info) continue;
    found++;
    const fallback = boundTo.get(s) ?? null;
    let k = 0;
    for (const e of info.entries) {
      // 当时的编号：最近一次 --as 用的；还没用过（刚加入）就用之后第一次出现的，再不行用 hook 记的
      while (k + 1 < info.ids.length && info.ids[k + 1].t <= e.t) k++;
      const agentId = info.ids.length ? info.ids[k].id : fallback;
      let task = null;
      if (agentId) {
        for (const seg of segments.get(agentId) ?? []) if (e.t >= seg.from && e.t <= seg.to) { task = seg.task; break; }
        if (task) { if (!perTask.has(task)) perTask.set(task, zero()); add(perTask.get(task), e); }
      }
      records.push({ ...e, agentId, task });
    }
  }
  return { perTask, records, sessions: found };
}

// 一张卡的用量：windows 是 store.taskTokenWindows 给的 [{ agentId, sessions, from, to }]。
// 返回 { input, cacheRead, output, calls, missing }；missing 是本机找不到记录的会话数。没有任何可用会话时返回 null
export function taskUsage(windows) {
  const sum = { ...zero(), missing: 0 };
  let found = 0;
  const seen = new Set();
  for (const w of windows) {
    for (const s of w.sessions) {
      const entries = sessionUsage(s);
      if (!entries) { if (!seen.has(s)) { seen.add(s); sum.missing++; } continue; }
      found++;
      for (const e of entries) if (e.t >= w.from && e.t <= w.to) add(sum, e);
    }
  }
  return found ? sum : null;
}

export { zero as zeroUsage, add as addUsage };
