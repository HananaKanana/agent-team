// 演播卡：添加、开始、单步、暂停、结束、保存操作记录

import { stepsLabel } from '../demo.js';
import { AteamError } from '../errors.js';
import { changed, now, state } from './core.js';
import { config, setSettings } from './settings.js';
import { addHistory, emit, findAgent, getTask, requireText } from './common.js';
import { liveJob } from './jobs.js';
import { touch } from './workers.js';
import { sameRole } from './dispatch.js';
import { isCritic } from './critique.js';

// 演播卡（kind: 'demo'）只能放在演播需求（job.demo）里，脚本是仓库里的一个文件（task.script）。
// 状态：ready（待演播）→ queued（用户点了开始，等 worker 领）→ demoing（前台浏览器演播中）
// → wrapping（清理、写操作记录、提交）→ ready，可以无限次重复。每次演播记一条 task.runs。
// queued、以及没叫停的 demoing 期间全队冻结派发（见 nextFor）。读脚本、提交操作记录在 server 里。

const DEMO_UNCLAIMED_MS = 2 * 60 * 1000;
export const isDemo = (t) => t.kind === 'demo';
const lastRun = (task) => task.runs?.[task.runs.length - 1] ?? null;

export function addDemo({ jobId, title, script, role = 'test' } = {}) {
  const job = liveJob(jobId);
  if (!job.demo) throw new AteamError('INVALID', `需求 ${job.id} 不是演播需求，不能放演播卡。请先用 ateam job new "<标题>" --demo 建演播需求。`);
  title = requireText(title, '演播卡标题');
  script = requireText(script, '脚本路径（--script）');
  role = requireText(role || 'test', '角色（--role）');
  state.seq.task += 1;
  const task = {
    id: `T${state.seq.task}`, jobId: job.id, title, role, kind: 'demo', script, paths: [script],
    description: '', acceptance: [], dependsOn: [],
    status: 'ready', assignee: null, handoff: false, rejectCount: 0,
    commits: [], pendingDelivery: null, runs: [], history: [],
  };
  addHistory(task, 'created', 'lead', title);
  state.tasks.push(task);
  job.status = 'active';
  job.updatedAt = now();
  changed();
  return task;
}

export function editDemo(task, patch) {
  if (task.status !== 'ready') throw new AteamError('BAD_STATE', `演播卡 ${task.id} 当前状态是 ${task.status}，只有待演播时可以修改。`);
  const other = ['description', 'acceptance', 'paths', 'dependsOn'].filter((k) => patch[k] !== undefined);
  if (other.length) throw new AteamError('INVALID', '演播卡只能改标题和角色。演播内容写在脚本文件里，改脚本文件并提交即可。');
  const changes = [];
  if (patch.title !== undefined) { task.title = requireText(patch.title, '演播卡标题'); changes.push('标题'); }
  if (patch.role !== undefined) {
    const role = requireText(patch.role, '角色（--role）');
    if (role !== task.role) { changes.push(`角色（${task.role} → ${role}）`); task.role = role; }
  }
  if (changes.length === 0) throw new AteamError('INVALID', '没有要修改的内容。演播卡可以改 --title、--role。');
  addHistory(task, 'edited', 'lead', `修改了${changes.join('、')}`);
  changed();
  return task;
}

// 造成冻结的演播卡：等 worker 领的，或正在演播、没被叫停的
export function demoFrozen() {
  return state.tasks.find((t) => isDemo(t) && (t.status === 'queued' || (t.status === 'demoing' && !t.stopRequested))) ?? null;
}

// 开始演播的阻碍，空数组表示可以开始
export function demoBlockers(taskId) {
  const task = getTask(taskId);
  if (!isDemo(task)) throw new AteamError('INVALID', `任务 ${task.id} 不是演播卡。`);
  const out = [];
  const busy = state.tasks.filter((t) => !isDemo(t) && ['working', 'asking', 'submitted'].includes(t.status));
  if (busy.length) out.push(`${busy.map((t) => t.id).join('、')} 还在进行，完成后才能演播`);
  const other = state.tasks.find((t) => isDemo(t) && t.id !== task.id && ['queued', 'demoing', 'wrapping'].includes(t.status));
  if (other) out.push(`${other.id} 正在演播或收尾`);
  const free = state.agents.some((a) => a.status === 'online' && !a.currentTask && !a.dismiss && !isCritic(a)
    && sameRole(a.role, task.role) && (!task.assignTo || a.id === task.assignTo));
  if (!free) out.push(task.assignTo ? `指派的 ${task.assignTo} 不在线或手上有任务` : `没有空闲的 ${task.role} worker`);
  return out;
}

