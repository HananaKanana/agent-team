// token 用量：用量报告、按日存档、每张卡的用量快照

import { readFileSync, writeFileSync } from 'node:fs';
import { buildReport } from '../usage-report.js';
import { collect as collectUsage, totalOf } from '../usage.js';
import { historyFile, root, store } from './context.js';

// ---------- token 用量（DeepSeek Harness 的会话记录，见 usage.js、usage-report.js）----------
// 明细要解压会话记录，30 秒内复用上一次的结果（解压结果按文件缓存，会话没变就不再解）
let usageCache = null;
let usageRunning = null;
// 按天存档：.ateam/usage-daily.json。过去的日子算好后封存，会话记录（DeepSeek Harness 手动删除、Claude Code 默认 30 天清理）被删也不丢
export let usageHistory = { days: {} };
export function loadUsageHistory() {
  try { const h = JSON.parse(readFileSync(historyFile, 'utf8')); if (h?.days && typeof h.days === 'object') usageHistory = h; } catch {}
}
function sealDays(seal) {
  if (!seal || !Object.keys(seal).length) return;
  usageHistory = { days: { ...usageHistory.days, ...seal } };
  try { writeFileSync(historyFile, `${JSON.stringify(usageHistory)}\n`); } catch {}
}
export async function usageReport(fresh = false) {
  if (!fresh && usageCache && Date.now() - usageCache.generatedAt < 30000) return usageCache;
  // 同时来的几个请求共用一次计算
  usageRunning ??= (async () => {
    try {
      const collected = await collectUsage({ root, segments: store.agentSegments(), bound: store.boundSessions() });
      usageCache = buildReport({ state: store.state, collected, history: usageHistory });
      sealDays(usageCache.seal);
      usageCache.collected = collected; // 只看某个需求时用同一份明细重算
      return usageCache;
    } finally { usageRunning = null; }
  })();
  return usageRunning;
}
// 卡详情的「Token」：已通过的卡用记在卡上的数，其他卡现算（进行中的卡随 worker 干活增长）。
// 返回 { input, cacheRead, output, calls, live, heavy }；没人做过 { none }；本机没有会话记录 { unavailable }
export async function tokensOf(task) {
  const r = await usageReport();
  const heavy = r.heavyOf(task.id);
  const done = task.status === 'approved' || task.status === 'cancelled';
  // perTask 已经取了现算和卡上快照中较大的那个
  const u = r.perTask.get(task.id);
  if (u) return { input: u.input, cacheRead: u.cacheRead, output: u.output, calls: u.calls, live: !done, heavy };
  const segs = [...store.agentSegments()].filter(([, list]) => list.some((x) => x.task === task.id));
  if (!segs.length) return { none: true };
  // 做这张卡的 worker 有会话记录（只是这张卡还没调用过模型）记 0；都没有（WorkBuddy 等）算没有数据
  if (segs.some(([agentId]) => r.agentsSeen.has(agentId))) return { input: 0, cacheRead: 0, output: 0, calls: 0, live: !done, heavy: null };
  return { unavailable: true };
}
// 卡的快照：提交、交接、下线放下、通过、作废时把当时的用量记到卡上（取和已记的较大值，只增不减），
// 之后 worker 下线、编号让给别人、会话记录被删，都不影响查看。只记 7 天内有这些动作的卡：更早的卡会话多半已不在，
// 不往已归档的需求文件里写空值（它们提交在项目的 git 里）
const SNAPSHOT_WINDOW = 7 * 24 * 60 * 60 * 1000;
const SNAP_MARKS = new Set(['submitted', 'handoff', 'parked', 'approved', 'cancelled']);
const snapMark = (t) => [...t.history].reverse().find((h) => SNAP_MARKS.has(h.type))?.ts ?? 0;
const snapTried = new Map(); // 卡 → 已经看过的那个时间点：没有用量的卡（WorkBuddy 等）不每分钟重算一遍
export async function snapshotTokens() {
  const due = () => store.state.tasks.filter((t) => {
    const m = snapMark(t);
    return m && Date.now() - m < SNAPSHOT_WINDOW && m > (t.tokens ? (t.tokens.at ?? Infinity) : 0) && snapTried.get(t.id) !== m;
  });
  if (!due().length) return;
  const r = await usageReport(true);
  for (const t of due()) {
    const m = snapMark(t);
    snapTried.set(t.id, m);
    const u = r.perTask.get(t.id);
    if (u && totalOf(u)) store.setTaskTokens(t.id, { input: u.input, cacheRead: u.cacheRead, output: u.output, calls: u.calls, at: m });
  }
}
