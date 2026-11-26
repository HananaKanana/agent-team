// token 用量：一张卡由哪些 worker、在哪些时间段处理；换会话；每日摘要

import { changed, now, state } from './core.js';
import { findAgent, getTask } from './common.js';
import { isCritic } from './critique.js';

// 按卡的时间线切分每个 worker 的时间：领取、汇报进度、提问时算在做这张卡，提交、挂起、
// 被收回、作废、通过时结束，打回后接着算给原来的 worker；同一 worker 换做别的卡时切过去。
// 返回 [{ agentId, sessions, from, to }]，用量由 server 按时间段从会话记录里汇总（usage.js）
const NOT_WORKER = new Set(['lead', 'user', 'system']);
const TOKEN_ON = new Set(['claimed', 'progress', 'asked', 'demo_saved']);
const TOKEN_OFF_BY_WORKER = new Set(['submitted', 'parked']);
const TOKEN_OFF = new Set(['approved', 'released', 'cancelled', 'handoff']);
// 每个 worker 编号做过哪些卡、各在什么时间段：Map(编号 → [{ task, from, to }])，按时间排好。
// 编号会让给新 worker，但同一时间只属于一个 worker，按时间段对会话记录不会串
export function agentSegments() {
  const marks = [];
  for (const t of state.tasks) {
    let last = null;
    for (const h of t.history) {
      const worker = !NOT_WORKER.has(h.actor);
      if (TOKEN_ON.has(h.type) && worker) { last = h.actor; marks.push({ ts: h.ts, agentId: h.actor, task: t.id, on: true }); }
      else if (h.type === 'rejected' && last) marks.push({ ts: h.ts, agentId: last, task: t.id, on: true });
      else if (TOKEN_OFF_BY_WORKER.has(h.type) && worker) marks.push({ ts: h.ts, agentId: h.actor, task: t.id, on: false });
      else if (TOKEN_OFF.has(h.type) && last) marks.push({ ts: h.ts, agentId: last, task: t.id, on: false });
    }
  }
  marks.sort((a, b) => a.ts - b.ts);
  const out = new Map();
  const cur = new Map(); // 编号 → { task, from }
  const close = (agentId, to) => {
    const c = cur.get(agentId);
    if (!c) return;
    if (!out.has(agentId)) out.set(agentId, []);
    out.get(agentId).push({ task: c.task, from: c.from, to });
    cur.delete(agentId);
  };
  for (const m of marks) {
    const c = cur.get(m.agentId);
    if (m.on) {
      if (c?.task === m.task) continue;
      close(m.agentId, m.ts);
      cur.set(m.agentId, { task: m.task, from: m.ts });
    } else if (c?.task === m.task) {
      close(m.agentId, m.ts);
    }
  }
  for (const agentId of [...cur.keys()]) close(agentId, now());
  return out;
}

// 定时小结上次发出的时间（每日 / 每周），随 runtime.json 保存，服务重启后不重复发
export function digestSent(kind) { return state.digestSent?.[kind] ?? 0; }
export function markDigest(kind, ts) { (state.digestSent ??= {})[kind] = ts; changed(); }

// 卡通过后把用量记在卡上（随 board.json 保存）：worker 下线、会话记录被删后仍能查看
// 服务按会话记录算出某个 worker 的上下文已超过设置：打上标记，它下次要领新卡时换新会话。ctx 是万 token
export function markRotate(agentId, ctx) {
  const agent = findAgent(agentId);
  if (!agent || agent.status !== 'online' || isCritic(agent) || agent.dismiss || agent.rotate) return false;
  agent.rotate = ctx;
  changed();
  return true;
}

export function setTaskTokens(taskId, tokens) {
  const task = getTask(taskId);
  if (JSON.stringify(task.tokens) === JSON.stringify(tokens)) return;
  task.tokens = tokens;
  changed();
}