// mode：rehearsal 预演（慢，写操作记录）/ show 演播（按操作记录快速执行，要先预演过）
const DEMO_MODES = { rehearsal: '预演', show: '演播' };
const modeLabel = (run) => DEMO_MODES[run?.mode] ?? '演播';

// steps：演播只演这几步（步骤编号数组）；totalSteps：脚本总步数，由服务读脚本得出。预演不能选步骤
// viewport：预演这次用的视口（不传就用上次预演选的）；演播不能选，沿用这张卡预演时录的
export function startDemo(taskId, mode = 'show', steps = null, totalSteps = null, viewport = null) {
  const task = getTask(taskId);
  if (!isDemo(task)) throw new AteamError('INVALID', `任务 ${task.id} 不是演播卡。`);
  if (!DEMO_MODES[mode]) throw new AteamError('INVALID', '开始方式只能是 rehearsal（预演）或 show（演播）。');
  let picked = null;
  if (steps != null) {
    if (mode === 'rehearsal') throw new AteamError('INVALID', '预演要从头完整走，不能选步骤。');
    if (!Number.isInteger(totalSteps) || totalSteps < 1) throw new AteamError('INVALID', '读不到脚本的步数，不能选步骤。');
    if (!Array.isArray(steps) || steps.some((n) => !Number.isInteger(n) || n < 1 || n > totalSteps)) {
      throw new AteamError('INVALID', `步骤编号要在 1 到 ${totalSteps} 之间。`);
    }
    picked = [...new Set(steps)].sort((a, b) => a - b);
    if (!picked.length) throw new AteamError('INVALID', '至少选一步。');
    if (picked.length === totalSteps) picked = null; // 全选 = 完整演播
  }
  if (task.status !== 'ready') throw new AteamError('BAD_STATE', `演播卡 ${task.id} 当前状态是 ${task.status}，只有待演播时可以开始。`);
  if (mode === 'show' && !task.rehearsedAt) throw new AteamError('BAD_STATE', `演播卡 ${task.id} 还没预演过，请先开始预演。`);
  if (mode === 'show' && viewport != null) throw new AteamError('INVALID', '演播沿用这张卡预演时录的视口，不能另选；想换尺寸就重新预演。');
  const blockers = demoBlockers(task.id);
  if (blockers.length) throw new AteamError('BAD_STATE', `现在不能开始演播：${blockers.join('；')}。`);
  // 记成「上次预演选的」，下次弹框默认选它；同时校验格式
  if (mode === 'rehearsal' && viewport != null) setSettings({ demoViewport: viewport });
  if (mode === 'rehearsal') task.pendingViewport = config().demoViewport;
  else delete task.pendingViewport;
  task.status = 'queued';
  task.queuedAt = now();
  task.pendingMode = mode;
  if (picked) task.pendingSteps = picked;
  else delete task.pendingSteps;
  emit('demo_queued', { taskId: task.id, text: `用户开始${DEMO_MODES[mode]} ${task.id} ${task.title}，派发已暂停，等 ${task.role} worker 领取` });
  changed();
  return task;
}

export function claimDemo(agent, task) {
  task.status = 'demoing';
  task.assignee = agent.id;
  delete task.queuedAt;
  agent.currentTask = task.id;
  const mode = task.pendingMode ?? 'show';
  delete task.pendingMode;
  const run = { startedAt: now(), by: agent.id, mode };
  if (task.pendingSteps) run.steps = task.pendingSteps;
  delete task.pendingSteps;
  if (task.pendingViewport) run.viewport = task.pendingViewport;
  delete task.pendingViewport;
  task.runs.push(run);
  addHistory(task, 'claimed', agent.id, `开始${DEMO_MODES[mode]}${run.steps ? `（${stepsLabel(run.steps)}）` : ''}`);
  emit('demo_started', { taskId: task.id, agentId: agent.id, text: `${agent.id} 开始${DEMO_MODES[mode]} ${task.id}` });
  changed();
  return { kind: 'demo', task };
}

