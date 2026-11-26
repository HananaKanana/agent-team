// 无 leader 模式和缺人：leader 离线时的转做与放下、缺人提示、空闲判定

import { changed, now, state } from './core.js';
import { config } from './settings.js';
import { addHistory, emit } from './common.js';
import { onlineOfRole } from './workers.js';
import { sameRole } from './dispatch.js';
import { critiqueQueue, isCritic } from './critique.js';

// leader（Claude Code）token 用完、不在线时，worker 不干等：等答复、待 review 的卡先放下（parked），
// worker 先去做没有依赖、不撞文件的卡。leader 回来后答复或打回，卡退回待领取并留给原 worker（returnTo）；
// 原 worker 不在线就照常换手。先放下的卡 status 不变（asking / submitted），assignee 仍是原 worker
export function park(agent, task) {
  task.parked = now();
  agent.currentTask = null;
  addHistory(task, 'parked', agent.id, task.status === 'asking' ? 'leader 不在线，提问先放下，转做别的卡' : 'leader 不在线，等 review 期间转做别的卡');
  changed();
}

// 先放下的卡被答复或打回：退回待领取，留给原 worker
export function unpark(task) {
  delete task.parked;
  delete task.parkedFor;
  if (task.assignee) task.prevAssignee = task.assignee;
  task.returnTo = task.prevAssignee;
  task.backFromPark = true;
  task.status = 'pending';
  task.handoff = true;
  task.assignee = null;
}

// by：user（用户在看板上宣布 leader 下线 / 恢复）或 auto（检测到 leader 掉线、leader 回来）
export function setLeaderAway(on, by = 'auto') {
  if (!!state.noLeader === !!on) return state.noLeader ?? null;
  if (on) {
    state.noLeader = { since: now(), by };
    const why = by === 'user' ? '用户宣布 leader 下线' : `leader 超过 ${config().leaderAwayMin} 分钟没有监听、也没有操作（掉线了，可能 token 用完）`;
    emit('no_leader', { text: `${why}，进入无 leader 模式：等答复、待 review 的卡先放下，worker 转做没有依赖的卡` });
  } else {
    delete state.noLeader;
    const asking = state.tasks.filter((t) => t.status === 'asking').map((t) => t.id);
    const submitted = state.tasks.filter((t) => t.status === 'submitted').map((t) => t.id);
    const backlog = [asking.length ? `待答复 ${asking.join('、')}` : '', submitted.length ? `待 review ${submitted.join('、')}` : ''].filter(Boolean).join('；');
    emit('leader_back', { text: `${by === 'user' ? '用户恢复了 leader' : 'leader 回来了'}，退出无 leader 模式。${backlog ? `积压：${backlog}。先答复，再 review（ateam status 看全部）` : '没有积压。'}` });
  }
  changed();
  return state.noLeader ?? null;
}

// 改设置。值为 null 表示恢复默认
// 待领取、依赖已满足、没暂停，但没有同角色在线 worker 的卡，按角色分组（看板「需要 worker」同一口径）
export function staffingNeeds() {
  const approved = new Set(state.tasks.filter((t) => t.status === 'approved').map((t) => t.id));
  const onlineRoles = new Set(state.agents.filter((a) => a.status === 'online').map((a) => a.role.trim().toLowerCase()));
  const heldJobs = new Set(state.jobs.filter((j) => j.onHold).map((j) => j.id));
  const byRole = new Map();
  for (const t of state.tasks) {
    if (t.status !== 'pending' || t.onHold || heldJobs.has(t.jobId) || !t.dependsOn.every((d) => approved.has(d))) continue;
    if (onlineRoles.has(t.role.trim().toLowerCase())) continue;
    if (!byRole.has(t.role)) byRole.set(t.role, []);
    byRole.get(t.role).push(t.id);
  }
  const online = state.agents.filter((a) => a.status === 'online').length;
  const max = config().maxWorkers;
  return {
    needs: [...byRole].map(([role, tasks]) => ({ role, tasks })), leaderSpawn: config().leaderSpawn, platform: config().spawnPlatform,
    online, maxWorkers: max, full: max > 0 && online >= max,
  };
}

// 缺人提醒 leader：某个角色持续缺人 1 分钟（和看板的浏览器通知一样，刚开的 worker 正在加入、掉线马上重连的不提醒）
// 发一次 staffing_needed 事件；这个角色不缺了再缺，会再提醒。只记在内存里，服务重启后还缺的会再提醒一次
const STAFFING_SETTLE_MS = 60 * 1000;
const staffingSince = new Map(); // 角色（小写）-> 第一次发现缺人的时间
const staffingTold = new Set();
export function checkStaffing() {
  const { needs, leaderSpawn, full, online, maxWorkers } = staffingNeeds();
  const key = (role) => role.trim().toLowerCase();
  const roles = new Set(needs.map((n) => key(n.role)));
  for (const k of [...staffingSince.keys()]) {
    if (!roles.has(k)) { staffingSince.delete(k); staffingTold.delete(k); }
  }
  let dirty = false;
  for (const n of needs) {
    const k = key(n.role);
    if (!staffingSince.has(k)) staffingSince.set(k, now());
    if (staffingTold.has(k) || now() - staffingSince.get(k) < STAFFING_SETTLE_MS) continue;
    staffingTold.add(k);
    emit('staffing_needed', { role: n.role, tasks: n.tasks, leaderSpawn, full, online, maxWorkers, text: `${n.role} 角色有能领的卡（${n.tasks.join('、')}），但没有在线 worker` });
    dirty = true;
  }
  if (dirty) changed();
}

