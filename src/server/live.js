// 长连接：worker 的 wait、leader 的 watch、看板事件流；有变化时唤醒；leader 在不在；租约巡检

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSteps } from '../demo.js';
import { AteamError } from '../errors.js';
import { latestChangeTime } from '../git.js';
import { saveState } from '../persist.js';
import { dataDir, root, store } from './context.js';
import { send, sendError } from './http.js';
import { withRules } from './rules.js';
import { syncSoon } from './sync.js';

const DEFAULT_HOLD_SEC = 90;
const MAX_HOLD_SEC = 110;

const LEADER_FRESH_MS = 3 * 60 * 1000;
function holdMs(timeout) {
  const sec = Number(timeout);
  if (!Number.isFinite(sec) || sec <= 0) return DEFAULT_HOLD_SEC * 1000;
  return Math.min(sec, MAX_HOLD_SEC) * 1000;
}

export const waiters = new Map(); // agentId -> { res, timer }
export const waitRenewAt = new Map(); // agentId -> 上一段 wait 超时结束的时间
export const watchers = new Set(); // { res, timer }
export let leaderSeenAt = null; // leader 最近一次用命令行操作的时间（只在内存里，重启后等 leader 下次操作）
// leader 在线：挂着 watch 监听，或 3 分钟内用命令行操作过
export const leaderOnline = () => watchers.size > 0 || (leaderSeenAt !== null && Date.now() - leaderSeenAt < LEADER_FRESH_MS);
let waking = false;
let wakeScheduled = false;

// 无 leader 模式。自动进入（设置里打开时）：leader 超过设置的分钟数既没挂着 watch、也没用命令行
// （服务刚启动从启动时算起）。token 用完后后台的 watch --follow 还会挂到 Monitor 到期（最多半小时），这段算容错。
// 退出：自动进入的，leader 重新挂上 watch 或执行命令就退出；用户手动宣布下线的，只认 leader 执行 watch 以外的命令
// （token 用完的 leader 后台 watch 还在重连，不能让它把用户的宣布顶掉）。状态存在 store 里，重启后保留到 leader 真回来
const serverStart = Date.now();
let leaderActedAt = null;
let lastWatchEnd = 0;
function checkLeader() {
  const t = Date.now();
  const away = store.state.noLeader;
  if (away) {
    const acted = leaderActedAt !== null && leaderActedAt >= away.since;
    if (acted || (away.by !== 'user' && watchers.size > 0)) store.setLeaderAway(false);
    return;
  }
  if (!store.config().autoNoLeader || watchers.size > 0) return;
  if (t - Math.max(serverStart, leaderSeenAt ?? 0, lastWatchEnd) > store.config().leaderAwayMin * 60000) store.setLeaderAway(true);
}

// 每次状态变化：落盘，并在下一轮事件循环唤醒挂起的请求。
// 唤醒过程本身（nextFor 的 touch、takeEvents）也会触发 onChange，用 waking 标记避免循环。
// 看板的推送连接（SSE）。浏览器会暂停后台标签页的定时器，看板的 3 秒轮询在后台可能不跑，
// 标签页标题上的提醒就不更新；网络推送来的消息在后台照样会处理，收到后看板立即刷新一次。
export const streams = new Set();
export function pushAll(msg) {
  for (const res of streams) res.write(`data: ${msg}\n\n`);
}

// 状态变化很频繁（每次心跳都算），合并成最多每秒推一次
export let pushTimer = null;
export function pushSoon() {
  if (pushTimer || streams.size === 0) return;
  pushTimer = setTimeout(() => { pushTimer = null; pushAll('change'); }, 1000);
}

export function onChange() {
  saveState(dataDir, store.state);
  pushSoon();
  syncSoon();
  wakeSoon();
}

// 安排一次唤醒（同一轮里多次变化只唤醒一次）
export function wakeSoon() {
  if (waking || wakeScheduled) return;
  wakeScheduled = true;
  setImmediate(wake);
}

// leader 用命令行操作了：记下时间（watch 只算在线，不算操作）
export function leaderSeen(acted) {
  leaderSeenAt = Date.now();
  if (acted) leaderActedAt = leaderSeenAt;
  checkLeader();
}

function wake() {
  wakeScheduled = false;
  waking = true;
  try {
    for (const [agentId, waiter] of [...waiters]) {
      try {
        const result = store.nextFor(agentId);
        if (result) finishWaiter(agentId, waiter, 200, { ok: true, result: withRules(result, agentId) });
      } catch (err) {
        finishWaiter(agentId, waiter, err instanceof AteamError ? 400 : 500,
          { ok: false, code: err.code ?? 'INTERNAL', message: err.message });
      }
    }
    if (watchers.size > 0) {
      const events = store.takeEvents();
      if (events.length > 0) {
        for (const watcher of [...watchers]) finishWatcher(watcher, { ok: true, events });
      }
    }
  } finally {
    waking = false;
  }
}

