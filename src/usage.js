// leader 和 worker 的 token 用量：从 agent 平台在本机的会话记录里读，只读不改。
// - Claude Code：~/.claude/projects/<项目目录，非字母数字换成 -> /<会话号>.jsonl，子代理在 <会话号>/subagents/ 下。
//   每条回复的 message.usage：input_tokens + cache_creation_input_tokens（写入缓存）算输入，cache_read_input_tokens 算缓存命中。
//   同一条回复会分几行写（每个内容块一行），按 message.id 去重
// - DeepSeek Harness：见下
// 记录在 ~/.dsh/sessions/<项目>/<会话号>/session.v4.jsonl.zstd：第一行是会话信息（带 cwd），模型每回一次有一行
// assistant/message，带 usage：inputTokens（没命中缓存的输入）、cacheReadTokens（命中缓存的输入）、outputTokens。
// 会话属于谁：运行过 `ateam ... --as <编号>` 的是那个 worker（按时间，编号可能中途换）；运行过 `ateam leader` 或
// `ateam watch` 的是 leader；都没有时用 hook 记下的对应关系，再没有就算「其他会话」。
// 每次调用按时间归到当时在做的卡（store.agentSegments），不在任何卡上的算「空转」（等活、加入、下线前后）；
// 认不出 worker 的会话（比如用户自己在项目里开的对话）算「其他会话」。
// WorkBuddy 的会话在云端，本机没有用量，读不到。只读，不改 DSH 的任何文件。
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import zlib from 'node:zlib';

const FILE = 'session.v4.jsonl.zstd';
const sessionsDir = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions');
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

const where = new Map(); // 会话号 → 记录文件
const parsed = new Map(); // DSH 记录文件 → 读到哪里和已解析的内容（见 sessionInfo）
const cwdOf = new Map(); // 记录文件 → 会话的工作目录（不会变，读一次）

// DSH 每次追加写一个新的 zstd 帧，Node 自带的解压只解第一帧：按帧格式（RFC 8878）切开，逐帧解
function frames(buf, from = 0) {
  const out = [];
  let p = from;
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
    out.push({ data: buf.subarray(start, p), end: p });
  }
  return out;
}

const hasZstd = typeof zlib.zstdDecompressSync === 'function';
function decompress(file) {
  // Node 22.15 起自带 zstd；更老的 Node 用系统的 zstd 命令（brew install zstd）
  if (!hasZstd) return execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return frames(readFileSync(file)).map((f) => zlib.zstdDecompressSync(f.data).toString('utf8')).join('');
}

// 会话的工作目录：只解第一帧读第一行
function sessionCwd(file) {
  if (cwdOf.has(file)) return cwdOf.get(file);
  let cwd = null;
  try {
    const text = hasZstd ? zlib.zstdDecompressSync(frames(readFileSync(file))[0].data).toString('utf8') : decompress(file);
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

// leader 才会运行的命令（worker 的 skill 里没有）
const LEADER_RE = /(?:^|[\s;&|(])ateam\s+(?:leader|watch)\b/;
// 只看工具调用里真正执行的命令，不看正文（leader 的回复里常引用 worker 的命令，会认错人）
function commandsOf(content) {
  const out = [];
  for (const c of Array.isArray(content) ? content : []) {
    if (c?.type === 'tool_use') out.push(typeof c.input?.command === 'string' ? c.input.command : '');
    else if (c?.type === 'tool-call') {
      let args = c.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { out.push(args); continue; } }
      out.push(typeof args?.command === 'string' ? args.command : typeof args?.cmd === 'string' ? args.cmd : '');
    }
  }
  return out.filter(Boolean);
}
const AS_CMD = /(?:^|[\s;&|(])(?:\S*\/)?ateam\s[^\n;&|]*?--as[ =]["']?([A-Za-z][\w.-]*)/;

// ---------- Claude Code ----------
const claudeDir = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
const ccFiles = new Map(); // 'cc:<会话号>' → [主记录, ...子代理记录]

function claudeSessions(root) {
  const dir = join(claudeDir(), real(root).replace(/[^A-Za-z0-9]/g, '-'));
  const out = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const id = n.slice(0, -6);
    const files = [join(dir, n)];
    try { for (const s of readdirSync(join(dir, id, 'subagents'))) if (s.endsWith('.jsonl')) files.push(join(dir, id, 'subagents', s)); } catch {}
    ccFiles.set(`cc:${id}`, files);
    out.push(`cc:${id}`);
  }
  return out;
}

// Claude Code 的记录只会追加，而且可能很大（leader 的会话几百 MB）：记住每个文件读到哪，之后只读新增的部分；
// 按 8MB 分块读，块之间让出事件循环，不卡住服务
const ccRead = new Map(); // 文件 → { offset, partial, byMsg, ids, leader }
const CHUNK = 8 * 1024 * 1024;

function claudeLine(line, st) {
  if (!line.includes('"type":"assistant"')) return;
  let j;
  try { j = JSON.parse(line); } catch { return; }
  const t = Date.parse(j.timestamp);
  const msg = j.message;
  if (j.type !== 'assistant' || !msg || Number.isNaN(t)) return;
  for (const cmd of commandsOf(msg.content)) {
    if (LEADER_RE.test(cmd)) st.leader = true;
    const m = cmd.match(AS_CMD);
    if (m) st.ids.push({ t, id: m[1] });
  }
  const u = msg.usage;
  if (u && msg.id) st.byMsg.set(msg.id, { t, input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cacheRead: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 });
}

async function readClaudeFile(file) {
  let size;
  try { size = statSync(file).size; } catch { return ccRead.get(file) ?? null; }
  let st = ccRead.get(file);
  if (!st || size < st.offset) { st = { offset: 0, partial: Buffer.alloc(0), byMsg: new Map(), ids: [], leader: false }; ccRead.set(file, st); }
  if (size === st.offset) return st;
  let fd;
  try { fd = openSync(file, 'r'); } catch { return st; }
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    while (st.offset < size) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, size - st.offset), st.offset);
      if (n <= 0) break;
      st.offset += n;
      const data = st.partial.length ? Buffer.concat([st.partial, buf.subarray(0, n)]) : buf.subarray(0, n);
      const last = data.lastIndexOf(0x0a);
      // 最后一行可能还没写完：留到下次
      st.partial = Buffer.from(last < 0 ? data : data.subarray(last + 1));
      if (last >= 0) for (const line of data.toString('utf8', 0, last).split('\n')) claudeLine(line, st);
      await new Promise((r) => setImmediate(r));
    }
  } finally { closeSync(fd); }
  return st;
}