// 空闲：在线、手上没有任务、本角色也没有待领取的任务（包括还在等依赖的）。
// 空闲超过 idleMs 的 worker 向 leader 申请下线，省得空等浪费 token；每段空闲只申请一次。
// last：它是本角色最后一个在线 worker，下线需要 leader 和用户都同意。
// leaderAway：leader 没连着（不在监听、近几分钟也没操作）。这时申请下线没人批，空闲的 worker 直接下线
export function checkIdle({ leaderAway = false } = {}) {
  let dirty = false;
  // 暂停领取的卡（单张或整个需求）、依赖还没全部通过的卡现在都领不了，不算这个角色还有活。
  // 依赖通过后又缺人时，leader 会收到 staffing_needed 再开
  const heldJobs = new Set(state.jobs.filter((j) => j.onHold).map((j) => j.id));
  const approved = new Set(state.tasks.filter((t) => t.status === 'approved').map((t) => t.id));
  for (const agent of state.agents) {
    if (agent.status !== 'online') continue;
    // 审卡 worker 只有用户要求才下线，空闲也不申请
    if (isCritic(agent)) {
      if (agent.idleSince || agent.leaveAsked) {
        delete agent.idleSince;
        delete agent.leaveAsked;
        dirty = true;
      }
      continue;
    }
    const busy = isCritic(agent)
      ? critiqueQueue().length > 0
      : agent.currentTask || state.tasks.some((t) => t.status === 'pending' && !t.onHold && !heldJobs.has(t.jobId)
        && t.dependsOn.every((d) => approved.has(d)) && sameRole(t.role, agent.role));
    if (busy) {
      if (agent.idleSince || agent.leaveAsked) {
        delete agent.idleSince;
        delete agent.leaveAsked;
        dirty = true;
      }
      continue;
    }
    if (!agent.idleSince) {
      agent.idleSince = now();
      dirty = true;
    } else if (!agent.leaveAsked && now() - agent.idleSince >= config().idleMin * 60000) {
      agent.leaveAsked = true;
      // 「最后一个」只在设置要求保留时才算数，关了就和普通申请一样，leader 自己决定
      const last = config().keepOnePerRole && onlineOfRole(agent.role).length === 1;
      const who = agent.name ? `${agent.name}（${agent.id}）` : agent.id;
      const min = Math.round((now() - agent.idleSince) / 60000);
      const blocked = state.tasks.filter((t) => t.status === 'pending' && !t.onHold && !heldJobs.has(t.jobId) && sameRole(t.role, agent.role)).map((t) => t.id);
      // 不是最后一个、也没有在等依赖的卡、没有正在拆卡的需求：这个角色近期没活，直接下线，不用叫 leader。
      // 之后又有这个角色的卡时，缺人会触发 staffing_needed 再开
      const planning = state.jobs.some((j) => !j.demo && j.status === 'planning');
      if (!last && !blocked.length && !planning && !agent.dismiss) {
        agent.dismiss = true;
        emit('worker_auto_leave', { agentId: agent.id, text: `${who} 空闲 ${min} 分钟，${agent.role} 角色没有待做的卡，已自动下线` });
        dirty = true;
        continue;
      }
      emit('leave_request', {
        agentId: agent.id, role: agent.role, last,
        text: `${who} 已空闲 ${min} 分钟，${agent.role} 角色没有能领的任务${blocked.length ? `（${blocked.join('、')} 还在等依赖）` : ''}，申请下线${last ? `（它是 ${agent.role} 角色最后一个在线 worker）` : ''}`,
        blocked,
      });
      dirty = true;
    }
    // 没人批：leader 不在时直接安排下线（要求保留每个角色最后一个时，最后一个不动）。
    // 只打标记，worker 挂着的 wait 马上收到「已下线」，见 nextFor
    if (agent.leaveAsked && leaderAway && !agent.dismiss && !(config().keepOnePerRole && onlineOfRole(agent.role).length === 1)) {
      agent.dismiss = true;
      emit('worker_auto_leave', { agentId: agent.id, text: `${agent.id} 空闲超过 ${config().idleMin} 分钟，leader 不在，已自动下线` });
      dirty = true;
    }
  }
  if (dirty) changed();
}

