// 纯逻辑状态机：需求、任务、工人、事件。不碰网络和磁盘，时钟可注入。
import { randomBytes } from 'node:crypto';
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
      getTask(dep);
    }
  }

  function newAgentId(role) {
    const prefix = role.replace(/\s+/g, '').slice(0, 2).toLowerCase() || 'wk';
    for (;;) {
      const id = `${prefix}-${randomBytes(2).toString('hex')}`;
      if (!findAgent(id)) return id;
    }
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

  // ---------- 工人 ----------

  function join(role) {
    role = requireText(role, '角色（--role）');
    const ts = now();
    const agent = { id: newAgentId(role), role, status: 'online', currentTask: null, joinedAt: ts, lastSeenAt: ts };
    state.agents.push(agent);
    emit('worker_joined', { agentId: agent.id, text: `${agent.id}（${role}）加入` });
    changed();
    return agent;
  }

  function touch(agentId) {
    const agent = findAgent(agentId);
    if (!agent || agent.status !== 'online') {
      const role = agent?.role ?? '<角色>';
      throw new AteamError('LEASE_LOST', `你的租约已失效，任务已被收回。请重新运行 ateam join --role ${role}`);
    }
    agent.lastSeenAt = now();
    changed();
    return agent;
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
    createJob, addTask, editTask,
    join, touch,
    getJob, getTask, pendingActions, takeEvents,
  };
}
