// 内部辅助：时间线、事件、已读、查找、校验、编号、状态瘦身等各部分共用的小函数

import { AteamError } from '../errors.js';
import { changed, now, state } from './core.js';

// runtime.json 瘦身：已送达事件的文字只留开头（全文在卡的时间线里），让出编号的旧记录只留认人用的几项
const DELIVERED_TEXT_MAX = 300;
const KEEP_RETIRED_AGENTS = 100;
const LONG_GONE_MS = 24 * 60 * 60 * 1000;
// 只是通知、leader 不用做什么的事件：记下但不推给 leader 的监听。每推一条，leader 就要带着整段对话处理一轮，
// 很费 token；这些事看板和 ateam status 里都看得到，需要 leader 处理的后果（比如缺人）另有事件
export const QUIET_EVENTS = new Set([
  'claimed', 'worker_joined', 'worker_back', 'worker_offline', 'worker_leaving', 'worker_auto_leave', 'job_accepted',
  'demo_queued', 'demo_started', 'demo_ended', 'demo_stopped', 'demo_saved', 'demo_unclaimed', 'demo_interrupted',
]);
export function addHistory(task, type, actor, text = '', commit) {
  const entry = { ts: now(), type, actor, text };
  if (commit) entry.commit = commit;
  task.history.push(entry);
}

// 消息的已读状态：null 表示未读；没有这个字段的是这个功能之前的旧记录。
// 只跟踪提问（leader 读）、答复和补充说明（worker 读）、用户发的话（两边都读），进度、交付不跟踪
export function trackRead(task, by) {
  const entry = task.history.at(-1);
  entry.workerReadAt = null;
  if (by === 'user') entry.leaderReadAt = null;
}

export function trackLeaderRead(task) {
  task.history.at(-1).leaderReadAt = null;
}

export function markLeaderRead(task) {
  let dirty = false;
  for (const h of task.history) {
    if (h.leaderReadAt === null) { h.leaderReadAt = now(); dirty = true; }
  }
  return dirty;
}

// ateam show：leader 看了整张卡，卡上的话都算读过
export function leaderOpenedTask(taskId) {
  if (markLeaderRead(getTask(taskId))) changed();
}

// 已读：worker 调用 ateam 时拿到了（via 'ateam'），或经 hook 送到后它运行 ateam ack 回执了（via 'ack'）。
// only 给了就只标这些条目
export function markWorkerRead(task, via, only = null) {
  for (const h of task.history) {
    if (h.workerReadAt === null && (!only || only(h))) { h.workerReadAt = now(); h.workerReadVia = via; }
  }
}

// 已送达：hook 把内容交给了平台，还没等到 worker 回执
export function markWorkerDelivered(task) {
  for (const h of task.history) {
    if (h.workerReadAt === null && !h.workerDeliveredAt) h.workerDeliveredAt = now();
  }
}

export function emit(type, fields = {}) {
  state.seq.event += 1;
  state.events.push({ id: state.seq.event, ts: now(), type, text: '', ...fields, delivered: QUIET_EVENTS.has(type) });
}

// agent 在 shell 里用普通引号传多行文字时，换行常变成字面的 \n（两个字符）。整段没有真换行、
// 却有两处以上 \n 的，当成换行还原（只出现一处的不动，免得误伤代码里的 "\n"）
function unescapeNewlines(text) {
  if (text.includes('\n') || (text.match(/\\n/g) ?? []).length < 2) return text;
  return text.replace(/\\n/g, '\n');
}

export function requireText(value, what) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AteamError('INVALID', `${what}不能为空。请补上${what}后重试。`);
  }
  return unescapeNewlines(value.trim());
}

export function cleanList(list, what) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new AteamError('INVALID', `${what}必须是列表。`);
  return list.map((s) => String(s).trim()).filter(Boolean);
}

export function getJob(id) {
  const job = state.jobs.find((j) => j.id === id);
  if (!job) throw new AteamError('NOT_FOUND', `找不到需求 ${id}。请运行 ateam status 查看现有需求。`);
  return job;
}

