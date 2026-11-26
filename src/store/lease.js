// 租约：worker 多久没动静算停了、超时处理、收回任务

import { AteamError } from '../errors.js';
import { changed, now, state } from './core.js';
import { config } from './settings.js';
import { addHistory, compactState, emit, findAgent, getTask } from './common.js';
import { releaseAssignments } from './jobs.js';
import { clearStale } from './workers.js';
import { interruptDemo, isDemo } from './demo.js';

// leader（或用户在看板上）确认原窗口没了，立即收回任务交给别人接手，不必等租约过期。
// 同时把原 worker 标记为掉线：原窗口万一又活过来，会收到「租约已失效」并重新加入，不会和接手的人抢同一个任务。
export function reclaim(taskId, reason = '') {
  const task = getTask(taskId);
  if (isDemo(task) && (task.status === 'demoing' || task.status === 'wrapping')) {
    const agent = task.assignee && findAgent(task.assignee);
    if (agent) {
      agent.status = 'offline';
      agent.currentTask = null;
      delete agent.stale;
      agent.hookStop = { kind: 'reclaimed', taskId: task.id, demo: true };
    }
    interruptDemo(task, `收回 ${agent?.id ?? '原 worker'} 手上的演播${String(reason ?? '').trim() ? `：${String(reason).trim()}` : ''}`);
    changed();
    return { task, agentId: agent?.id ?? null };
  }
  if (task.status !== 'working' && task.status !== 'asking') {
    throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，只有进行中或等待答复的任务可以收回。`);
  }
  // 先放下的卡：原 worker 正在做别的卡，只收回卡，不动它
  const agent = !task.parked && task.assignee && findAgent(task.assignee);
  delete task.parked;
  delete task.parkedFor;
  const who = task.assignee ?? '原 worker';
  if (agent) {
    agent.status = 'offline';
    agent.currentTask = null;
    delete agent.stale;
    agent.hookStop = { kind: 'reclaimed', taskId: task.id };
  }
  task.status = 'pending';
  task.handoff = true;
  task.prevAssignee = task.assignee;
  task.assignee = null;
  reason = String(reason ?? '').trim();
  addHistory(task, 'handoff', 'lead', `收回 ${who} 手上的任务，等待接手${reason ? `：${reason}` : ''}`);
  emit('worker_offline', { agentId: agent?.id, taskId: task.id, text: `${who} 的任务 ${task.id} 已被收回，等待接手` });
  changed();
  return { task, agentId: agent?.id ?? null };
}

// 租约扫描：
// - 手上有进行中任务的 worker：没动静超过 leaseMs 只标记「可能停了」并提醒（它可能在跑很长的命令），
//   任务一直留在它手上，等用户确认后才收回（reclaim）。worker 用 progress --expect 报备过的时长也算有动静。
// - 其它 worker（空闲、或任务已提交等 review）：超过 leaseMs 直接判掉线，没有任务要转手。
export function sweep(isWaiting) {
  if (compactState()) changed();
  let count = 0;
  for (const agent of state.agents) {
    if (agent.status !== 'online' || isWaiting(agent.id)) continue;
    const seen = Math.max(agent.lastSeenAt, agent.busyUntil ?? 0);
    const quiet = now() - seen;
    if (quiet <= config().leaseMin * 60000) continue;
    const task = agent.currentTask && state.tasks.find((t) => t.id === agent.currentTask);
    // 演播卡不等用户确认：演播中掉线就算中断，冻结立即解除
    const active = task && !isDemo(task) && (task.status === 'working' || task.status === 'asking');
    if (active) {
      if (!agent.stale) {
        agent.stale = true;
        emit('worker_stale', {
          agentId: agent.id, taskId: task.id,
          text: `${agent.id} 已经 ${Math.round(quiet / 60000)} 分钟没动静（手上 ${task.id}），可能在跑很长的命令，也可能窗口停了。任务仍留在它手上，等用户确认`,
        });
        count += 1;
      }
      continue;
    }
    agent.status = 'offline';
    delete agent.stale;
    count += 1;
    let reclaimed = null;
    if (agent.currentTask) {
      if (task && isDemo(task) && (task.status === 'demoing' || task.status === 'wrapping')) {
        interruptDemo(task, `${agent.id} 掉线`);
      } else if (active) {
        task.status = 'pending';
        task.handoff = true;
        task.prevAssignee = agent.id;
        task.assignee = null;
        reclaimed = task.id;
      }
      agent.currentTask = null;
    }
    if (agent.dismiss) {
      agent.dismissed = true;
      agent.hidden = true;
      delete agent.dismiss;
      releaseAssignments(agent.id, '已下线');
    }
    emit('worker_offline', {
      agentId: agent.id, taskId: reclaimed ?? undefined,
      text: reclaimed ? `${agent.id} 掉线，任务 ${reclaimed} 已收回，等待接手` : `${agent.id} 掉线`,
    });
  }
  if (count > 0) changed();
  return count;
}

// 任务路径里有比上次心跳更新的文件改动时，把心跳推到那个时间（见 server 的租约扫描）
export function noteActivity(agentId, ts) {
  const agent = findAgent(agentId);
  if (!agent || agent.status !== 'online' || !(ts > agent.lastSeenAt)) return false;
  agent.lastSeenAt = Math.min(ts, now());
  clearStale(agent);
  changed();
  return true;
}
