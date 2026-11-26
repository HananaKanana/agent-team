// worker：加入、心跳、保持等待、下线、保留、隐藏

import { AteamError } from '../errors.js';
import { changed, now, state } from './core.js';
import { config } from './settings.js';
import { addHistory, emit, findAgent, newAgentId, requireText, retireAgent, reusable, roleSlug } from './common.js';
import { releaseAssignments } from './jobs.js';
import { sameRole } from './dispatch.js';
import { critiqueQueue, isCritic } from './critique.js';

// name：用户给窗口起的好记名字（比如「账号A」），只用于显示；编号 id 仍然唯一
// wantId：想用的编号（看板给的提示词里预先写好，让 agent 窗口的标题和编号对得上）。
// - 编号没人用、格式是「本角色-序号」：直接用它。
// - 是本角色一个已掉线的旧编号（同一个窗口掉线后重连）：沿用它，窗口标题不用变。
// - 旧编号已经空出来（见 reusable：不在线、24 小时没有调用）：旧记录归档，这个号给新窗口。
// - 其它情况（正在线上、刚下线不到 24 小时、角色不符、格式不对）：照常分配新编号，加入结果里会说明。
function claimId(role, wantId) {
  wantId = String(wantId ?? '').trim();
  if (!wantId) return { id: newAgentId(role) };
  const slug = roleSlug(role);
  const m = wantId.match(/^(.*)-(\d+)$/);
  if (!m || m[1] !== slug) return { id: newAgentId(role), refused: `编号 ${wantId} 和角色 ${role} 对不上` };
  const old = findAgent(wantId);
  if (!old) return { id: wantId };
  if (old.status === 'offline' && !old.dismissed && sameRole(old.role, role)) return { id: wantId, revive: old };
  if (reusable(old)) { retireAgent(old); return { id: wantId }; }
  const why = old.status === 'online' ? '正被另一个在线的 worker 使用' : '已经下线，不能再用';
  return { id: newAgentId(role), refused: `编号 ${wantId} ${why}` };
}

export function join(role, name = '', wantId = '') {
  role = requireText(role, '角色（--role）');
  if (['lead', 'leader'].includes(role.toLowerCase())) throw new AteamError('INVALID', `${role} 是 leader 专用的名字（项目规则里 ## leader 段只给 leader），worker 请用别的角色名。`);
  name = String(name ?? '').trim().slice(0, 40);
  const ts = now();
  const { id, revive, refused } = claimId(role, wantId);
  if (revive) {
    revive.status = 'online';
    revive.currentTask = null;
    revive.lastSeenAt = ts;
    revive.joinedAt = ts; // 编号可能让给了新会话：换新会话按加入以后的调用算上下文
    delete revive.rotate;
    delete revive.hidden;
    delete revive.idleSince;
    delete revive.leaveAsked;
    delete revive.hookStop;
    delete revive.tabOpened;
    if (name) revive.name = name;
    const who = revive.name ? `${revive.name}（${revive.id}）` : revive.id;
    emit('worker_joined', { agentId: revive.id, text: `${who}，角色 ${role}，重新加入` });
    changed();
    return { ...revive, rejoined: true };
  }
  const agent = { id, role, status: 'online', currentTask: null, joinedAt: ts, lastSeenAt: ts };
  if (name) agent.name = name;
  state.agents.push(agent);
  const who = name ? `${name}（${agent.id}）` : agent.id;
  emit('worker_joined', { agentId: agent.id, text: `${who}，角色 ${role}，加入` });
  changed();
  return refused ? { ...agent, refused } : agent;
}

export function touch(agentId) {
  const agent = findAgent(agentId);
  // 记下每一次调用（包括下面被拒绝的），24 小时内调用过的号不让给新 worker
  if (agent) { agent.lastCallAt = now(); changed(); }
  if (agent?.dismissed) {
    throw new AteamError('DISMISSED', '你已被 leader 安排下线，工作结束。请停止：不要再调用 ateam 命令，也不要重新 join。用一两句话告诉用户你已下线即可。');
  }
  if (!agent || agent.status !== 'online') {
    const role = agent?.role ?? '<角色>';
    const keep = agent ? ` --id ${agent.id}` : '';
    // 原来手上的任务已经被别人接手：明确告诉它别再改，免得两个人同时改同一批文件
    const taken = agent && state.tasks.find((t) => t.prevAssignee === agent.id && t.assignee && t.assignee !== agent.id
      && ['working', 'asking', 'submitted'].includes(t.status));
    const lost = taken
      ? `你被判定掉线，手上的任务 ${taken.id} 已交给 ${taken.assignee} 接手。**不要再改 ${taken.id} 的文件**（${taken.paths.join('、')}），也不要提交它。`
      : '你的租约已失效（被判定掉线）。';
    throw new AteamError('LEASE_LOST', `${lost}请重新运行 ateam join --role ${role}${keep}（沿用原编号）；如果你掉线前的任务还没人接手，会还给你。`);
  }
  agent.lastSeenAt = now();
  clearStale(agent);
  changed();
  return agent;
}

