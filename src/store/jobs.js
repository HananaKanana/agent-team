// 需求和卡的管理：建、改、挂起、置顶、指派、作废、验收、汇报

import { AteamError } from '../errors.js';
import { changed, now, state } from './core.js';
import { addHistory, checkDeps, cleanList, emit, findAgent, getJob, getTask, requireText } from './common.js';
import { sameRole } from './dispatch.js';
import { releaseAgentOf } from './review.js';
import { closeRun, editDemo, isDemo } from './demo.js';

// origin：可选，用户提需求时的原话，存了就不能改，审卡时一起对照
// demo：演播需求，里面只放演播卡（见「演播卡」一节）
export function createJob({ title, description = '', origin = '', demo = false } = {}) {
  title = requireText(title, '需求标题');
  origin = String(origin ?? '').trim();
  state.seq.job += 1;
  const ts = now();
  const job = {
    id: `J${state.seq.job}`, title, description: description ?? '', origin,
    status: 'planning', report: null, createdAt: ts, updatedAt: ts,
  };
  if (demo) job.demo = true;
  state.jobs.push(job);
  changed();
  return job;
}

// 修改需求的标题或说明，任何状态都可以改（只是文字，不影响派发）
// 已作废的需求：不能再加卡、改、汇报、验收
export function liveJob(jobId) {
  const job = getJob(jobId);
  if (job.status === 'cancelled') throw new AteamError('BAD_STATE', `需求 ${job.id} 已作废，不能再修改、加卡、汇报或验收。`);
  return job;
}

export function editJob(jobId, patch = {}) {
  const job = liveJob(jobId);
  let touched = false;
  if (patch.title !== undefined) { job.title = requireText(patch.title, '需求标题'); touched = true; }
  if (patch.description !== undefined) { job.description = String(patch.description ?? ''); touched = true; }
  // 原话只能补（老需求没有原话时），不能改
  if (patch.origin !== undefined) {
    if (job.origin) throw new AteamError('BAD_STATE', `需求 ${job.id} 的用户原话已经存了，不能改。用户补充的话写进需求说明（--desc-file）。`);
    job.origin = requireText(patch.origin, '用户原话');
    touched = true;
  }
  if (!touched) throw new AteamError('INVALID', '没有要修改的内容。请提供 --title 或 --desc-file。');
  job.updatedAt = now();
  changed();
  return job;
}

export function addTask({ jobId, title, role, paths, description = '', acceptance = [], dependsOn = [], top = false } = {}) {
  const job = liveJob(jobId);
  if (job.demo) throw new AteamError('INVALID', `需求 ${job.id} 是演播需求，里面只能放演播卡。请用 ateam demo add --job ${job.id} ...`);
  title = requireText(title, '任务标题');
  role = requireText(role, '角色（--role）');
  paths = cleanList(paths, '路径（--paths）');
  if (paths.length === 0) throw new AteamError('INVALID', '路径（--paths）不能为空。请用 --paths 指定允许改动的目录或文件，多个用逗号分隔。');
  acceptance = cleanList(acceptance, '验收标准');
  dependsOn = cleanList(dependsOn, '依赖（--after）');
  checkDeps(dependsOn, null);

  state.seq.task += 1;
  const task = {
    id: `T${state.seq.task}`, jobId: job.id, title, role, paths,
    description: description ?? '', acceptance, dependsOn,
    status: 'pending', assignee: null, handoff: false, rejectCount: 0,
    commits: [], pendingDelivery: null, history: [],
  };
  addHistory(task, 'created', 'lead', title);
  if (top) task.priority = Math.max(0, ...state.tasks.map((t) => t.priority ?? 0)) + 1;
  state.tasks.push(task);
  job.status = 'active';
  job.updatedAt = now();
  changed();
  return task;
}

