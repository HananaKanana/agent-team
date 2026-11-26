// 补充说明和留言：leader 的补充说明、给 worker 的消息、用户直接回复，经 hook 送达和回执

import { AteamError } from '../errors.js';
import { changed, now, state } from './core.js';
import {
  addHistory, emit, findAgent, getTask, markWorkerDelivered, markWorkerRead, requireText, trackRead
} from './common.js';
import { cancelMessage, clearStale, stopMessage, touch } from './workers.js';
import { answer } from './review.js';
import { agentIdOfHookSession } from './hooks.js';
import { isDemo } from './demo.js';

// leader 给正在做的 worker 补充说明（比如审卡发现描述有误）。worker 在下一个工具调用结束（启用 hook 时）或下一次 progress、wait、submit 时收到
// by 为 'user'：用户在看板上直接留言，worker 收到时标明来自用户
export function noteTask(taskId, text, by = 'lead') {
  text = requireText(text, '补充说明');
  const task = getTask(taskId);
  // 用户留言还可以给待 review 的卡：leader review 时看到，打回后 worker 也会看到
  if (task.status !== 'working' && task.status !== 'asking' && !(by === 'user' && task.status === 'submitted')) {
    throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，只有进行中的任务能补充说明；待领取的直接 ateam task edit 改卡。`);
  }
  const line = by === 'user' ? `（用户直接说）${text}` : text;
  task.pendingNote = task.pendingNote ? `${task.pendingNote}\n\n${line}` : line;
  addHistory(task, 'note', by, text);
  trackRead(task, by);
  changed();
  return task;
}
export function noteForHookSession(session) {
  const agentId = agentIdOfHookSession(session);
  if (!agentId) return null;
  // 工具调用后 hook 在跑，说明 worker 正在干活：算一次心跳，长时间不调用 ateam 也不会被当成无响应。
  // 不算 lastCallAt：那是 worker 自己的调用
  const agent = findAgent(agentId);
  if (agent?.status === 'online' && !agent.dismissed) {
    agent.lastSeenAt = now();
    clearStale(agent);
    changed();
  }
  return noteForHook(agentId);
}
// agent 平台的工具后 hook 来取：worker 干活的两步之间就能看到留言，不用等它调用 ateam。
// 这不是 worker 自己的调用，所以不走 touch，不算它的活动。
function noteForHook(agentId) {
  const agent = findAgent(agentId);
  if (!agent) return null;
  // 干活时被立即下线或任务被收回：卡已经退回待领取、可能马上有人接手，它却还不知道。叫它停手，只送一次
  if (agent.hookStop) {
    const stop = agent.hookStop;
    delete agent.hookStop;
    changed();
    return { taskId: stop.taskId, stop: stopMessage(stop, agent) };
  }
  if (agent.dismissed) return null;
  // 手上的卡被作废了：卡已经不归它，但它可能还在干。作废通知也经 hook 送一次（同样只看不取，
  // 下一次调用 ateam 时照常再收到）
  const notice = agent.cancelNotice;
  if (notice?.wasWorking && !notice.sentByHook) {
    notice.sentByHook = true;
    changed();
    return { taskId: notice.taskId, cancel: cancelMessage(state.tasks.find((t) => t.id === notice.taskId), true, agent.id) };
  }
  if (!agent.currentTask) return null;
  const task = getTask(agent.currentTask);
  // 演播被用户叫停：卡已进收尾，worker 却要到报下一步时才知道，这一步里还会接着操作浏览器
  if (task.stopNotice && !task.stopSentByHook) {
    task.stopSentByHook = true;
    changed();
    return { taskId: task.id, stop: `用户叫停了演播 ${task.id}。**立刻停手，停在当前页面，不要再操作浏览器，也不要清理数据**（客户可能还在看）。然后运行 ateam wait --as ${agent.id}，按输出的「已叫停」说明收尾。` };
  }
  // 经 hook 送出只算「已送达」：平台可能运行了 hook 却没把内容交给模型。每次送出带一个回执号，
  // worker 看完运行 ateam ack <回执号> 才算已读；没回执的仍留到下一次调用 ateam（提交前一定看到）。
  // 同一内容只经 hook 发一次，之后又追加了内容的，整段换个回执号再发
  const note = task.pendingNote;
  if (!note || task.noteSentByHook === note) return null;
  task.noteSeq = (task.noteSeq ?? 0) + 1;
  task.noteSentByHook = note;
  task.noteAckId = `${task.id}-${task.noteSeq}`;
  markWorkerDelivered(task);
  changed();
  return { taskId: task.id, note, ackId: task.noteAckId, agentId: agent.id };
}
export function ackNote(agentId, ackId) {
  const agent = touch(agentId);
  const task = agent.currentTask && getTask(agent.currentTask);
  ackId = String(ackId ?? '').trim();
  if (!task || !task.pendingNote || ackId !== task.noteAckId) {
    // 已经在别处看过（调用 ateam 时拿到了）或回执号过时：没有要确认的
    const newer = task?.pendingNote && task.noteAckId && ackId !== task.noteAckId ? task.noteAckId : null;
    return { taskId: task?.id ?? null, acked: false, newer };
  }
  const sent = task.noteSentByHook ?? '';
  const rest = task.pendingNote.startsWith(sent) ? task.pendingNote.slice(sent.length).trim() : task.pendingNote;
  markWorkerRead(task, 'ack', (h) => !!h.workerDeliveredAt);
  if (rest) task.pendingNote = rest;
  else delete task.pendingNote;
  delete task.noteSentByHook;
  delete task.noteAckId;
  changed();
  return { taskId: task.id, acked: true, newer: null };
}
export function takeNote(task) {
  const note = task.pendingNote;
  if (!note) return null;
  markWorkerRead(task, 'ateam');
  delete task.pendingNote;
  delete task.noteSentByHook;
  delete task.noteAckId;
  changed();
  return note;
}
// 用户在看板上直接回复：卡在等答复就当答复送给 worker，在做就当补充说明；都通知 leader
export function userReply(taskId, text) {
  const task = getTask(taskId);
  let kind;
  if (task.status === 'asking') { answer(taskId, text, 'user'); kind = 'answer'; }
  else if (task.status === 'working') { noteTask(taskId, text, 'user'); kind = 'note'; }
  else if (task.status === 'submitted') { noteTask(taskId, text, 'user'); kind = 'review'; }
  else throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，只有进行中、返工中、等答复、待 review 的卡能直接回复。`);
  emit('user_reply', {
    taskId: task.id, agentId: task.assignee ?? undefined, kind,
    text: kind === 'answer' ? `用户直接答复了 ${task.id} 的提问：${text.trim()}`
      : kind === 'review' ? `用户对待 review 的 ${task.id} 留言：${text.trim()}`
      : `用户给正在做 ${task.id} 的 worker 留言：${text.trim()}`,
  });
  changed();
  return task;
}
// 直接发给 worker：手上有进行中的卡就当作这张卡的补充说明，否则等它的 wait 收
export function messageAgent(agentId, text, by = 'lead') {
  text = requireText(text, '消息');
  const agent = findAgent(agentId);
  if (!agent) throw new AteamError('NOT_FOUND', `没有编号为 ${agentId} 的 worker。`);
  if (agent.status !== 'online' || agent.dismissed) throw new AteamError('BAD_STATE', `${agentId} 不在线，收不到消息。`);
  const task = agent.currentTask ? getTask(agent.currentTask) : null;
  const viaNote = task && !isDemo(task) && (task.status === 'working' || task.status === 'asking');
  if (viaNote) {
    noteTask(task.id, text, by);
  } else {
    const line = by === 'user' ? `（用户直接说）${text}` : text;
    agent.pendingMessage = agent.pendingMessage ? `${agent.pendingMessage}\n\n${line}` : line;
  }
  if (by === 'user') emit('user_message', { agentId: agent.id, taskId: viaNote ? task.id : undefined, text: `用户给 ${agent.id} 发了消息：${text}` });
  changed();
  return { agentId: agent.id, taskId: viaNote ? task.id : null };
}