// 结束这一次演播的记录（跑完、叫停、中断）
export function closeRun(task, outcome, text = '') {
  const run = lastRun(task);
  if (!run || run.endedAt) return;
  run.outcome = outcome;
  run.endedAt = now();
  if (text) run.result = text;
  const label = `${modeLabel(run)}${{ done: '跑完', stopped: '被叫停', interrupted: '中断' }[outcome]}`;
  addHistory(task, 'demo_ended', run.by, text ? `${label}：${text}` : label);
}

function toWrapping(task) {
  task.status = 'wrapping';
  delete task.stopRequested;
  delete task.demoStep;
  delete task.paused;
}

// 演播中或收尾中 worker 不在了：卡直接回到待演播，这次不收尾
export function interruptDemo(task, why) {
  if (task.status === 'demoing') closeRun(task, 'interrupted', why);
  else addHistory(task, 'demo_ended', 'system', `收尾中断：${why}`);
  task.status = 'ready';
  task.assignee = null;
  delete task.stopRequested;
  delete task.demoStep;
  delete task.paused;
  emit('demo_interrupted', { taskId: task.id, text: `演播 ${task.id} 中断（${why}），已回到待演播` });
}

export function demoNext(task) {
  if (task.status === 'wrapping' && task.stopNotice) {
    delete task.stopNotice; delete task.stopSentByHook;
    changed();
    return { kind: 'demo_stopped', task };
  }
  // 老数据：叫停后还停在 demoing 的
  if (task.status === 'demoing' && task.stopRequested) {
    toWrapping(task);
    changed();
    return { kind: 'demo_stopped', task };
  }
  if (task.status === 'demoing') return { kind: 'demo', task };
  if (task.status === 'wrapping') return { kind: 'demo_wrap', task, outcome: lastRun(task)?.outcome ?? 'done', steps: lastRun(task)?.steps ?? null };
  return null;
}

export function stopDemo(taskId) {
  const task = getTask(taskId);
  if (!isDemo(task)) throw new AteamError('INVALID', `任务 ${task.id} 不是演播卡。`);
  if (task.status === 'queued') {
    task.status = 'ready';
    delete task.queuedAt;
    addHistory(task, 'edited', 'user', '撤回开始演播');
    emit('demo_stopped', { taskId: task.id, text: `用户撤回了演播 ${task.id}，派发恢复` });
  } else if (task.status === 'demoing' && !task.stopRequested) {
    // 叫停立刻生效：卡直接进收尾、派发恢复，不等 worker 回应。worker 下次调用时收到「已叫停」（stopNotice）
    closeRun(task, 'stopped', '用户叫停');
    toWrapping(task);
    task.stopNotice = true;
    emit('demo_stopped', { taskId: task.id, agentId: task.assignee, text: `用户叫停了演播 ${task.id}，派发恢复` });
  } else {
    throw new AteamError('BAD_STATE', `演播卡 ${task.id} 当前状态是 ${task.status}，不在演播中。`);
  }
  changed();
  return task;
}

// 暂停 / 继续：只在步与步之间生效。暂停后 worker 报到下一步时服务不放行（demoStep 返回 paused），
// 它原地等着、不碰浏览器；继续后放行，接着做这一步
export function pauseDemo(taskId) {
  const task = getTask(taskId);
  if (!isDemo(task) || task.status !== 'demoing' || task.stopRequested) throw new AteamError('BAD_STATE', `演播卡 ${task.id} 不在演播中，不能暂停。`);
  if (task.paused) return task;
  const after = task.demoStep?.n;
  task.paused = { at: now(), afterStep: after ?? null };
  addHistory(task, 'demo_paused', 'user', after ? `暂停（第 ${after} 步做完后停住）` : '暂停（第一步开始前停住）');
  changed();
  return task;
}

