// 查询：待处理的事、取事件

import { changed, state } from './core.js';
import { compactState, markLeaderRead } from './common.js';

const KEEP_DELIVERED_EVENTS = 200;
const READ_BY_EVENT = new Set(['user_reply', 'user_message', 'question']);
export function pendingActions() {
  return state.tasks.filter((t) => t.status === 'submitted' || t.status === 'asking' || t.status === 'held');
}

export function takeEvents() {
  const fresh = state.events.filter((e) => !e.delivered);
  if (fresh.length === 0) return [];
  for (const e of fresh) {
    e.delivered = true;
    // leader 的监听收到事件，事件对应的话就算 leader 已读
    if (READ_BY_EVENT.has(e.type) && e.taskId) {
      const task = state.tasks.find((t) => t.id === e.taskId);
      if (task) markLeaderRead(task);
    }
  }
  const delivered = state.events.filter((e) => e.delivered);
  if (delivered.length > KEEP_DELIVERED_EVENTS) {
    const drop = new Set(delivered.slice(0, delivered.length - KEEP_DELIVERED_EVENTS));
    state.events = state.events.filter((e) => !drop.has(e));
  }
  // 先把全文交出去再截短：返回的是同一批对象，复制一份给调用方
  const out = fresh.map((e) => ({ ...e }));
  compactState();
  changed();
  return out;
}