// 用户确认「窗口还在」：再给它一个租约周期，期间不再提醒
export function keepWaiting(agentId) {
  const agent = findAgent(agentId);
  if (!agent || agent.status !== 'online') throw new AteamError('NOT_FOUND', `worker ${agentId} 不在线。`);
  agent.lastSeenAt = now();
  if (agent.stale) {
    delete agent.stale;
    emit('worker_back', { agentId: agent.id, taskId: agent.currentTask ?? undefined, text: `用户确认 ${agent.id} 的窗口还在，继续等它` });
  }
  changed();
  return agent;
}

export function takeCancelNotice(agent) {
  const { taskId, wasWorking, sentByHook } = agent.cancelNotice;
  delete agent.cancelNotice;
  changed();
  return { task: state.tasks.find((t) => t.id === taskId), wasWorking, sentByHook: !!sentByHook };
}

// 经 hook 叫停的文字：下线、收回都是卡退回待领取、交给别人接着做，所以不还原改动
export function stopMessage(stop, agent) {
  const task = state.tasks.find((t) => t.id === stop.taskId);
  const files = task?.paths?.length ? `（${task.paths.join('、')}）` : '';
  if (stop.demo) {
    return `你手上的演播 ${stop.taskId} 已被收回。**立刻停手，不要再操作浏览器，也不要清理数据。** 然后运行 ateam join --role ${agent.role} --id ${agent.id} 重新加入。`;
  }
  const lines = stop.kind === 'dismissed'
    ? [`你已被安排下线，手上的任务 ${stop.taskId} 已退回待领取，会交给别的 worker 接着做。`]
    : [`你手上的任务 ${stop.taskId} 已被收回，会交给别的 worker 接着做。`];
  lines.push(`**立刻停手：不要再改 ${stop.taskId} 的文件${files}，不要提交，也不要还原已做的改动**（接手的 worker 会在这些改动上继续）。`);
  lines.push(stop.kind === 'dismissed'
    ? '工作结束：不要再调用 ateam 命令，也不要重新 join。用一两句话告诉用户你已下线即可。'
    : `然后运行 ateam join --role ${agent.role} --id ${agent.id} 重新加入（沿用原编号）。`);
  return lines.join('\n');
}

// 作废通知的文字：命令报错和 wait 输出共用
// seen：工具调用后已经经 hook 看过完整通知，这次只确认一句，不再重复「停手、还原」
export function cancelMessage(task, wasWorking, agentId, seen = false) {
  if (!task) return `你手上的任务已被作废。请运行 ateam wait --as ${agentId} 领取下一个任务。`;
  const why = task.cancelReason ? `（原因：${task.cancelReason}）` : '';
  if (seen && wasWorking) {
    return `已确认 ${task.id} 作废${why}。你在工具调用后已收到过停手通知；还没还原完自己为它做的改动的，先还原完。然后运行 ateam wait --as ${agentId} 领取下一个任务。`;
  }
  if (!wasWorking) {
    return `你提交的任务 ${task.id} 已被 leader 作废${why}，不用再等它的 review。请运行 ateam wait --as ${agentId} 领取下一个任务。`;
  }
  return [
    `你手上的任务 ${task.id} 已被 leader 作废${why}。立即停手，不要提交。`,
    '把你为这个任务做的改动还原掉，**只动你自己改过的文件**（同一目录里可能有别的 worker 正在改的文件，不要碰）：',
    '- 你改过的已有文件：逐个 git checkout -- <文件路径>',
    '- 你新建的文件：逐个删掉',
    '不要用 git clean、git stash，也不要对整个目录 git checkout。没有改动就跳过这一步。',
    `然后运行 ateam wait --as ${agentId} 领取下一个任务。`,
  ].join('\n');
}

// 「可能停了」的 worker 又有了动静：恢复正常
export function clearStale(agent) {
  if (!agent.stale) return;
  delete agent.stale;
  emit('worker_back', { agentId: agent.id, taskId: agent.currentTask ?? undefined, text: `${agent.id} 又有动静了，恢复正常` });
}