export function resumeDemo(taskId) {
  const task = getTask(taskId);
  if (!isDemo(task) || !task.paused) throw new AteamError('BAD_STATE', `演播卡 ${task.id} 没有暂停。`);
  const run = lastRun(task);
  if (run) run.pausedMs = (run.pausedMs ?? 0) + Math.max(0, now() - task.paused.at);
  delete task.paused;
  addHistory(task, 'demo_resumed', 'user', '继续');
  changed();
  return task;
}

function demoHeld(agentId) {
  const agent = touch(agentId);
  const task = agent.currentTask && state.tasks.find((t) => t.id === agent.currentTask);
  if ((!task || !isDemo(task)) && agent.demoReleased) {
    const id = agent.demoReleased;
    delete agent.demoReleased;
    changed();
    throw new AteamError('BAD_STATE', `用户已经结束了演播卡 ${id} 的这次运行（卡已回到待演播）。立刻停手，不要再操作浏览器，也不要提交；直接运行 ateam wait --as ${agent.id}。`);
  }
  if (!task || !isDemo(task)) throw new AteamError('BAD_STATE', `你手上没有演播卡。请运行 ateam wait --as ${agent.id}。`);
  return { agent, task };
}

// 报告当前步，顺带检查是否被叫停。返回 { task, stopped }
// cue：server 从脚本里取的提词 { narration, next }，看板显示给讲解的用户
// slow：这一步按操作记录没走通，切慢档自己摸索走通的
export function demoStep(agentId, n, total, text, cue = null, slow = false) {
  const { agent, task } = demoHeld(agentId);
  if (task.status === 'demoing' && task.stopRequested) {
    toWrapping(task);
    changed();
    return { task, stopped: true };
  }
  if (task.status !== 'demoing') {
    if (lastRun(task)?.outcome === 'stopped') {
      if (task.stopNotice) { delete task.stopNotice; delete task.stopSentByHook; changed(); }
      return { task, stopped: true };
    }
    throw new AteamError('BAD_STATE', `演播卡 ${task.id} 已经演播完，在收尾。请按收尾说明清理、写操作记录后运行 ateam demo save --as ${agent.id}。`);
  }
  n = Number(n);
  total = Number(total);
  if (!Number.isInteger(n) || !Number.isInteger(total) || n < 1 || total < 1 || n > total) {
    throw new AteamError('INVALID', '步数格式是「第几步/总步数」，比如 3/12。');
  }
  const run = lastRun(task);
  if (run?.steps && !run.steps.includes(n)) {
    throw new AteamError('INVALID', `这一场只演${stepsLabel(run.steps)}，第 ${n} 步不在其中，不要做。`);
  }
  if (task.paused) return { task, stopped: false, paused: true };
  if (run) run.lastStep = n;
  task.demoStep = { n, total, text: requireText(text, '这一步的说明'), ts: now() };
  if (cue) task.demoStep.cue = { narration: String(cue.narration ?? ''), next: String(cue.next ?? '') };
  if (slow) {
    task.demoStep.slow = true;
    if (run) {
      run.slowSteps ??= [];
      if (!run.slowSteps.includes(n)) run.slowSteps.push(n);
    }
  }
  changed();
  return { task, stopped: false };
}

// stuck：慢档也走不通，停在当前页面。这次记为中断，卡标「页面可能有变动」
export function demoEnd(agentId, result, stuck = false) {
  result = requireText(result, '演播结果');
  const { agent, task } = demoHeld(agentId);
  if (task.status === 'wrapping' && lastRun(task)?.outcome === 'stopped') {
    delete task.stopNotice; delete task.stopSentByHook;
    changed();
    throw new AteamError('BAD_STATE', `用户已经叫停了 ${task.id}。停在当前页面，不要清理；把已走通的操作写进脚本的「## 操作记录」段后运行 ateam demo save --as ${agent.id} "<记了哪些操作>"。`);
  }
  if (task.status !== 'demoing') throw new AteamError('BAD_STATE', `演播卡 ${task.id} 当前状态是 ${task.status}，不在演播中。`);
  if (task.stopRequested) {
    toWrapping(task);
    changed();
    throw new AteamError('BAD_STATE', `用户已经叫停了演播 ${task.id}。停在当前页面，不要清理；把这次的操作写进脚本的「## 操作记录」段后运行 ateam demo save --as ${agent.id} "<记了哪些操作>"。`);
  }
  const run = lastRun(task);
  if (stuck) {
    closeRun(task, 'interrupted', result);
    task.mayChange = true;
  } else {
    closeRun(task, 'done', result);
    if (run?.mode === 'rehearsal') {
      task.rehearsedAt = now();
      task.mayChange = false;
    }
  }
  toWrapping(task);
  emit('demo_ended', { taskId: task.id, agentId: agent.id, text: `${task.id} ${modeLabel(run)}${stuck ? '走不通，停住了' : '跑完'}：${result}` });
  changed();
  return task;
}