export function finishWaiter(agentId, waiter, status, body) {
  clearTimeout(waiter.timer);
  if (waiters.get(agentId) === waiter) waiters.delete(agentId);
  send(waiter.res, status, body);
}

function finishWatcher(watcher, body) {
  clearTimeout(watcher.timer);
  watchers.delete(watcher);
  lastWatchEnd = Date.now();
  send(watcher.res, 200, body);
}

export function handleWait(body, res) {
  const agentId = body.as;
  // 先结束同一 worker 的旧挂起，再派发：否则旧挂起可能在下一轮 wake 里再收到同一个任务
  const old = waiters.get(agentId);
  if (old) finishWaiter(agentId, old, 200, { ok: true, result: null, superseded: true, waiting: store.waitingInfo(agentId) });

  const result = store.nextFor(agentId); // 先 touch，掉线的 worker 在这里拿到 LEASE_LOST
  if (result) return send(res, 200, { ok: true, result: withRules(result, agentId) });

  const waiter = { res, timer: null };
  waiter.timer = setTimeout(() => {
    try {
      store.touch(agentId);
      waitRenewAt.set(agentId, Date.now());
      finishWaiter(agentId, waiter, 200, { ok: true, result: null, waiting: store.waitingInfo(agentId) });
    } catch (err) {
      finishWaiter(agentId, waiter, 400, { ok: false, code: err.code ?? 'INTERNAL', message: err.message });
    }
  }, holdMs(body.timeout));
  waiters.set(agentId, waiter);
  res.on('close', () => {
    if (waiters.get(agentId) === waiter) {
      clearTimeout(waiter.timer);
      waiters.delete(agentId);
    }
  });
}

// 报告演播的一步。暂停中：挂起这次请求，继续后放行（记下这一步）；挂满 timeout 还在暂停，
// 回 paused，worker 原样再运行一次。叫停、中断等也在挂起期间放行，由 demoStep 给出结果
function demoStepOnce(b) {
  // 从脚本里取这一步的讲解和下一步，给看板提词；读不到脚本就不提词，不影响演播
  let cue = null;
  const held = store.state.agents.find((a) => a.id === b.as)?.currentTask;
  const task = held && store.state.tasks.find((t) => t.id === held && t.kind === 'demo');
  if (task) {
    try {
      const steps = parseSteps(readFileSync(join(root, task.script), 'utf8'));
      const i = steps.findIndex((s) => s.n === Number(b.n));
      const step = i >= 0 ? steps[i] : null;
      cue = { narration: step?.narration ?? '', next: steps[i + 1]?.text ?? '' };
    } catch {}
  }
  return store.demoStep(b.as, b.n, b.total, b.text, cue, !!b.slow);
}
export function handleDemoStep(body, res) {
  const first = demoStepOnce(body);
  if (!first.paused) return send(res, 200, { ok: true, ...first });
  const taskId = first.task.id;
  const deadline = Date.now() + holdMs(body.timeout);
  const timer = setInterval(() => {
    const t = store.state.tasks.find((x) => x.id === taskId);
    const still = t?.paused && t.status === 'demoing';
    if (still && Date.now() < deadline) return;
    clearInterval(timer);
    if (still) return send(res, 200, { ok: true, ...first, task: t });
    try { send(res, 200, { ok: true, ...demoStepOnce(body) }); } catch (err) { sendError(res, err); }
  }, 500);
  res.on('close', () => clearInterval(timer));
}

export function handleWatch(body, res) {
  const events = store.takeEvents();
  if (events.length > 0) return send(res, 200, { ok: true, events });
  const watcher = { res, timer: null };
  watcher.timer = setTimeout(() => finishWatcher(watcher, { ok: true, events: [] }), holdMs(body.timeout));
  watchers.add(watcher);
  checkLeader(); // 自动进入的无 leader 模式：leader 重新挂上监听就退出
  res.on('close', () => {
    clearTimeout(watcher.timer);
    if (watchers.delete(watcher)) lastWatchEnd = Date.now();
  });
}

// 租约扫描。判掉线之前，先看 worker 任务路径里有没有比上次心跳更新的文件改动：
// 埋头写代码、很久没调用 ateam 命令的 worker，只要文件还在变，就不算掉线。
let sweeping = false;
export async function sweepTick() {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const agent of store.state.agents) {
      if (agent.status !== 'online' || !agent.currentTask || waiters.has(agent.id)) continue;
      if (Date.now() - agent.lastSeenAt <= store.leaseMs) continue;
      const task = store.state.tasks.find((t) => t.id === agent.currentTask);
      if (!task || (task.status !== 'working' && task.status !== 'asking')) continue;
      const ts = await latestChangeTime(root, task.paths).catch(() => null);
      if (ts) store.noteActivity(agent.id, ts);
    }
    checkLeader();
    store.sweep((id) => waiters.has(id));
    store.expireDemoRequests();
    store.checkIdle({ leaderAway: !leaderOnline() || !!store.state.noLeader });
    store.checkStaffing();
  } finally {
    sweeping = false;
  }
}
