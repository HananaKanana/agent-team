// 派发：依赖、按角色和顺序给 worker 找下一张卡、改同一批文件的冲突、等待时的说明

import { changed, onRotate, state } from './core.js';
import { config } from './settings.js';
import { addHistory, emit, findAgent, getTask, markWorkerRead } from './common.js';
import { pathsOverlap, peerId, peerTasks } from './paths.js';
import { onHold } from './jobs.js';
import { cancelMessage, finishDismiss, takeCancelNotice, touch } from './workers.js';
import { takeNote } from './notes.js';
import { park } from './no-leader.js';
import { critiqueQueue, critiqueView, isCritic } from './critique.js';
import { claimDemo, demoFrozen, demoNext, isDemo } from './demo.js';

function depsMet(task) {
  return task.dependsOn.every((id) => state.tasks.find((t) => t.id === id)?.status === 'approved');
}

export function sameRole(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// 派发顺序：优先的任务最先（后被设为优先的排更前），再是接手任务（有半成品），最后按编号
export function dispatchOrder(a, b) {
  return ((b.priority ?? 0) - (a.priority ?? 0)) || (b.handoff - a.handoff) || (Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

// spec §4.1：返回 { kind, task, delivery? } 或 null（asking 中、或没有可派发的任务）
export function nextFor(agentId) {
  const agent = touch(agentId);

  // 直接发给这个 worker 的消息（它手上没有能留言的卡时才走这里，见 messageAgent）
  if (agent.pendingMessage) {
    const text = agent.pendingMessage;
    delete agent.pendingMessage;
    changed();
    return { kind: 'message', text };
  }

  // 手上的任务刚被作废：先告诉它，再谈领新任务
  if (agent.cancelNotice && !agent.currentTask) {
    const notice = takeCancelNotice(agent);
    return { kind: 'cancelled', task: notice.task, wasWorking: notice.wasWorking, text: cancelMessage(notice.task, notice.wasWorking, agent.id, notice.sentByHook) };
  }

  // 已安排下线、手上没有任务 → 正式下线（手上有任务的，等任务通过、作废或收回后再下线）
  // 审卡 worker 安排了「审完再下线」，或者用户打开了全局开关「审完自动下线」：还有待审的卡就接着审，审完才下线
  if (isCritic(agent) && config().criticAutoLeave && !critiqueQueue().length) agent.dismiss = true;
  if (agent.dismiss && !agent.currentTask && !(isCritic(agent) && critiqueQueue().length)) {
    finishDismiss(agent);
    return { kind: 'dismissed' };
  }

  // 审卡 worker：不领开发任务，拿到的是还没审过的卡的清单
  if (isCritic(agent)) {
    const tasks = critiqueQueue();
    if (!tasks.length) return null;
    // 记下这批卡，看板据此显示它正在审哪张、还剩几张
    agent.critiqueBatch = tasks.map((t) => t.id);
    changed();
    // 附上这些卡所属需求的用户原话和说明，审卡要对照原话，不能只对照 leader 的理解
    const jobIds = [...new Set(tasks.map((t) => t.jobId))];
    const jobs = jobIds.map((id) => state.jobs.find((j) => j.id === id)).filter(Boolean)
      .map((j) => ({ id: j.id, title: j.title, origin: j.origin ?? '', description: j.description ?? '' }));
    return { kind: 'critique_list', tasks: tasks.map((t) => critiqueView(t)), jobs };
  }

  if (agent.currentTask) {
    const task = getTask(agent.currentTask);
    if (isDemo(task)) return demoNext(task);
    if (task.status === 'asking' && task.pendingNote) {
      // 等答复时收到留言：叫醒它看一眼，问题还在等答复
      return { kind: 'asking_note', task, text: takeNote(task) };
    }
    if (task.status !== 'working') {
      // asking / submitted：等答复或 review 结果。无 leader 模式下有别的卡能做，就把这张先放下，转做别的
      if (!(state.noLeader && candidatesFor(agent, task).length)) return null;
      park(agent, task);
    } else {
      // 规则 1：待送达的打回意见或答复
      if (task.pendingDelivery) {
        const delivery = task.pendingDelivery;
        task.pendingDelivery = null;
        markWorkerRead(task, 'ateam');
        // 待 review 时用户留的言，随打回意见一起给
        const note = takeNote(task);
        changed();
        return { kind: delivery.kind, task, delivery: note ? { ...delivery, text: `${delivery.text}\n\n## 补充说明（标着「用户直接说」的是用户本人说的，以它为准）\n\n${note}` } : delivery };
      }
      // 规则 2：重复调用 wait，重新返回当前任务（有补充说明一起带上）
      const note = takeNote(task);
      return note ? { kind: 'resume', task, delivery: { kind: 'note', text: note } } : { kind: 'resume', task };
    }
  }

  // 上下文太大、该换新会话的 worker：不再领新卡，下线，由服务开一个同角色的新 worker（见 markRotate）
  if (agent.rotate && !isCritic(agent)) {
    const role = agent.role;
    const ctx = agent.rotate;
    delete agent.rotate;
    finishDismiss(agent);
    onRotate(role, agent.id, ctx);
    return { kind: 'dismissed', rotate: ctx };
  }

  // 规则 3：领取新任务，派发顺序见 dispatchOrder
  // 掉线前自己在做、还没被别人领走的任务，优先还给自己
  // 用户在看板上指派给别人的任务不领；指派给自己的排在最前（仅次于掉线前自己在做的）
  // 用户点了「开始演播」的演播卡最先领；演播期间（冻结）不领普通任务
  const demo = state.tasks.find((t) => isDemo(t) && t.status === 'queued' && sameRole(t.role, agent.role) && (!t.assignTo || t.assignTo === agent.id));
  if (demo) return claimDemo(agent, demo);
  if (demoFrozen()) return null;

  const own = (t) => t.handoff && t.prevAssignee === agent.id;
  const task = candidatesFor(agent)[0];
  if (!task) return null;
  // 先放下的卡记下 worker 转做了哪张（看板上标「转做 T?」）
  const parkedTasks = state.tasks.filter((t) => t.parked && t.assignee === agent.id);
  for (const p of parkedTasks) p.parkedFor = task.id;
  const parked = parkedTasks.map((t) => t.id);
  const back = task.backFromPark;
  delete task.backFromPark;
  delete task.returnTo;

  if (own(task)) {
    task.status = 'working';
    task.assignee = agent.id;
    task.handoff = false;
    agent.currentTask = task.id;
    const delivery = task.pendingDelivery ?? undefined;
    task.pendingDelivery = null;
    addHistory(task, 'claimed', agent.id, back ? '拿回挂起的任务' : '重新加入，拿回掉线前自己在做的任务');
    emit('claimed', { taskId: task.id, agentId: agent.id, text: back ? `${agent.id} 拿回了挂起的 ${task.id}` : `${agent.id} 重新加入，拿回了 ${task.id}` });
    changed();
    return { kind: back ? 'back' : 'own', task, delivery, parked };
  }

  const isHandoff = task.handoff;
  task.status = 'working';
  task.assignee = agent.id;
  task.handoff = false;
  agent.currentTask = task.id;
  const delivery = task.pendingDelivery ?? undefined;
  task.pendingDelivery = null;
  const why = back ? '原 worker 不在线' : '上一位 worker 掉线';
  addHistory(task, 'claimed', agent.id, isHandoff ? `接手任务（${why}）` : '领取任务');
  emit('claimed', {
    taskId: task.id, agentId: agent.id,
    text: isHandoff ? `${agent.id} 接手了 ${task.id}（${why}）` : `${agent.id} 领取了 ${task.id}`,
  });
  changed();
  return { kind: isHandoff ? 'handoff' : 'task', task, delivery, parked };
}

// 这个 worker 能领的卡，按领取顺序排。also：马上要先放下的卡（还没标 parked），一起算进「先放下的卡」
// - 用户指派给别人的不领；挂起后退回的卡留给原 worker（returnTo），它不在线才谁都能领
// - 和先放下的卡改同一批文件的不领：提问先放下的卡有没提交的半成品，待 review 的卡打回后还要改这些文件
function candidatesFor(agent, also = null) {
  if (state.tasks.some((t) => isDemo(t) && t.status === 'queued' && sameRole(t.role, agent.role)) || demoFrozen()) return [];
  const own = (t) => t.handoff && t.prevAssignee === agent.id;
  const mine = (t) => t.assignTo === agent.id;
  const reserved = (t) => t.returnTo && t.returnTo !== agent.id && findAgent(t.returnTo)?.status === 'online';
  const parked = state.tasks.filter((t) => t.parked || t === also);
  return state.tasks
    .filter((t) => t.status === 'pending' && !onHold(t) && sameRole(t.role, agent.role) && depsMet(t) && (!t.assignTo || mine(t))
      && !reserved(t) && !parked.some((p) => pathsOverlap(p.paths, t.paths)) && !clashWith(t, agent.id))
    .sort((a, b) => (own(b) - own(a)) || (mine(b) - mine(a)) || dispatchOrder(a, b));
}

// 和别人手上正在改（进行中、等答复）的卡改同一批文件：先不派，等那张交了再派。
// 两个人同时改同一个文件，一个人提交时会把另一个人改了一半的内容也带进去。返回挡着它的那张卡
// 同事手上正在改的卡也算（他最近 2 小时同步过才算，免得一台关掉的电脑把卡一直挡着）
function clashWith(task, agentId = null) {
  if (isDemo(task)) return null;
  const local = state.tasks.find((o) => o !== task && !isDemo(o) && (o.status === 'working' || o.status === 'asking')
    && o.assignee && o.assignee !== agentId && pathsOverlap(o.paths, task.paths));
  if (local) return local;
  const p = peerTasks.find((o) => o.fresh && (o.status === 'working' || o.status === 'asking' || o.unpushed) && pathsOverlap(o.paths, task.paths));
  return p ? { id: peerId(p), title: p.title, assignee: p.assignee ? `${p.peer}·${p.assignee}` : p.peer, peer: p.peer, unpushed: !!p.unpushed } : null;
}
// 看板用：待领取、依赖已满足、但被别人正在改的卡挡住的卡 → 挡着它的卡。
// unpushedOnly：只列被同事「已通过、未推送」的卡挡住的
export function clashes(unpushedOnly = false) {
  const out = {};
  for (const t of state.tasks) {
    if (t.status !== 'pending' || !depsMet(t)) continue;
    const c = clashWith(t);
    if (c && (!unpushedOnly || c.unpushed)) out[t.id] = c.id;
  }
  return out;
}

// 「暂无任务」时告诉 worker 在等什么：本角色还有哪些任务在等依赖、等的是谁
export function waitingInfo(agentId) {
  const agent = findAgent(agentId);
  if (!agent) return null;
  if (agent.currentTask) {
    const task = state.tasks.find((t) => t.id === agent.currentTask);
    return task ? { holding: { id: task.id, status: task.status }, leaving: !!agent.dismiss } : null;
  }
  const blocked = state.tasks
    .filter((t) => t.status === 'pending' && sameRole(t.role, agent.role) && !depsMet(t))
    .map((t) => ({
      id: t.id, title: t.title,
      waitingFor: t.dependsOn
        .map((id) => state.tasks.find((x) => x.id === id))
        .filter((d) => d && d.status !== 'approved')
        .map((d) => ({ id: d.id, status: d.status })),
    }));
  for (const t of state.tasks) {
    if (t.status !== 'pending' || !sameRole(t.role, agent.role) || !depsMet(t)) continue;
    const c = clashWith(t, agent.id);
    if (c) blocked.push({ id: t.id, title: t.title, clash: { id: c.id, assignee: c.assignee, unpushed: !!c.unpushed, peer: c.peer ?? null } });
  }
  const f = demoFrozen();
  return { blocked, leaveAsked: !!agent.leaveAsked, critic: isCritic(agent), frozen: f ? { taskId: f.id, title: f.title } : null };
}