export function demoTaskForSave(agentId) {
  const { agent, task } = demoHeld(agentId);
  if (task.status !== 'wrapping') {
    throw new AteamError('BAD_STATE', `演播卡 ${task.id} 当前状态是 ${task.status}，演播结束后才能提交操作记录。跑完请先 ateam demo end --as ${agent.id} "<结果>"。`);
  }
  return task;
}

export function recordDemoSave(agentId, summary, commit) {
  summary = requireText(summary, '操作记录总结');
  const task = demoTaskForSave(agentId);
  const agent = findAgent(agentId);
  const list = [].concat(commit ?? []).filter(Boolean);
  task.commits.push(...list);
  const run = lastRun(task);
  if (run) {
    run.saved = true;
    run.summary = summary;
    run.commit = list.length ? list.join('、') : null;
  }
  task.status = 'ready';
  task.assignee = null;
  agent.currentTask = null;
  addHistory(task, 'demo_saved', agent.id, summary, list.length ? list.join('、') : undefined);
  emit('demo_saved', { taskId: task.id, agentId: agent.id, text: `${task.id} 演播收尾完成${list.length ? `，操作记录已提交 ${list.join('、')}` : '（操作记录没有改动）'}` });
  changed();
  return task;
}

// 预演开始时服务清空了操作记录（opsCleared）。跑完并提交 → 去掉标记；没跑完 → 服务从 git 还原后去掉标记
export function markOpsCleared(taskId, on) {
  const task = getTask(taskId);
  if (on) task.opsCleared = now();
  else delete task.opsCleared;
  changed();
  return task;
}

// 用户在看板上「结束收尾」：worker 迟迟不收尾（卡住、窗口没了）时，卡直接回到待演播，不等它。
// worker 下次调用演播命令时被告知停手（demoReleased）
export function releaseDemo(taskId) {
  const task = getTask(taskId);
  if (!isDemo(task)) throw new AteamError('INVALID', `任务 ${task.id} 不是演播卡。`);
  if (!(task.status === 'wrapping' || (task.status === 'demoing' && task.stopRequested))) {
    throw new AteamError('BAD_STATE', `演播卡 ${task.id} 当前状态是 ${task.status}，只有收尾中（或已叫停）的卡可以直接结束。正在运行的请先停止。`);
  }
  const agent = task.assignee && findAgent(task.assignee);
  if (agent && agent.currentTask === task.id) {
    agent.currentTask = null;
    agent.demoReleased = task.id;
  }
  task.status = 'ready';
  task.assignee = null;
  delete task.stopNotice; delete task.stopSentByHook;
  delete task.stopRequested;
  delete task.demoStep;
  addHistory(task, 'demo_ended', 'user', '用户结束收尾，卡回到待演播（这次的操作记录如果还没提交就不保存）');
  emit('demo_stopped', { taskId: task.id, agentId: agent?.id, text: `用户结束了 ${task.id} 的收尾，卡回到待演播` });
  changed();
  return task;
}

// 开始后 2 分钟没人领：撤回，解除冻结
export function expireDemoRequests() {
  let count = 0;
  for (const t of state.tasks) {
    if (!isDemo(t) || t.status !== 'queued' || now() - t.queuedAt <= DEMO_UNCLAIMED_MS) continue;
    t.status = 'ready';
    delete t.queuedAt;
    addHistory(t, 'edited', 'system', '2 分钟没有 worker 来领，已撤回开始演播');
    emit('demo_unclaimed', { taskId: t.id, text: `没有 worker 来领演播 ${t.id}，请确认 ${t.role} 窗口还在` });
    count += 1;
  }
  if (count) changed();
  return count;
}