async function parseClaude(files) {
  const entries = [];
  const ids = [];
  let leader = false;
  for (const f of files) {
    const st = await readClaudeFile(f);
    if (!st) continue;
    entries.push(...st.byMsg.values());
    ids.push(...st.ids);
    leader ||= st.leader;
  }
  entries.sort((a, b) => a.t - b.t);
  ids.sort((a, b) => a.t - b.t);
  const dedup = ids.filter((x, i) => i === 0 || ids[i - 1].id !== x.id);
  // 运行过 leader 命令的就是 leader 的会话（worker 不会运行这些命令）
  return { entries, ids: leader ? [] : dedup, leader, platform: 'Claude Code' };
}

// 一个会话：{ entries: [{ t, input, cacheRead, output }], ids: [{ t, id }] }；会话不在本机时返回 null
export async function sessionInfo(session) {
  if (session?.startsWith('cc:')) {
    const files = ccFiles.get(session);
    return files ? parseClaude(files) : null;
  }
  const file = session && locate(session);
  if (!file) return null;
  let size;
  try { size = statSync(file).size; } catch { return null; }
  // 增量：记住处理到哪个字节（只算完整的帧），下次只解新增的帧，逐帧处理不拼成一个大字符串
  let st = parsed.get(file);
  if (!st || size < st.offset) { st = { offset: 0, partial: '', entries: [], ids: [], leader: false }; parsed.set(file, st); }
  if (size !== st.offset) {
    const take = (text) => {
      const all = st.partial + text;
      const last = all.lastIndexOf('\n');
      st.partial = last < 0 ? all : all.slice(last + 1);
      if (last >= 0) for (const line of all.slice(0, last).split('\n')) dshLine(line, st);
    };
    const fresh = () => { st = { offset: 0, partial: '', entries: [], ids: [], leader: false }; parsed.set(file, st); };
    const run = () => {
      if (hasZstd) {
        for (const f of frames(readFileSync(file), st.offset)) { take(zlib.zstdDecompressSync(f.data).toString('utf8')); st.offset = f.end; }
      } else {
        fresh();
        take(decompress(file));
        st.offset = size;
      }
    };
    try { run(); } catch {
      // 文件被整个重写过（记住的位置不在帧的边界上）：从头再读一次
      if (st.offset > 0) { fresh(); try { run(); } catch {} }
    }
  }
  return { entries: st.entries, ids: st.leader ? [] : st.ids, leader: st.leader, platform: 'DeepSeek Harness' };
}

function dshLine(line, st) {
  if (!line.includes('"assistant/message"')) return;
  let j;
  try { j = JSON.parse(line); } catch { return; }
  if (j.type !== 'assistant/message' || typeof j.time !== 'number') return;
  for (const cmd of commandsOf(j.data?.message?.content)) {
    if (LEADER_RE.test(cmd)) st.leader = true;
    const m = cmd.match(AS_CMD);
    if (m && st.ids.at(-1)?.id !== m[1]) st.ids.push({ t: j.time, id: m[1] });
  }
  const u = j.data?.usage;
  if (u) st.entries.push({ t: j.time, input: u.inputTokens || 0, cacheRead: u.cacheReadTokens || 0, output: u.outputTokens || 0 });
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
  const sessions = new Set([...projectSessions(root), ...claudeSessions(root), ...bound.map((b) => b.session)]);
  const perTask = new Map();
  const records = [];
  let found = 0;
  const platforms = {};
  for (const s of sessions) {
    await new Promise((r) => setImmediate(r));
    const info = await sessionInfo(s);
    if (!info) continue;
    found++;
    platforms[info.platform] = (platforms[info.platform] ?? 0) + 1;
    const fallback = boundTo.get(s) ?? null;
    let k = 0;
    for (const e of info.entries) {
      // 当时的编号：最近一次 --as 用的；还没用过（刚加入）就用之后第一次出现的，再不行用 hook 记的
      while (k + 1 < info.ids.length && info.ids[k + 1].t <= e.t) k++;
      const agentId = info.ids.length ? info.ids[k].id : info.leader ? null : fallback;
      let task = null;
      if (agentId) {
        for (const seg of segments.get(agentId) ?? []) if (e.t >= seg.from && e.t <= seg.to) { task = seg.task; break; }
        if (task) { if (!perTask.has(task)) perTask.set(task, zero()); add(perTask.get(task), e); }
      }
      records.push({ ...e, agentId, task, leader: !agentId && info.leader, platform: info.platform });
    }
  }
  return { perTask, records, sessions: found, platforms };
}


export { zero as zeroUsage, add as addUsage };