export function finishDismiss(agent) {
  releaseAssignments(agent.id, '已下线');
  agent.status = 'offline';
  agent.dismissed = true;
  agent.hidden = true; // 正常下线，不出现在「已掉线」里
  delete agent.dismiss;
  emit('worker_offline', { agentId: agent.id, text: `${agent.id} 已按安排下线` });
  changed();
}
export function onlineOfRole(role) {
  // 已安排「做完再下线」的不算：它迟早要走
  return state.agents.filter((a) => a.status === 'online' && !a.dismiss && sameRole(a.role, role));
}
// 让 worker 立即下线：ids 指定编号，或 role 指定整个角色，或 all 表示全部在线 worker。
// 手上进行中（或等答复）的任务退回待领取、标记接手，已有改动保留；已提交待 review 的任务原样留着，
// 之后被打回就按「原 worker 已离开」交给别人接手。正挂在 wait 上的 worker 由 server 立即通知。
// afterTask：手上有任务的 worker 不立即走，做完这个任务（通过或作废）后再下线，期间不领新任务；空闲的照样立即下线。
// 每个角色至少留一个在线 worker：会让某个角色一个不剩时，必须带 userApproved（用户同意）。
export function dismiss({ ids = [], role = '', all = false, userApproved = false, afterTask = false } = {}) {
  const wantIds = new Set(Array.isArray(ids) ? ids : []);
  role = String(role ?? '').trim();
  if (!all && !role && wantIds.size === 0) {
    throw new AteamError('INVALID', '请指定要下线的 worker：编号（可以多个）、--role <角色> 或 --all。');
  }
  for (const id of wantIds) {
    const agent = findAgent(id);
    if (!agent) throw new AteamError('NOT_FOUND', `找不到 worker ${id}。请运行 ateam status 查看在线的 worker。`);
  }
  const picked = state.agents.filter((a) => a.status === 'online'
    && (all || wantIds.has(a.id) || (role && sameRole(a.role, role))));
  if (!userApproved) {
    // 审卡 worker 只有用户要求才下线
    const critics = picked.filter(isCritic);
    if (critics.length) {
      throw new AteamError('NEEDS_USER', `${critics.map((a) => a.id).join('、')} 是审卡 worker，只有用户要求才能下线。用户要求了的话，加 --user-approved 重新运行；只是想让其他 worker 下线，就别带上它（不要用 --all，改成指定编号或 --role）。`);
    }
    const emptied = [];
    for (const a of (config().keepOnePerRole ? picked : [])) {
      if (a.dismiss) continue; // 已经安排过下线（当时已过这道检查）
      if (emptied.some((r) => sameRole(r, a.role))) continue;
      if (onlineOfRole(a.role).every((x) => picked.includes(x))) emptied.push(a.role);
    }
    if (emptied.length > 0) {
      const detail = emptied.map((r) => `${r}（${onlineOfRole(r).map((a) => a.id).join('、')}）`).join('、');
      throw new AteamError('NEEDS_USER', `这样会让角色 ${detail}一个在线 worker 都不剩。每个角色至少要留一个 worker，最后一个下线必须先征得用户同意：请先问用户，用户同意后加 --user-approved 重新运行；只是想减少人数的话，改成只下线其中几个、留下一个。`);
    }
  }
  const result = [];
  for (const agent of picked) {
    let returned = null;
    const task = agent.currentTask && state.tasks.find((t) => t.id === agent.currentTask);
    // 审卡 worker：还有待审的卡就审完再下线
    if (afterTask && isCritic(agent) && critiqueQueue().length) {
      if (!agent.dismiss) {
        agent.dismiss = true;
        emit('worker_leaving', { agentId: agent.id, text: `${agent.id} 审完待审的卡后下线` });
      }
      result.push({ id: agent.id, later: '待审的卡' });
      continue;
    }
    if (afterTask && task) {
      if (!agent.dismiss) {
        agent.dismiss = true;
        emit('worker_leaving', { agentId: agent.id, taskId: task.id, text: `${agent.id} 做完 ${task.id} 后下线，不再领取新任务` });
      }
      result.push({ id: agent.id, later: task.id });
      continue;
    }
    if (task && (task.status === 'working' || task.status === 'asking')) {
      task.status = 'pending';
      task.handoff = true;
      task.assignee = null;
      addHistory(task, 'handoff', 'lead', `${agent.id} 被安排下线，任务退回待领取，等待接手`);
      returned = task.id;
      // 它可能还在干：经工具后 hook 叫它停手（见 noteForHook）
      agent.hookStop = { kind: 'dismissed', taskId: task.id };
    }
    agent.currentTask = null;
    finishDismiss(agent);
    result.push({ id: agent.id, returned, submitted: task && !returned ? task.id : null });
  }
  if (result.length > 0) changed();
  return result;
}
// 撤销「做完再下线」
export function keepAgents(ids) {
  const want = new Set(Array.isArray(ids) ? ids : []);
  let count = 0;
  for (const agent of state.agents) {
    if (!want.has(agent.id) || agent.status !== 'online' || !agent.dismiss) continue;
    delete agent.dismiss;
    count += 1;
  }
  if (count > 0) changed();
  return count;
}
// 从看板和 status 里移除掉线的 worker。记录保留（标记 hidden），历史里的编号和名字照常显示。
export function hideAgents(ids) {
  const want = new Set(Array.isArray(ids) ? ids : []);
  let count = 0;
  for (const agent of state.agents) {
    if (!want.has(agent.id) || agent.status === 'online' || agent.hidden) continue;
    agent.hidden = true;
    releaseAssignments(agent.id, '已移除');
    count += 1;
  }
  if (count > 0) changed();
  return count;
}
