// review：通过、打回、答复提问、放回

import { AteamError } from '../errors.js';
import { changed, state } from './core.js';
import { config } from './settings.js';
import { addHistory, emit, findAgent, getTask, requireText, trackRead } from './common.js';
import { unpark } from './no-leader.js';
import { isDemo } from './demo.js';

export function releaseAgentOf(task) {
  const agent = task.assignee && findAgent(task.assignee);
  if (agent && agent.currentTask === task.id) agent.currentTask = null;
}

export function approve(taskId, note = '') {
  const task = getTask(taskId);
  if (task.status !== 'submitted' && task.status !== 'held') {
    throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，只有 submitted 或 held 的任务可以通过。`);
  }
  task.status = 'approved';
  task.handoff = false;
  task.pendingDelivery = null;
  delete task.parked;
  delete task.parkedFor;
  releaseAgentOf(task);
  addHistory(task, 'approved', 'lead', note ?? '');
  // 有新代码进来了：预演过的演播卡，页面可能已经变了
  for (const t of state.tasks) if (isDemo(t) && t.rehearsedAt && !t.mayChange) t.mayChange = true;
  changed();
  return task;
}

export function reject(taskId, text) {
  text = requireText(text, '修改意见');
  const task = getTask(taskId);
  if (task.status !== 'submitted') {
    throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，只有 submitted 的任务可以打回。`);
  }
  task.rejectCount += 1;
  addHistory(task, 'rejected', 'lead', text);

  if (task.rejectCount >= config().rejectLimit) {
    task.status = 'held';
    delete task.parked;
    delete task.parkedFor;
    releaseAgentOf(task);
    emit('task_held', { taskId: task.id, text: `${task.id} 已被打回 ${task.rejectCount} 次，转为挂起，等你处理（task edit + release，或自己修改后 approve）` });
  } else {
    const agent = findAgent(task.assignee);
    task.pendingDelivery = { kind: 'rejected', text };
    if (task.parked) {
      unpark(task);
    } else if (agent && agent.status === 'online' && agent.currentTask === task.id) {
      task.status = 'working';
    } else {
      task.status = 'pending';
      task.handoff = true;
      task.assignee = null;
    }
  }
  changed();
  return task;
}

export function answer(taskId, text, by = 'lead', userApproved = false) {
  text = requireText(text, '答复');
  const task = getTask(taskId);
  if (task.userQuestion && task.status === 'asking' && by !== 'user' && !userApproved) {
    throw new AteamError('NEEDS_USER', `${task.id} 的提问需要用户本人决定（技术选型这类），不要自己答。把问题和候选原样转给用户，用户答复后运行 ateam answer ${task.id} "<用户的决定>" --user-approved；用户也可以在看板上直接答复。`);
  }
  delete task.userQuestion;
  if (task.status === 'asking' && task.parked) {
    unpark(task);
  } else if (task.status === 'asking') {
    task.status = 'working';
  } else if (!(task.status === 'pending' && task.handoff)) {
    throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，没有待回答的提问。`);
  }
  task.pendingDelivery = by === 'user' ? { kind: 'answer', text, by } : { kind: 'answer', text };
  addHistory(task, 'answered', by, text);
  trackRead(task, by);
  changed();
  return task;
}

export function release(taskId) {
  const task = getTask(taskId);
  if (task.status !== 'held') {
    throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，只有 held 的任务可以放回。`);
  }
  task.status = 'pending';
  task.rejectCount = 0;
  task.assignee = null;
  // 已有提交时按接手处理，让下一位 worker 先看历史和 git 现状
  task.handoff = task.commits.length > 0;
  addHistory(task, 'released', 'lead', '重新放回待领取');
  changed();
  return task;
}

