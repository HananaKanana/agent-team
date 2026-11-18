// worker 的 token 用量：从 DeepSeek Harness 本机的会话记录里读。
// 记录在 ~/.dsh/sessions/<项目>/<会话号>/session.v4.jsonl.zstd，模型每回一次有一行 assistant/message，
// 带 usage：inputTokens（没命中缓存的输入）、cacheReadTokens（命中缓存的输入）、outputTokens。
// 会话号就是 hook 学到的 session，所以能对上 worker。WorkBuddy 的会话在云端，本机没有用量，读不到。
// 只读，不改 DSH 的任何文件。
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

const FILE = 'session.v4.jsonl.zstd';
const sessionsDir = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions');

const where = new Map(); // 会话号 → 记录文件
const parsed = new Map(); // 记录文件 → { stamp, entries }

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

function decompress(file) {
  // Node 22.15 起自带 zstd；更老的 Node 用系统的 zstd 命令（brew install zstd）
  if (typeof zlib.zstdDecompressSync !== 'function') {
    return execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  }
  return frames(readFileSync(file)).map((f) => zlib.zstdDecompressSync(f).toString('utf8')).join('');
}

// 一个会话的每次模型调用：[{ t, input, cacheRead, output }]；会话不在本机（WorkBuddy、已删除）时返回 null
export function sessionUsage(session) {
  const file = session && locate(session);
  if (!file) return null;
  let st;
  try { st = statSync(file); } catch { return null; }
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = parsed.get(file);
  if (hit?.stamp === stamp) return hit.entries;
  let text;
  try { text = decompress(file); } catch { return hit?.entries ?? null; }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"') || !line.includes('"assistant/message"')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const u = j?.data?.usage;
    if (j.type !== 'assistant/message' || !u || typeof j.time !== 'number') continue;
    entries.push({ t: j.time, input: u.inputTokens || 0, cacheRead: u.cacheReadTokens || 0, output: u.outputTokens || 0 });
  }
  parsed.set(file, { stamp, entries });
  return entries;
}

// 一张卡的用量：windows 是 store.taskTokenWindows 给的 [{ agentId, sessions, from, to }]。
// 返回 { input, cacheRead, output, calls, missing }；missing 是本机找不到记录的会话数。没有任何可用会话时返回 null
export function taskUsage(windows) {
  const sum = { input: 0, cacheRead: 0, output: 0, calls: 0, missing: 0 };
  let found = 0;
  const seen = new Set();
  for (const w of windows) {
    for (const s of w.sessions) {
      const entries = sessionUsage(s);
      if (!entries) { if (!seen.has(s)) { seen.add(s); sum.missing++; } continue; }
      found++;
      for (const e of entries) {
        if (e.t < w.from || e.t > w.to) continue;
        sum.input += e.input;
        sum.cacheRead += e.cacheRead;
        sum.output += e.output;
        sum.calls++;
      }
    }
  }
  return found ? sum : null;
}