export function editTask(taskId, patch = {}) {
  const task = getTask(taskId);
  if (isDemo(task)) return editDemo(task, patch);
  // 已经有人拿着的卡（进行中、等答复、待 review）：也能改，卡片保持最新；改了什么自动作为补充说明发给拿着它的 worker。
  // 角色和依赖这时改没有意义（已经派出去了），不让改
  const held = ['working', 'asking', 'submitted'].includes(task.status);
  if (!held && task.status !== 'pending' && task.status !== 'held') {
    throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，已经结束，不能修改。需要补做就加新任务。`);
  }
  if (held && (patch.role !== undefined || patch.dependsOn !== undefined)) {
    throw new AteamError('BAD_STATE', `任务 ${task.id} 已经派给 ${task.assignee ?? 'worker'}（${task.status}），不能再改角色和依赖。只改标题、描述、验收标准、路径。`);
  }
  const changes = [];
  if (patch.title !== undefined) { task.title = requireText(patch.title, '任务标题'); changes.push('标题'); }
  if (patch.role !== undefined) {
    const role = requireText(patch.role, '角色（--role）');
    if (role !== task.role) { changes.push(`角色（${task.role} → ${role}）`); task.role = role; }
  }
  if (patch.description !== undefined) { task.description = String(patch.description ?? ''); changes.push('描述'); }
  if (patch.acceptance !== undefined) { task.acceptance = cleanList(patch.acceptance, '验收标准'); changes.push('验收标准'); }
  if (patch.paths !== undefined) {
    const paths = cleanList(patch.paths, '路径（--paths）');
    if (paths.length === 0) throw new AteamError('INVALID', '路径（--paths）不能为空。');
    task.paths = paths;
    changes.push('路径');
  }
  if (patch.dependsOn !== undefined) {
    const deps = cleanList(patch.dependsOn, '依赖（--after）');
    checkDeps(deps, task.id);
    task.dependsOn = deps;
    changes.push('依赖');
  }
  if (changes.length === 0) throw new AteamError('INVALID', '没有要修改的内容。请至少提供 --title、--role、--desc-file、--accept、--paths、--after 中的一项。');
  if (held) {
    const parts = [`leader 修改了这张卡的${changes.join('、')}，**以卡片最新内容为准**（和你之前看到的不一致时按下面的来）：`];
    if (patch.title !== undefined) parts.push(`标题：${task.title}`);
    if (patch.paths !== undefined) parts.push(`允许改动的路径：${task.paths.join('、')}`);
    if (patch.acceptance !== undefined) parts.push(`验收标准：\n${task.acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n')}`);
    if (patch.description !== undefined) parts.push(`描述：\n${task.description || '（无）'}`);
    const line = parts.join('\n\n');
    task.pendingNote = task.pendingNote ? `${task.pendingNote}\n\n${line}` : line;
  }
  addHistory(task, 'edited', 'lead', `修改了${changes.join('、')}${held ? '（已通知拿着它的 worker）' : ''}`);
  task.rev = (task.rev ?? 0) + 1; // 卡改过了，审卡 worker 会再审一次
  changed();
  return task;
}

// 用户在看板上把任务指派给某个 worker（agentId 为空表示取消指派）。只有它能领这个任务，而且它优先领。
// 只能指派给同角色、在线的 worker；只对还没开始的任务（待领取、已挂起）有意义。
export function assignTask(taskId, agentId) {
  const task = getTask(taskId);
  if (isDemo(task) ? task.status !== 'ready' : task.status !== 'pending' && task.status !== 'held') {
    throw new AteamError('BAD_STATE', isDemo(task)
      ? `演播卡 ${task.id} 当前状态是 ${task.status}，只有待演播时可以指派。`
      : `任务 ${task.id} 当前状态是 ${task.status}，只有待领取或已挂起的任务可以指派。`);
  }
  agentId = String(agentId ?? '').trim();
  if (!agentId) {
    if (!task.assignTo) return task;
    addHistory(task, 'edited', 'user', `取消指派（原来指派给 ${task.assignTo}）`);
    delete task.assignTo;
    changed();
    return task;
  }
  const agent = findAgent(agentId);
  if (!agent || agent.status !== 'online') throw new AteamError('BAD_STATE', `worker ${agentId} 不在线，不能指派给它。`);
  if (!sameRole(agent.role, task.role)) {
    throw new AteamError('INVALID', `${agentId} 的角色是 ${agent.role}，任务 ${task.id} 的角色是 ${task.role}，不能指派。`);
  }
  task.assignTo = agent.id;
  addHistory(task, 'edited', 'user', `指派给 ${agent.id}：只有它能领，它优先领`);
  changed();
  return task;
}
// worker 正式离开（下线）后，指派给它的任务恢复成谁都能领
export function releaseAssignments(agentId, why) {
  for (const t of state.tasks) {
    if (t.assignTo !== agentId) continue;
    delete t.assignTo;
    if (t.status === 'pending' || t.status === 'held') addHistory(t, 'edited', 'system', `${agentId} ${why}，取消指派，谁都能领`);
  }
}
// 设为优先 / 取消优先。只对还没开始的任务（待领取、已挂起）有意义。
// 优先只影响同角色 worker 领任务的先后，不会越过依赖。
// 暂停领取：卡照样留在待领取，但不派发给 worker，恢复后照常派发。正在做的卡不受影响。
// 可以单张卡暂停（task.onHold），也可以整个需求暂停（job.onHold，之后新加的卡也不派发）
const BY_LABEL = { user: '用户', lead: 'leader' };
export function holdTask(taskId, on, reason = '', by = 'lead') {
  const task = getTask(taskId);
  if (on) {
    if (isDemo(task) || (task.status !== 'pending' && task.status !== 'held')) {
      throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，只有待领取或已挂起的卡可以暂停领取（正在做的卡不受影响）。`);
    }
    if (task.onHold) return task;
    reason = String(reason ?? '').trim();
    task.onHold = { at: now(), by, ...(reason ? { reason } : {}) };
    addHistory(task, 'edited', by, `暂停领取${reason ? `：${reason}` : ''}`);
    emit('task_hold', { taskId: task.id, on: true, by, text: `${BY_LABEL[by] ?? by}暂停了 ${task.id} 的领取${reason ? `：${reason}` : ''}` });
  } else {
    if (!task.onHold) return task;
    delete task.onHold;
    addHistory(task, 'edited', by, '恢复领取');
    emit('task_hold', { taskId: task.id, on: false, by, text: `${BY_LABEL[by] ?? by}恢复了 ${task.id} 的领取` });
  }
  changed();
  return task;
}
export function holdJob(jobId, on, reason = '', by = 'lead') {
  const job = liveJob(jobId);
  if (job.status === 'accepted') throw new AteamError('BAD_STATE', `需求 ${job.id} 已验收，不需要暂停领取。`);
  if (on) {
    if (job.onHold) return job;
    reason = String(reason ?? '').trim();
    job.onHold = { at: now(), by, ...(reason ? { reason } : {}) };
    emit('job_hold', { jobId: job.id, text: `${BY_LABEL[by] ?? by}暂停了需求 ${job.id} 的领取${reason ? `：${reason}` : ''}` });
  } else {
    if (!job.onHold) return job;
    delete job.onHold;
    emit('job_hold', { jobId: job.id, text: `${BY_LABEL[by] ?? by}恢复了需求 ${job.id} 的领取` });
  }
  job.updatedAt = now();
  changed();
  return job;
}
export const onHold = (t) => !!(t.onHold || state.jobs.find((j) => j.id === t.jobId)?.onHold);
export function setPriority(taskId, top) {
  const task = getTask(taskId);
  if (task.status !== 'pending' && task.status !== 'held') {
    throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，只有待领取或已挂起的任务可以调整优先级。`);
  }
  const before = task.priority ?? 0;
  if (top) {
    task.priority = Math.max(0, ...state.tasks.map((t) => t.priority ?? 0)) + 1;
    addHistory(task, 'edited', 'lead', '设为优先：同角色的 worker 先领它');
  } else {
    if (!before) return task;
    delete task.priority;
    addHistory(task, 'edited', 'lead', '取消优先');
  }
  changed();
  return task;
}
// 作废：任务不再派发、不计入进度和汇报；已通过的任务不能作废
export function cancel(taskId, reason = '') {
  const task = getTask(taskId);
  if (task.status === 'approved' || task.status === 'cancelled') {
    throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，不能作废。`);
  }
  const dependents = state.tasks.filter((t) => t.status !== 'cancelled' && t.dependsOn.includes(task.id));
  if (dependents.length > 0) {
    const ids = dependents.map((t) => t.id).join('、');
    throw new AteamError('BAD_STATE', `任务 ${ids} 依赖 ${task.id}，不能直接作废。请先把它们也作废（ateam cancel），或用 ateam task edit <编号> --after ... 去掉这个依赖。`);
  }
  cancelOne(task, reason);
  changed();
  return task;
}
// 作废一张卡的主体（不做状态和依赖检查）：拿着它的 worker 记作废通知，演播中的卡记为叫停
function cancelOne(task, reason) {
  const agent = task.assignee && findAgent(task.assignee);
  if (isDemo(task) && task.status === 'demoing') closeRun(task, 'stopped', '演播卡被作废');
  task.cancelledWhileHeld = !!(agent && agent.currentTask === task.id);
  // worker 正拿着这个任务：记一条作废通知。它下一次调用任何 ateam 命令（wait、progress、submit……）
  // 都会先收到这条通知，停手并还原改动，不会不知情地去领下一个任务
  if (task.cancelledWhileHeld) {
    agent.cancelNotice = { taskId: task.id, wasWorking: ['working', 'asking', 'demoing', 'wrapping'].includes(task.status) };
  }
  releaseAgentOf(task);
  task.status = 'cancelled';
  delete task.parked;
  delete task.parkedFor;
  delete task.returnTo;
  delete task.backFromPark;
  task.handoff = false;
  task.pendingDelivery = null;
  task.cancelReason = String(reason ?? '').trim();
  addHistory(task, 'cancelled', 'lead', task.cancelReason || '作废');
}
// 作废整个需求：没做完的卡全部作废，已通过的卡和代码不动。必须用户同意（userApproved）
export function cancelJob(jobId, reason = '', userApproved = false) {
  const job = getJob(jobId);
  if (job.status === 'accepted' || job.status === 'cancelled') {
    throw new AteamError('BAD_STATE', `需求 ${job.id} 当前状态是 ${job.status === 'accepted' ? '已验收' : '已作废'}，不能作废。`);
  }
  reason = String(reason ?? '').trim();
  const targets = state.tasks.filter((t) => t.jobId === job.id && t.status !== 'approved' && t.status !== 'cancelled');
  const ids = new Set(targets.map((t) => t.id));
  const outside = state.tasks.filter((t) => t.jobId !== job.id && t.status !== 'cancelled' && t.dependsOn.some((d) => ids.has(d)));
  if (outside.length) {
    throw new AteamError('BAD_STATE', `别的需求里的任务 ${outside.map((t) => `${t.id}（需求 ${t.jobId}，依赖 ${t.dependsOn.filter((d) => ids.has(d)).join('、')}）`).join('、')} 依赖这个需求里没做完的卡。请先处理那边的依赖（ateam task edit <编号> --after ...，或作废那些卡），再作废需求 ${job.id}。`);
  }
  if (!userApproved) {
    const list = targets.length ? targets.map((t) => `- ${t.id} ${t.title}（${t.status}）`).join('\n') : '没有未完成的卡，只会把需求标为已作废。';
    throw new AteamError('NEEDS_USER', `作废整个需求必须用户明确同意。作废需求 ${job.id}「${job.title}」会连带作废这些没做完的卡（已通过的卡和代码保留）：\n${list}\n请把这些列给用户，用户明确同意作废整个需求后加 --user-approved 重新运行。`);
  }
  for (const t of targets) cancelOne(t, reason ? `需求作废：${reason}` : '需求作废');
  job.status = 'cancelled';
  job.cancelledAt = now();
  job.cancelReason = reason;
  job.updatedAt = job.cancelledAt;
  emit('job_cancelled', { jobId: job.id, text: `需求 ${job.id} ${job.title} 已作废${reason ? `：${reason}` : ''}，连带作废 ${targets.length} 张卡` });
  changed();
  return { job, cancelled: targets };
}
export function report(jobId, markdown) {
  markdown = requireText(markdown, '汇报内容');
  const job = liveJob(jobId);
  if (job.demo) throw new AteamError('BAD_STATE', `需求 ${job.id} 是演播需求，没有汇报和验收。`);
  const tasks = state.tasks.filter((t) => t.jobId === job.id && t.status !== 'cancelled');
  if (tasks.length === 0) {
    throw new AteamError('BAD_STATE', `需求 ${job.id} 还没有任何有效任务（已作废的不算），不能提交汇报。`);
  }
  const unfinished = tasks.filter((t) => t.status !== 'approved');
  if (unfinished.length > 0) {
    throw new AteamError('BAD_STATE', `需求 ${job.id} 还有未通过的任务：${unfinished.map((t) => `${t.id}（${t.status}）`).join('、')}。全部通过后才能提交汇报。`);
  }
  job.report = markdown;
  job.status = 'awaiting_acceptance';
  job.updatedAt = now();
  changed();
  return job;
}
// 用户验收通过：只有「待用户验收」的需求可以。之后还要改，就在这个需求下加任务，它会回到进行中。
export function acceptJobs(ids) {
  const list = Array.isArray(ids) ? ids : [];
  if (list.length === 0) throw new AteamError('INVALID', '请指定要验收通过的需求编号，例如 J1。');
  const jobs = list.map((id) => liveJob(id));
  for (const job of jobs) {
    if (job.status !== 'awaiting_acceptance') {
      throw new AteamError('BAD_STATE', `需求 ${job.id} 当前状态是 ${job.status}，只有待用户验收的需求可以验收通过。`);
    }
  }
  for (const job of jobs) {
    job.status = 'accepted';
    job.acceptedAt = now();
    job.updatedAt = job.acceptedAt;
    emit('job_accepted', { jobId: job.id, text: `用户已验收通过 ${job.id} ${job.title}` });
  }
  changed();
  return jobs;
}
