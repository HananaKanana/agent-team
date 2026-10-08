// 纯逻辑状态机：需求、任务、worker、事件。不碰网络和磁盘，时钟可注入。
import { AteamError } from './errors.js';

const KEEP_DELIVERED_EVENTS = 200;

export function emptyState() {
  return { seq: { job: 0, task: 0, event: 0 }, jobs: [], tasks: [], agents: [], events: [] };
}

export function createStore({ state, now = Date.now, leaseMs = 15 * 60 * 1000, onChange = () => {} } = {}) {
  state = state ?? emptyState();
  const changed = () => onChange();

  // ---------- 内部辅助 ----------

  function addHistory(task, type, actor, text = '', commit) {
    const entry = { ts: now(), type, actor, text };
    if (commit) entry.commit = commit;
    task.history.push(entry);
  }

  function emit(type, fields = {}) {
    state.seq.event += 1;
    state.events.push({ id: state.seq.event, ts: now(), type, text: '', ...fields, delivered: false });
  }

  function requireText(value, what) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new AteamError('INVALID', `${what}不能为空。请补上${what}后重试。`);
    }
    return value.trim();
  }

  function cleanList(list, what) {
    if (list == null) return [];
    if (!Array.isArray(list)) throw new AteamError('INVALID', `${what}必须是列表。`);
    return list.map((s) => String(s).trim()).filter(Boolean);
  }

  function getJob(id) {
    const job = state.jobs.find((j) => j.id === id);
    if (!job) throw new AteamError('NOT_FOUND', `找不到需求 ${id}。请运行 ateam status 查看现有需求。`);
    return job;
  }

  function getTask(id) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) throw new AteamError('NOT_FOUND', `找不到任务 ${id}。请运行 ateam status 查看现有任务。`);
    return task;
  }

  function findAgent(id) {
    return state.agents.find((a) => a.id === id);
  }

  function checkDeps(dependsOn, selfId) {
    for (const dep of dependsOn) {
      if (dep === selfId) throw new AteamError('INVALID', `任务 ${selfId} 不能依赖自己。请修改 --after。`);
      if (getTask(dep).status === 'cancelled') throw new AteamError('INVALID', `任务 ${dep} 已作废，不能依赖它。请修改 --after。`);
    }
  }

  // 编号 = 角色 + 序号，比如 frontend-1、frontend-2。序号按角色递增、永不复用：
  // 掉线后重新加入会拿到新序号，时间线里的编号始终指同一个窗口。
  function roleSlug(role) {
    return role.trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'worker';
  }

  function newAgentId(role) {
    const slug = roleSlug(role);
    state.seq.agents ??= {};
    let n = state.seq.agents[slug] ?? 0;
    for (const a of state.agents) {
      const m = a.id.match(/^(.*)-(\d+)$/);
      if (m && m[1] === slug) n = Math.max(n, Number(m[2]));
    }
    n += 1;
    state.seq.agents[slug] = n;
    return `${slug}-${n}`;
  }

  // ---------- 需求与任务 ----------

  function createJob({ title, description = '' } = {}) {
    title = requireText(title, '需求标题');
    state.seq.job += 1;
    const ts = now();
    const job = {
      id: `J${state.seq.job}`, title, description: description ?? '',
      status: 'planning', report: null, createdAt: ts, updatedAt: ts,
    };
    state.jobs.push(job);
    changed();
    return job;
  }

  // 修改需求的标题或说明，任何状态都可以改（只是文字，不影响派发）
  function editJob(jobId, patch = {}) {
    const job = getJob(jobId);
    let touched = false;
    if (patch.title !== undefined) { job.title = requireText(patch.title, '需求标题'); touched = true; }
    if (patch.description !== undefined) { job.description = String(patch.description ?? ''); touched = true; }
    if (!touched) throw new AteamError('INVALID', '没有要修改的内容。请提供 --title 或 --desc-file。');
    job.updatedAt = now();
    changed();
    return job;
  }

  function addTask({ jobId, title, role, paths, description = '', acceptance = [], dependsOn = [] } = {}) {
    const job = getJob(jobId);
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
    state.tasks.push(task);
    job.status = 'active';
    job.updatedAt = now();
    changed();
    return task;
  }

  function editTask(taskId, patch = {}) {
    const task = getTask(taskId);
    if (task.status !== 'pending' && task.status !== 'held') {
      throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，只有 pending 或 held 的任务可以修改。`);
    }
    const changes = [];
    if (patch.title !== undefined) { task.title = requireText(patch.title, '任务标题'); changes.push('标题'); }
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
    if (changes.length === 0) throw new AteamError('INVALID', '没有要修改的内容。请至少提供 --title、--desc-file、--accept、--paths、--after 中的一项。');
    addHistory(task, 'edited', 'lead', `修改了${changes.join('、')}`);
    changed();
    return task;
  }

  // ---------- worker ----------

  // name：用户给窗口起的好记名字（比如「账号A」），只用于显示；编号 id 仍然唯一
  function join(role, name = '') {
    role = requireText(role, '角色（--role）');
    name = String(name ?? '').trim().slice(0, 40);
    const ts = now();
    const agent = { id: newAgentId(role), role, status: 'online', currentTask: null, joinedAt: ts, lastSeenAt: ts };
    if (name) agent.name = name;
    state.agents.push(agent);
    const who = name ? `${name}（${agent.id}）` : agent.id;
    emit('worker_joined', { agentId: agent.id, text: `${who}，角色 ${role}，加入` });
    changed();
    return agent;
  }

  function touch(agentId) {
    const agent = findAgent(agentId);
    if (agent?.dismissed) {
      throw new AteamError('DISMISSED', '你已被 leader 安排下线，工作结束。请停止：不要再调用 ateam 命令，也不要重新 join。用一两句话告诉用户你已下线即可。');
    }
    if (!agent || agent.status !== 'online') {
      const role = agent?.role ?? '<角色>';
      throw new AteamError('LEASE_LOST', `你的租约已失效，任务已被收回。请重新运行 ateam join --role ${role}`);
    }
    agent.lastSeenAt = now();
    changed();
    return agent;
  }

  // ---------- 派发 ----------

  function depsMet(task) {
    return task.dependsOn.every((id) => state.tasks.find((t) => t.id === id)?.status === 'approved');
  }

  function sameRole(a, b) {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  // spec §4.1：返回 { kind, task, delivery? } 或 null（asking 中、或没有可派发的任务）
  function nextFor(agentId) {
    const agent = touch(agentId);

    // 已安排下线、手上没有任务 → 正式下线（手上有任务的，等任务通过、作废或收回后再下线）
    if (agent.dismiss && !agent.currentTask) {
      finishDismiss(agent);
      return { kind: 'dismissed' };
    }

    if (agent.currentTask) {
      const task = getTask(agent.currentTask);
      if (task.status !== 'working') return null; // asking / submitted：等答复或 review 结果
      // 规则 1：待送达的打回意见或答复
      if (task.pendingDelivery) {
        const delivery = task.pendingDelivery;
        task.pendingDelivery = null;
        changed();
        return { kind: delivery.kind, task, delivery };
      }
      // 规则 2：重复调用 wait，重新返回当前任务
      return { kind: 'resume', task };
    }

    // 规则 3：领取新任务，handoff 优先，再按编号
    const candidates = state.tasks
      .filter((t) => t.status === 'pending' && sameRole(t.role, agent.role) && depsMet(t))
      .sort((a, b) => (b.handoff - a.handoff) || (Number(a.id.slice(1)) - Number(b.id.slice(1))));
    const task = candidates[0];
    if (!task) return null;

    const isHandoff = task.handoff;
    task.status = 'working';
    task.assignee = agent.id;
    task.handoff = false;
    agent.currentTask = task.id;
    const delivery = task.pendingDelivery ?? undefined;
    task.pendingDelivery = null;
    addHistory(task, 'claimed', agent.id, isHandoff ? '接手任务（上一位 worker 掉线）' : '领取任务');
    emit('claimed', {
      taskId: task.id, agentId: agent.id,
      text: isHandoff ? `${agent.id} 接手了 ${task.id}（上一位 worker 掉线）` : `${agent.id} 领取了 ${task.id}`,
    });
    changed();
    return { kind: isHandoff ? 'handoff' : 'task', task, delivery };
  }

  function finishDismiss(agent) {
    agent.status = 'offline';
    agent.dismissed = true;
    agent.hidden = true; // 正常下线，不出现在「已掉线」里
    delete agent.dismiss;
    emit('worker_offline', { agentId: agent.id, text: `${agent.id} 已按安排下线` });
    changed();
  }

  // 安排 worker 下线：ids 指定编号，或 role 指定整个角色，或 all 表示全部在线 worker。
  // 空闲的 worker 下次 wait 时收到「已下线」；手上有任务的做完这个任务再下线，期间不再领新任务。
  function dismiss({ ids = [], role = '', all = false } = {}) {
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
    const result = [];
    for (const agent of picked) {
      agent.dismiss = true;
      result.push({ id: agent.id, holding: agent.currentTask });
    }
    if (result.length > 0) changed();
    return result;
  }

  // 「暂无任务」时告诉 worker 在等什么：本角色还有哪些任务在等依赖、等的是谁
  function waitingInfo(agentId) {
    const agent = findAgent(agentId);
    if (!agent) return null;
    if (agent.currentTask) {
      const task = state.tasks.find((t) => t.id === agent.currentTask);
      return task ? { holding: { id: task.id, status: task.status }, dismissing: !!agent.dismiss } : null;
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
    return { blocked };
  }

  // worker 当前持有的任务，且必须处于 working
  function workingTaskOf(agentId) {
    const agent = touch(agentId);
    if (!agent.currentTask) {
      const cancelled = state.tasks.find((t) => t.assignee === agent.id && t.status === 'cancelled' && t.cancelledWhileHeld);
      if (cancelled) {
        throw new AteamError('BAD_STATE', `你手上的任务 ${cancelled.id} 已被 leader 作废${cancelled.cancelReason ? `（${cancelled.cancelReason}）` : ''}。停止这个任务，不要提交。请运行 ateam wait --as ${agent.id} 领取下一个任务。`);
      }
      throw new AteamError('BAD_STATE', `你当前没有进行中的任务。请运行 ateam wait --as ${agent.id} 领取任务。`);
    }
    const task = getTask(agent.currentTask);
    if (task.status === 'asking') {
      throw new AteamError('BAD_STATE', `任务 ${task.id} 正在等待 leader 答复。请运行 ateam wait --as ${agent.id} 等待答复。`);
    }
    if (task.status !== 'working') {
      throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，不能执行此操作。请运行 ateam wait --as ${agent.id} 等待下一步。`);
    }
    return { agent, task };
  }

  function progress(agentId, text) {
    text = requireText(text, '进度笔记');
    const { agent, task } = workingTaskOf(agentId);
    addHistory(task, 'progress', agent.id, text);
    changed();
    return task;
  }

  function ask(agentId, text) {
    text = requireText(text, '问题');
    const { agent, task } = workingTaskOf(agentId);
    task.status = 'asking';
    addHistory(task, 'asked', agent.id, text);
    emit('question', { taskId: task.id, agentId: agent.id, text });
    changed();
    return task;
  }

  function taskForSubmit(agentId) {
    return workingTaskOf(agentId).task;
  }

  function recordSubmit(agentId, summary, commit) {
    summary = requireText(summary, '提交总结');
    const { agent, task } = workingTaskOf(agentId);
    if (commit) task.commits.push(commit);
    task.status = 'submitted';
    addHistory(task, 'submitted', agent.id, summary, commit);
    emit('submitted', {
      taskId: task.id, agentId: agent.id,
      text: commit ? `${task.id} 已提交 ${commit}：${summary}` : `${task.id} 已提交（无代码改动）：${summary}`,
    });
    changed();
    return task;
  }

  // ---------- review ----------

  function releaseAgentOf(task) {
    const agent = task.assignee && findAgent(task.assignee);
    if (agent && agent.currentTask === task.id) agent.currentTask = null;
  }

  function approve(taskId, note = '') {
    const task = getTask(taskId);
    if (task.status !== 'submitted' && task.status !== 'held') {
      throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，只有 submitted 或 held 的任务可以通过。`);
    }
    task.status = 'approved';
    task.handoff = false;
    task.pendingDelivery = null;
    releaseAgentOf(task);
    addHistory(task, 'approved', 'lead', note ?? '');
    changed();
    return task;
  }

  function reject(taskId, text) {
    text = requireText(text, '修改意见');
    const task = getTask(taskId);
    if (task.status !== 'submitted') {
      throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，只有 submitted 的任务可以打回。`);
    }
    task.rejectCount += 1;
    addHistory(task, 'rejected', 'lead', text);

    if (task.rejectCount >= 3) {
      task.status = 'held';
      releaseAgentOf(task);
      emit('task_held', { taskId: task.id, text: `${task.id} 已被打回 ${task.rejectCount} 次，转为挂起，等你处理（task edit + release，或自己修改后 approve）` });
    } else {
      const agent = findAgent(task.assignee);
      task.pendingDelivery = { kind: 'rejected', text };
      if (agent && agent.status === 'online' && agent.currentTask === task.id) {
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

  function answer(taskId, text) {
    text = requireText(text, '答复');
    const task = getTask(taskId);
    if (task.status === 'asking') {
      task.status = 'working';
    } else if (!(task.status === 'pending' && task.handoff)) {
      throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，没有待回答的提问。`);
    }
    task.pendingDelivery = { kind: 'answer', text };
    addHistory(task, 'answered', 'lead', text);
    changed();
    return task;
  }

  function release(taskId) {
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

  // 作废：任务不再派发、不计入进度和汇报；已通过的任务不能作废
  function cancel(taskId, reason = '') {
    const task = getTask(taskId);
    if (task.status === 'approved' || task.status === 'cancelled') {
      throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，不能作废。`);
    }
    const dependents = state.tasks.filter((t) => t.status !== 'cancelled' && t.dependsOn.includes(task.id));
    if (dependents.length > 0) {
      const ids = dependents.map((t) => t.id).join('、');
      throw new AteamError('BAD_STATE', `任务 ${ids} 依赖 ${task.id}，不能直接作废。请先把它们也作废（ateam cancel），或用 ateam task edit <编号> --after ... 去掉这个依赖。`);
    }
    const agent = task.assignee && findAgent(task.assignee);
    task.cancelledWhileHeld = !!(agent && agent.currentTask === task.id);
    releaseAgentOf(task);
    task.status = 'cancelled';
    task.handoff = false;
    task.pendingDelivery = null;
    task.cancelReason = String(reason ?? '').trim();
    addHistory(task, 'cancelled', 'lead', task.cancelReason || '作废');
    changed();
    return task;
  }

  function report(jobId, markdown) {
    markdown = requireText(markdown, '汇报内容');
    const job = getJob(jobId);
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

  // ---------- 租约 ----------

  // leader（或用户在看板上）确认原窗口没了，立即收回任务交给别人接手，不必等租约过期。
  // 同时把原 worker 标记为掉线：原窗口万一又活过来，会收到「租约已失效」并重新加入，不会和接手的人抢同一个任务。
  function reclaim(taskId, reason = '') {
    const task = getTask(taskId);
    if (task.status !== 'working' && task.status !== 'asking') {
      throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，只有进行中或等待答复的任务可以收回。`);
    }
    const agent = task.assignee && findAgent(task.assignee);
    const who = agent?.id ?? task.assignee ?? '原 worker';
    if (agent) {
      agent.status = 'offline';
      agent.currentTask = null;
    }
    task.status = 'pending';
    task.handoff = true;
    task.assignee = null;
    reason = String(reason ?? '').trim();
    addHistory(task, 'handoff', 'lead', `收回 ${who} 手上的任务，等待接手${reason ? `：${reason}` : ''}`);
    emit('worker_offline', { agentId: agent?.id, taskId: task.id, text: `${who} 的任务 ${task.id} 已被收回，等待接手` });
    changed();
    return { task, agentId: agent?.id ?? null };
  }

  // 从看板和 status 里移除掉线的 worker。记录保留（标记 hidden），历史里的编号和名字照常显示。
  function hideAgents(ids) {
    const want = new Set(Array.isArray(ids) ? ids : []);
    let count = 0;
    for (const agent of state.agents) {
      if (!want.has(agent.id) || agent.status === 'online' || agent.hidden) continue;
      agent.hidden = true;
      count += 1;
    }
    if (count > 0) changed();
    return count;
  }

  function sweep(isWaiting) {
    let count = 0;
    for (const agent of state.agents) {
      if (agent.status !== 'online') continue;
      if (now() - agent.lastSeenAt <= leaseMs || isWaiting(agent.id)) continue;
      agent.status = 'offline';
      count += 1;
      let reclaimed = null;
      if (agent.currentTask) {
        const task = state.tasks.find((t) => t.id === agent.currentTask);
        if (task && (task.status === 'working' || task.status === 'asking')) {
          task.status = 'pending';
          task.handoff = true;
          task.assignee = null;
          addHistory(task, 'handoff', 'system', `${agent.id} 掉线，任务退回待领取`);
          reclaimed = task.id;
        }
        agent.currentTask = null;
      }
      if (agent.dismiss) {
        agent.dismissed = true;
        agent.hidden = true;
        delete agent.dismiss;
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
  function noteActivity(agentId, ts) {
    const agent = findAgent(agentId);
    if (!agent || agent.status !== 'online' || !(ts > agent.lastSeenAt)) return false;
    agent.lastSeenAt = Math.min(ts, now());
    changed();
    return true;
  }

  // ---------- 查询 ----------

  function pendingActions() {
    return state.tasks.filter((t) => t.status === 'submitted' || t.status === 'asking' || t.status === 'held');
  }

  function takeEvents() {
    const fresh = state.events.filter((e) => !e.delivered);
    if (fresh.length === 0) return [];
    for (const e of fresh) e.delivered = true;
    const delivered = state.events.filter((e) => e.delivered);
    if (delivered.length > KEEP_DELIVERED_EVENTS) {
      const drop = new Set(delivered.slice(0, delivered.length - KEEP_DELIVERED_EVENTS));
      state.events = state.events.filter((e) => !drop.has(e));
    }
    changed();
    return fresh;
  }

  return {
    get state() { return state; },
    leaseMs,
    createJob, editJob, addTask, editTask,
    join, touch,
    nextFor, waitingInfo, progress, ask, taskForSubmit, recordSubmit,
    approve, reject, answer, release, cancel, reclaim, hideAgents, dismiss, report, sweep, noteActivity,
    getJob, getTask, pendingActions, takeEvents,
  };
}