export function getTask(id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) throw new AteamError('NOT_FOUND', `找不到任务 ${id}。请运行 ateam status 查看现有任务。`);
  return task;
}

export function findAgent(id) {
  return state.agents.find((a) => a.id === id);
}

export function checkDeps(dependsOn, selfId) {
  for (const dep of dependsOn) {
    if (dep === selfId) throw new AteamError('INVALID', `任务 ${selfId} 不能依赖自己。请修改 --after。`);
    if (getTask(dep).status === 'cancelled') throw new AteamError('INVALID', `任务 ${dep} 已作废，不能依赖它。请修改 --after。`);
  }
}

// 编号 = 角色 + 序号，比如 frontend-1、frontend-2。新加入的 worker 拿本角色最小的空号：
// 从没用过的号，或者用过它的 worker 已不在线、24 小时内没用这个号调过任何 ateam 命令（被拒绝的调用也算），
// 手上也没有挂着的任务。点了下线但旧窗口还在调用的，号一直留着，新窗口拿别的号，不会两个窗口共用一个号。
const REUSE_QUIET_MS = 24 * 60 * 60 * 1000;
export function roleSlug(role) {
  return role.trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'worker';
}

export function reusable(agent) {
  if (agent.status === 'online') return false;
  const last = Math.max(agent.lastCallAt ?? 0, agent.lastSeenAt ?? 0, agent.joinedAt ?? 0);
  if (now() - last < REUSE_QUIET_MS) return false;
  return !state.tasks.some((t) => (t.assignee === agent.id && !['approved', 'cancelled', 'pending'].includes(t.status))
    || (t.assignTo === agent.id && t.status === 'pending'));
}

// 号让给新 worker：旧记录移到 retiredAgents（时间线里的旧记录照常显示这个编号）
export function retireAgent(agent) {
  state.agents.splice(state.agents.indexOf(agent), 1);
  (state.retiredAgents ??= []).push({ ...agent, retiredAt: now() });
  compactState();
}

const clip = (text) => (typeof text === 'string' && text.length > DELIVERED_TEXT_MAX ? `${text.slice(0, DELIVERED_TEXT_MAX)}…` : text);
// runtime.json 里一直在长的几块收一收：启动时、送达事件后、租约扫描时各跑一次，没东西可收就不动
export function compactState() {
  let dirty = false;
  // 早期测试版给没有会话记录的旧卡写过 "tokens": null（没有意义，还改动了已归档的需求文件），去掉
  for (const t of state.tasks) if (t.tokens === null) { delete t.tokens; dirty = true; }
  for (const e of state.events) {
    if (e.delivered && e.text !== clip(e.text)) { e.text = clip(e.text); dirty = true; }
  }
  const retired = state.retiredAgents ?? [];
  const slim = retired.slice(-KEEP_RETIRED_AGENTS).map(({ id, role, name, joinedAt, retiredAt }) => ({ id, role, ...(name ? { name } : {}), joinedAt, retiredAt }));
  if (JSON.stringify(slim) !== JSON.stringify(retired)) { state.retiredAgents = slim; dirty = true; }
  // 已下线一天以上的 worker：只留编号复用、认人、重连要用的字段（叫停通知还没送到的留着会话号）
  for (const a of state.agents) {
    if (a.status === 'online') continue;
    const last = Math.max(a.lastCallAt ?? 0, a.lastSeenAt ?? 0, a.joinedAt ?? 0);
    if (now() - last < LONG_GONE_MS) continue;
    for (const key of ['idleSince', 'leaveAsked', 'busyUntil', 'stale', 'lastCritiqued', 'critiqueBatch', 'demoReleased', 'pendingMessage', 'tabOpened', 'leaveNotified']) {
      if (key in a) { delete a[key]; dirty = true; }
    }
    if (a.hookSession && !a.hookStop) { delete a.hookSession; dirty = true; }
  }
  return dirty;
}

export function newAgentId(role) {
  const slug = roleSlug(role);
  for (let n = 1; ; n++) {
    const id = `${slug}-${n}`;
    const old = findAgent(id);
    if (!old) return id;
    if (reusable(old)) { retireAgent(old); return id; }
  }
}
