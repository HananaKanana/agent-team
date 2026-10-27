// 纯逻辑状态机：需求、任务、worker、事件。不碰网络和磁盘，时钟可注入。
import { AteamError } from './errors.js';
import { stepsLabel, VIEWPORT_RE } from './demo.js';

const KEEP_DELIVERED_EVENTS = 200;

export function emptyState() {
  return { seq: { job: 0, task: 0, event: 0 }, jobs: [], tasks: [], agents: [], events: [] };
}

// leaseMs：多久没动静算「可能停了」。手上有进行中任务的 worker 只标记、提醒用户，任务不动，
// 用户确认窗口没了（看板上点「换人接手」，或 leader 问过用户后 ateam reclaim）才转手；
// 空闲（手上没有进行中任务）的 worker 到时直接判掉线，没有任务要转手。
export function createStore({ state, now = Date.now, leaseMs = 15 * 60 * 1000, idleMs = 3 * 60 * 1000, onChange = () => {} } = {}) {
  // 启动参数（--lease / --idle）是默认值；用户在看板「设置」里改过的以设置为准
  const defaultLeaseMs = leaseMs;
  const defaultIdleMs = idleMs;
  state = state ?? emptyState();
  const changed = () => onChange();

  // ---------- 设置 ----------
  // 用户在看板「设置」页改的配置，存在 state.settings 里，重启不丢。没改过的用默认值。
  const SETTINGS = {
    criticAutoLeave: { type: 'bool', def: () => false },
    keepOnePerRole: { type: 'bool', def: () => true },
    leaseMin: { type: 'num', min: 1, max: 240, def: () => defaultLeaseMs / 60000 },
    idleMin: { type: 'num', min: 1, max: 240, def: () => defaultIdleMs / 60000 },
    rejectLimit: { type: 'int', min: 1, max: 10, def: () => 3 },
    // 无 leader 模式：autoNoLeader 关着时只有用户在看板上宣布 leader 下线才进入；开着时 leader 掉线（有事没处理、超过 leaderAwayMin 没操作）也自动进入
    autoNoLeader: { type: 'bool', def: () => false },
    leaderAwayMin: { type: 'int', min: 1, max: 120, def: () => 10 },
    // 演播视口：预演按它录，演播沿用这张卡预演时记下的尺寸
    demoViewport: { type: 'size', def: () => '1600x800' },
  };

  function config() {
    const out = {};
    for (const [key, spec] of Object.entries(SETTINGS)) out[key] = state.settings?.[key] ?? spec.def();
    return out;
  }

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

  // 编号 = 角色 + 序号，比如 frontend-1、frontend-2。新加入的 worker 拿本角色最小的空号：
  // 从没用过的号，或者用过它的 worker 已不在线、24 小时内没用这个号调过任何 ateam 命令（被拒绝的调用也算），
  // 手上也没有挂着的任务。点了下线但旧窗口还在调用的，号一直留着，新窗口拿别的号，不会两个窗口共用一个号。
  const REUSE_QUIET_MS = 24 * 60 * 60 * 1000;
  function roleSlug(role) {
    return role.trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'worker';
  }

  function reusable(agent) {
    if (agent.status === 'online') return false;
    const last = Math.max(agent.lastCallAt ?? 0, agent.lastSeenAt ?? 0, agent.joinedAt ?? 0);
    if (now() - last < REUSE_QUIET_MS) return false;
    return !state.tasks.some((t) => (t.assignee === agent.id && !['approved', 'cancelled', 'pending'].includes(t.status))
      || (t.assignTo === agent.id && t.status === 'pending'));
  }

  // 号让给新 worker：旧记录移到 retiredAgents（时间线里的旧记录照常显示这个编号）
  function retireAgent(agent) {
    state.agents.splice(state.agents.indexOf(agent), 1);
    (state.retiredAgents ??= []).push({ ...agent, retiredAt: now() });
  }

  function newAgentId(role) {
    const slug = roleSlug(role);
    for (let n = 1; ; n++) {
      const id = `${slug}-${n}`;
      const old = findAgent(id);
      if (!old) return id;
      if (reusable(old)) { retireAgent(old); return id; }
    }
  }

  // ---------- 路径重叠 ----------

  function normPath(p) {
    const s = String(p).trim().replace(/^\.\//, '').replace(/\/+$/, '');
    return s === '.' ? '' : s;
  }

  // 两组路径有没有交集：相同，或一个是另一个的上级目录（空串 = 整个项目）
  function pathsOverlap(a, b) {
    for (const x of a.map(normPath)) {
      for (const y of b.map(normPath)) {
        if (x === '' || y === '' || x === y || y.startsWith(`${x}/`) || x.startsWith(`${y}/`)) return true;
      }
    }
    return false;
  }

  // 沿依赖链往上找：ids 依赖的所有任务（含间接依赖）
  function ancestors(ids) {
    const seen = new Set();
    const stack = [...ids];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const t = state.tasks.find((x) => x.id === id);
      if (t) stack.push(...t.dependsOn);
    }
    return seen;
  }

  // 和 task 改同一批文件、又可能同时进行的任务：还没通过/作废，且两者之间没有依赖先后（直接或间接）。
  // 只用来提醒 leader，不拦着。
  function overlapsFor(task) {
    const before = ancestors(task.dependsOn);
    return state.tasks
      .filter((t) => t.id !== task.id && !isDemo(t) && !['approved', 'cancelled'].includes(t.status)
        && !before.has(t.id) && !ancestors(t.dependsOn).has(task.id)
        && pathsOverlap(task.paths, t.paths))
      .map((t) => ({ id: t.id, title: t.title, status: t.status, assignee: t.assignee, paths: t.paths }));
  }

  // ---------- 需求与任务 ----------

  // origin：可选，用户提需求时的原话，存了就不能改，审卡时一起对照
  // demo：演播需求，里面只放演播卡（见「演播卡」一节）
  function createJob({ title, description = '', origin = '', demo = false } = {}) {
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
  function liveJob(jobId) {
    const job = getJob(jobId);
    if (job.status === 'cancelled') throw new AteamError('BAD_STATE', `需求 ${job.id} 已作废，不能再修改、加卡、汇报或验收。`);
    return job;
  }

  function editJob(jobId, patch = {}) {
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

  function addTask({ jobId, title, role, paths, description = '', acceptance = [], dependsOn = [], top = false } = {}) {
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

  function editTask(taskId, patch = {}) {
    const task = getTask(taskId);
    if (isDemo(task)) return editDemo(task, patch);
    if (task.status !== 'pending' && task.status !== 'held') {
      throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，只有 pending 或 held 的任务可以修改。`);
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
    addHistory(task, 'edited', 'lead', `修改了${changes.join('、')}`);
    task.rev = (task.rev ?? 0) + 1; // 卡改过了，审卡 worker 会再审一次
    changed();
    return task;
  }

  // ---------- worker ----------

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

  function join(role, name = '', wantId = '') {
    role = requireText(role, '角色（--role）');
    name = String(name ?? '').trim().slice(0, 40);
    const ts = now();
    const { id, revive, refused } = claimId(role, wantId);
    if (revive) {
      revive.status = 'online';
      revive.currentTask = null;
      revive.lastSeenAt = ts;
      delete revive.hidden;
      delete revive.idleSince;
      delete revive.leaveAsked;
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

  function touch(agentId) {
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
  function keepWaiting(agentId) {
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

  function takeCancelNotice(agent) {
    const { taskId, wasWorking } = agent.cancelNotice;
    delete agent.cancelNotice;
    changed();
    return { task: state.tasks.find((t) => t.id === taskId), wasWorking };
  }

  // 作废通知的文字：命令报错和 wait 输出共用
  function cancelMessage(task, wasWorking, agentId) {
    if (!task) return `你手上的任务已被作废。请运行 ateam wait --as ${agentId} 领取下一个任务。`;
    const why = task.cancelReason ? `（原因：${task.cancelReason}）` : '';
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
  function clearStale(agent) {
    if (!agent.stale) return;
    delete agent.stale;
    emit('worker_back', { agentId: agent.id, taskId: agent.currentTask ?? undefined, text: `${agent.id} 又有动静了，恢复正常` });
  }

  // ---------- 派发 ----------

  function depsMet(task) {
    return task.dependsOn.every((id) => state.tasks.find((t) => t.id === id)?.status === 'approved');
  }

  function sameRole(a, b) {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  // 派发顺序：优先的任务最先（后被设为优先的排更前），再是接手任务（有半成品），最后按编号
  function dispatchOrder(a, b) {
    return ((b.priority ?? 0) - (a.priority ?? 0)) || (b.handoff - a.handoff) || (Number(a.id.slice(1)) - Number(b.id.slice(1)));
  }

  // 用户在看板上把任务指派给某个 worker（agentId 为空表示取消指派）。只有它能领这个任务，而且它优先领。
  // 只能指派给同角色、在线的 worker；只对还没开始的任务（待领取、已挂起）有意义。
  function assignTask(taskId, agentId) {
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
  function releaseAssignments(agentId, why) {
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
  function holdTask(taskId, on, reason = '', by = 'lead') {
    const task = getTask(taskId);
    if (on) {
      if (isDemo(task) || (task.status !== 'pending' && task.status !== 'held')) {
        throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，只有待领取或已挂起的卡可以暂停领取（正在做的卡不受影响）。`);
      }
      if (task.onHold) return task;
      reason = String(reason ?? '').trim();
      task.onHold = { at: now(), by, ...(reason ? { reason } : {}) };
      addHistory(task, 'edited', by, `暂停领取${reason ? `：${reason}` : ''}`);
    } else {
      if (!task.onHold) return task;
      delete task.onHold;
      addHistory(task, 'edited', by, '恢复领取');
    }
    changed();
    return task;
  }

  function holdJob(jobId, on, reason = '', by = 'lead') {
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

  const onHold = (t) => !!(t.onHold || state.jobs.find((j) => j.id === t.jobId)?.onHold);

  function setPriority(taskId, top) {
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

  // spec §4.1：返回 { kind, task, delivery? } 或 null（asking 中、或没有可派发的任务）
  function nextFor(agentId) {
    const agent = touch(agentId);

    // 手上的任务刚被作废：先告诉它，再谈领新任务
    if (agent.cancelNotice && !agent.currentTask) {
      const notice = takeCancelNotice(agent);
      return { kind: 'cancelled', task: notice.task, wasWorking: notice.wasWorking, text: cancelMessage(notice.task, notice.wasWorking, agent.id) };
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
      if (task.status !== 'working') {
        // asking / submitted：等答复或 review 结果。无 leader 模式下有别的卡能做，就把这张先放下，转做别的
        if (!(state.noLeader && candidatesFor(agent, task).length)) return null;
        park(agent, task);
      } else {
        // 规则 1：待送达的打回意见或答复
        if (task.pendingDelivery) {
          const delivery = task.pendingDelivery;
          task.pendingDelivery = null;
          changed();
          return { kind: delivery.kind, task, delivery };
        }
        // 规则 2：重复调用 wait，重新返回当前任务（有补充说明一起带上）
        const note = takeNote(task);
        return note ? { kind: 'resume', task, delivery: { kind: 'note', text: note } } : { kind: 'resume', task };
      }
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
  function clashWith(task, agentId = null) {
    if (isDemo(task)) return null;
    return state.tasks.find((o) => o !== task && !isDemo(o) && (o.status === 'working' || o.status === 'asking')
      && o.assignee && o.assignee !== agentId && pathsOverlap(o.paths, task.paths)) ?? null;
  }
  // 看板用：待领取、依赖已满足、但被别人正在改的卡挡住的卡 → 挡着它的卡
  function clashes() {
    const out = {};
    for (const t of state.tasks) {
      if (t.status !== 'pending' || !depsMet(t)) continue;
      const c = clashWith(t);
      if (c) out[t.id] = c.id;
    }
    return out;
  }

  // ---------- 无 leader 模式 ----------
  // leader（Claude Code）token 用完、不在线时，worker 不干等：等答复、待 review 的卡先放下（parked），
  // worker 先去做没有依赖、不撞文件的卡。leader 回来后答复或打回，卡退回待领取并留给原 worker（returnTo）；
  // 原 worker 不在线就照常换手。先放下的卡 status 不变（asking / submitted），assignee 仍是原 worker
  function park(agent, task) {
    task.parked = now();
    agent.currentTask = null;
    addHistory(task, 'parked', agent.id, task.status === 'asking' ? 'leader 不在线，提问先放下，转做别的卡' : 'leader 不在线，等 review 期间转做别的卡');
    changed();
  }

  // 先放下的卡被答复或打回：退回待领取，留给原 worker
  function unpark(task) {
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
  function setLeaderAway(on, by = 'auto') {
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

  function finishDismiss(agent) {
    releaseAssignments(agent.id, '已下线');
    agent.status = 'offline';
    agent.dismissed = true;
    agent.hidden = true; // 正常下线，不出现在「已掉线」里
    delete agent.dismiss;
    emit('worker_offline', { agentId: agent.id, text: `${agent.id} 已按安排下线` });
    changed();
  }

  function onlineOfRole(role) {
    // 已安排「做完再下线」的不算：它迟早要走
    return state.agents.filter((a) => a.status === 'online' && !a.dismiss && sameRole(a.role, role));
  }

  // 让 worker 立即下线：ids 指定编号，或 role 指定整个角色，或 all 表示全部在线 worker。
  // 手上进行中（或等答复）的任务退回待领取、标记接手，已有改动保留；已提交待 review 的任务原样留着，
  // 之后被打回就按「原 worker 已离开」交给别人接手。正挂在 wait 上的 worker 由 server 立即通知。
  // afterTask：手上有任务的 worker 不立即走，做完这个任务（通过或作废）后再下线，期间不领新任务；空闲的照样立即下线。
  // 每个角色至少留一个在线 worker：会让某个角色一个不剩时，必须带 userApproved（用户同意）。
  function dismiss({ ids = [], role = '', all = false, userApproved = false, afterTask = false } = {}) {
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
      }
      agent.currentTask = null;
      finishDismiss(agent);
      result.push({ id: agent.id, returned, submitted: task && !returned ? task.id : null });
    }
    if (result.length > 0) changed();
    return result;
  }

  // 改设置。值为 null 表示恢复默认
  function setSettings(patch = {}) {
    state.settings ??= {};
    for (const [key, value] of Object.entries(patch)) {
      const spec = SETTINGS[key];
      if (!spec) continue;
      if (value === null) { delete state.settings[key]; continue; }
      if (spec.type === 'bool') { state.settings[key] = !!value; continue; }
      if (spec.type === 'size') {
        const m = String(value).trim().toLowerCase().match(VIEWPORT_RE);
        if (!m || [m[1], m[2]].some((v) => Number(v) < 320 || Number(v) > 7680)) throw new AteamError('INVALID', `${key} 要写成 宽x高，比如 1600x800（宽高在 320 到 7680 之间）。`);
        state.settings[key] = `${Number(m[1])}x${Number(m[2])}`;
        continue;
      }
      const n = Number(value);
      if (!Number.isFinite(n) || n < spec.min || n > spec.max || (spec.type === 'int' && !Number.isInteger(n))) {
        throw new AteamError('INVALID', `${key} 必须是 ${spec.min} 到 ${spec.max} 之间的${spec.type === 'int' ? '整数' : '数'}。`);
      }
      state.settings[key] = n;
    }
    changed();
    return config();
  }

  // 撤销「做完再下线」
  function keepAgents(ids) {
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

  // 空闲：在线、手上没有任务、本角色也没有待领取的任务（包括还在等依赖的）。
  // 空闲超过 idleMs 的 worker 向 leader 申请下线，省得空等浪费 token；每段空闲只申请一次。
  // last：它是本角色最后一个在线 worker，下线需要 leader 和用户都同意。
  function checkIdle() {
    let dirty = false;
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
        : agent.currentTask || state.tasks.some((t) => t.status === 'pending' && sameRole(t.role, agent.role));
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
        const last = onlineOfRole(agent.role).length === 1;
        const who = agent.name ? `${agent.name}（${agent.id}）` : agent.id;
        const min = Math.round((now() - agent.idleSince) / 60000);
        emit('leave_request', {
          agentId: agent.id, role: agent.role, last,
          text: `${who} 已空闲 ${min} 分钟，${agent.role} 角色没有待领取的任务，申请下线${last ? `（它是 ${agent.role} 角色最后一个在线 worker）` : ''}`,
        });
        dirty = true;
      }
    }
    if (dirty) changed();
  }

  // 「暂无任务」时告诉 worker 在等什么：本角色还有哪些任务在等依赖、等的是谁
  function waitingInfo(agentId) {
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
      if (c) blocked.push({ id: t.id, title: t.title, clash: { id: c.id, assignee: c.assignee } });
    }
    const f = demoFrozen();
    return { blocked, leaveAsked: !!agent.leaveAsked, critic: isCritic(agent), frozen: f ? { taskId: f.id, title: f.title } : null };
  }

  // worker 当前持有的任务，且必须处于 working
  function workingTaskOf(agentId) {
    const agent = touch(agentId);
    if (!agent.currentTask) {
      if (agent.cancelNotice) {
        const notice = takeCancelNotice(agent);
        throw new AteamError('BAD_STATE', cancelMessage(notice.task, notice.wasWorking, agent.id));
      }
      throw new AteamError('BAD_STATE', `你当前没有进行中的任务。请运行 ateam wait --as ${agent.id} 领取任务。`);
    }
    const task = getTask(agent.currentTask);
    if (isDemo(task)) {
      throw new AteamError('BAD_STATE', task.status === 'wrapping'
        ? `演播卡 ${task.id} 在收尾：按收尾说明清理、写操作记录后用 ateam demo save --as ${agent.id} "<记了哪些操作>" 提交。`
        : `演播中不能提问、报进度或提交。遇到问题自己处理，处理不了就跳过这一步记下来；每步用 ateam demo step --as ${agent.id} <n>/<总数> "<说明>" 报告，跑完用 ateam demo end --as ${agent.id} "<结果>"。`);
    }
    if (task.status === 'asking') {
      throw new AteamError('BAD_STATE', `任务 ${task.id} 正在等待 leader 答复。请运行 ateam wait --as ${agent.id} 等待答复。`);
    }
    if (task.status !== 'working') {
      throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，不能执行此操作。请运行 ateam wait --as ${agent.id} 等待下一步。`);
    }
    return { agent, task };
  }

  // expectMin：接下来要跑一个很长的命令（导入数据、全量构建……），预计多少分钟不会调用 ateam。
  // 这段时间算作有动静，不提醒、不收回；最多 180 分钟。
  function progress(agentId, text, expectMin) {
    text = requireText(text, '进度笔记');
    const { agent, task } = workingTaskOf(agentId);
    const min = Number(expectMin);
    if (expectMin != null && expectMin !== '' && (!Number.isFinite(min) || min <= 0)) {
      throw new AteamError('INVALID', '--expect 必须是正数（分钟）。');
    }
    if (min > 0) {
      const capped = Math.min(min, 180);
      agent.busyUntil = now() + capped * 60 * 1000;
      addHistory(task, 'progress', agent.id, `${text}（预计 ${capped} 分钟不调用 ateam）`);
    } else {
      addHistory(task, 'progress', agent.id, text);
    }
    const note = takeNote(task);
    changed();
    return note ? { ...task, note } : task;
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
    const { task } = workingTaskOf(agentId);
    // leader 的补充说明还没看到：先给它看，按说明检查完再提交
    const note = takeNote(task);
    if (note) {
      throw new AteamError('BAD_STATE', `提交前先看对 ${task.id} 的补充说明（标着「用户直接说」的是用户本人说的）：\n\n${note}\n\n按说明检查、需要的话修改后，再运行 ateam submit。`);
    }
    return task;
  }

  // 提交了一部分、但路径里还有改动没进提交（submit 报错让 worker 重交）：已经提交的先记到卡上，免得丢
  function addCommits(agentId, commits) {
    const { agent, task } = workingTaskOf(agentId);
    task.commits.push(...commits);
    addHistory(task, 'progress', agent.id, `提交了 ${commits.join('、')}，但任务路径里还有改动没进提交，等重新提交`);
    changed();
    return task;
  }

  // commit：一个提交号、多个提交号（多仓库时每个仓库一个，如 api@a1b2c3d），或 null（无代码改动）
  function recordSubmit(agentId, summary, commit) {
    summary = requireText(summary, '提交总结');
    const { agent, task } = workingTaskOf(agentId);
    const list = [].concat(commit ?? []).filter(Boolean);
    task.commits.push(...list);
    commit = list.length ? list.join('、') : null;
    task.status = 'submitted';
    addHistory(task, 'submitted', agent.id, summary, commit);
    emit('submitted', {
      taskId: task.id, agentId: agent.id,
      text: commit ? `${task.id} 已提交 ${commit}：${summary}` : `${task.id} 已提交（无代码改动）：${summary}`,
    });
    changed();
    return task;
  }

  // ---------- 审卡 ----------
  // 审卡 worker（角色 critic）专门挑任务卡的毛病：描述含糊或矛盾、验收标准没法核对、路径不对、依赖错了……
  // 它在线就能看全部的卡（ateam cards），wait 拿到的是还没审过的卡；审过的标记一下就不再出现，
  // leader 改过（rev 变了）的卡会重新出现。发现新卡和旧卡冲突，可以重新审旧卡，历史里记下因为哪张卡。
  // 有问题就记一条意见（critique），leader 必须处理：改了就 done；不同意就 dispute，交给用户在看板上裁决。
  // 审卡不影响派发。

  const CRITIC_ROLE = 'critic';
  const isCritic = (agent) => sameRole(agent.role, CRITIC_ROLE);
  // 先审还没开工的（改起来最省事），再审进行中的，最后审已完成的
  const CRITIQUE_RANK = { pending: 0, held: 0, working: 1, asking: 1, submitted: 2, approved: 3 };

  // 能审的卡：没作废，所属需求还没验收
  function critiquable(t) {
    if (!(t.status in CRITIQUE_RANK)) return false;
    const st = state.jobs.find((j) => j.id === t.jobId)?.status;
    return st !== 'accepted' && st !== 'cancelled';
  }

  function reviewed(t) {
    return (t.critiquedRev ?? -1) === (t.rev ?? 0);
  }

  function critiqueQueue() {
    return state.tasks
      .filter((t) => critiquable(t) && !reviewed(t))
      .sort((a, b) => (CRITIQUE_RANK[a.status] - CRITIQUE_RANK[b.status]) || (Number(a.id.slice(1)) - Number(b.id.slice(1))));
  }

  function critiqueView(t) {
    return { ...t, reviewed: reviewed(t), edited: (t.rev ?? 0) > 0 && t.critiquedRev != null && !reviewed(t) };
  }

  // 全部能审的卡（审卡 worker 和 leader 都能看）。jobId 只看一个需求，todo 只看还没审的
  function cards({ jobId = '', todo = false } = {}) {
    return state.tasks
      .filter((t) => critiquable(t) && (!jobId || t.jobId === jobId) && (!todo || !reviewed(t)))
      .map(critiqueView);
  }

  // 审卡 worker 给出结论。ids：一张或多张卡；verdict：ok 没问题 / issue 有问题（text 写问题和修改建议）。
  // because：重新审已经审过的卡时必须写明原因（比如和哪张新卡冲突），历史里留痕。
  function submitCritique(agentId, ids, verdict, text = '', because = '', basis = '') {
    const agent = touch(agentId);
    if (!isCritic(agent)) throw new AteamError('BAD_STATE', '只有审卡角色（critic）的 worker 能提交审卡结论。');
    const list = (Array.isArray(ids) ? ids : [ids]).map((id) => String(id).trim()).filter(Boolean);
    if (!list.length) throw new AteamError('INVALID', '请写上要审的卡的编号，例如 T5（可以多个）。');
    if (verdict !== 'ok' && verdict !== 'issue') throw new AteamError('INVALID', '审卡结论只能是 ok 或 issue。');
    if (verdict === 'issue') {
      text = requireText(text, '审卡意见');
      basis = requireText(basis, '依据（--basis：用户原话的哪一句、设计文档哪一段、代码哪个文件第几行、命令的实际输出）');
    }
    because = String(because ?? '').trim();
    const tasks = list.map(getTask);
    for (const t of tasks) {
      if (!critiquable(t)) throw new AteamError('BAD_STATE', `任务 ${t.id} 已作废或所属需求已验收，不用再审。`);
      if (reviewed(t) && !because) {
        throw new AteamError('INVALID', `${t.id} 已经审过了。要重新审（比如它和新卡冲突），加上 --because "<原因，比如和 T12 冲突>"，会记进历史。`);
      }
    }
    agent.lastCritiqued = tasks.map((t) => t.id);
    for (const t of tasks) {
      const again = reviewed(t);
      t.critiquedRev = t.rev ?? 0;
      const prefix = again ? `重新审卡（${because}）` : '审卡';
      if (verdict === 'issue') {
        t.critiques ??= [];
        t.critiques.push({ id: t.critiques.length + 1, by: agent.id, ts: now(), status: 'open', text, basis, taskStatus: t.status, ...(again ? { because } : {}) });
        addHistory(t, 'critique', agent.id, `${prefix}：${text}（依据：${basis}）`);
        emit('critique', { taskId: t.id, agentId: agent.id, text: `${prefix}意见（${t.id}，${t.status}）：${text}` });
      } else {
        addHistory(t, 'critique', agent.id, `${prefix}通过${String(text ?? '').trim() ? `：${String(text).trim()}` : ''}`);
      }
    }
    changed();
    return tasks;
  }

  function openCritiques(task, statuses = ['open']) {
    return (task.critiques ?? []).filter((c) => statuses.includes(c.status));
  }

  // 审卡意见的流程（有分歧就交给用户，leader 不能自己拍板改卡）：
  //   open      审卡提出，等 leader 回复
  //   proposed  leader 同意，写了打算怎么改，等用户确认
  //   disputed  leader 不同意，写了理由，等用户裁决
  //   redo      用户定了怎么改（instruction），等 leader 照做
  //   resolved  leader 改完了
  //   closed    用户决定不改
  // leader 回复：agree（同意，附改法）/ dispute（不同意，附理由）；用户定了以后 done（改完了）
  function handleCritique(taskId, action, text, basis = '') {
    const task = getTask(taskId);
    if (action === 'agree' || action === 'dispute') {
      text = requireText(text, action === 'agree' ? '打算怎么改' : '不同意的理由');
      basis = requireText(basis, '依据（--basis：需求说明或设计文档的哪一段、代码哪个文件第几行、命令的实际输出）');
      const open = openCritiques(task, ['open']);
      if (!open.length) throw new AteamError('BAD_STATE', `任务 ${task.id} 没有等你回复的审卡意见。`);
      for (const c of open) {
        c.reply = text;
        c.replyBasis = basis;
        c.replyKind = action;
        c.status = action === 'agree' ? 'proposed' : 'disputed';
        c.repliedAt = now();
      }
      addHistory(task, 'critique', 'lead', `${action === 'agree' ? `同意审卡意见，打算：${text}` : `不同意审卡意见：${text}`}（依据：${basis}；等用户决定）`);
    } else if (action === 'done') {
      text = requireText(text, '处理说明（改了什么）');
      const redo = openCritiques(task, ['redo']);
      if (!redo.length) {
        const waiting = openCritiques(task, ['open', 'proposed', 'disputed']);
        throw new AteamError('BAD_STATE', waiting.length
          ? `任务 ${task.id} 的审卡意见还没有用户的决定，不能自己改。先回复（ateam critique agree/dispute），等用户在看板上决定。`
          : `任务 ${task.id} 没有待处理的审卡意见。`);
      }
      for (const c of redo) { c.status = 'resolved'; c.doneText = text; c.doneAt = now(); }
      addHistory(task, 'critique', 'lead', `按用户的决定处理审卡意见：${text}`);
    } else {
      throw new AteamError('INVALID', '只能是 agree、dispute 或 done。');
    }
    changed();
    return task;
  }

  // 用户决定：critic 按审卡意见改；leader 按 leader 的方案（leader 同意时）或维持原样（leader 不同意时）；
  // none 都不改；custom 按用户自己写的意见改（text）
  function ruleCritique(taskId, side, text = '') {
    const task = getTask(taskId);
    const waiting = openCritiques(task, ['proposed', 'disputed']);
    if (!waiting.length) throw new AteamError('BAD_STATE', `任务 ${task.id} 没有等你决定的审卡意见。`);
    let instruction = null;
    let label;
    if (side === 'critic') {
      instruction = `按审卡意见改：${waiting.map((c) => c.text).join('；')}`;
      label = '按审卡意见改';
    } else if (side === 'leader') {
      const agreed = waiting.filter((c) => c.replyKind === 'agree');
      if (agreed.length) {
        instruction = `按你的方案改：${agreed.map((c) => c.reply).join('；')}`;
        label = '按 leader 的方案改';
      } else {
        label = '维持原样（同意 leader）';
      }
    } else if (side === 'none') {
      label = '都不改';
    } else if (side === 'custom') {
      text = requireText(text, '你的意见');
      instruction = `按用户的意见改：${text}`;
      label = `按用户自己的意见改：${text}`;
    } else {
      throw new AteamError('INVALID', '决定只能是 critic、leader、none 或 custom。');
    }
    for (const c of waiting) {
      c.ruling = label;
      c.ruledAt = now();
      c.status = instruction ? 'redo' : 'closed';
      if (instruction) c.instruction = instruction;
    }
    addHistory(task, 'critique', 'user', `用户决定：${label}`);
    if (instruction) emit('critique_ruling', { taskId: task.id, text: `用户决定 ${task.id}：${instruction}` });
    changed();
    return task;
  }

  // leader 给正在做的 worker 补充说明（比如审卡发现描述有误）。worker 下一次 progress、wait 或 submit 时收到
  // by 为 'user'：用户在看板上直接留言，worker 收到时标明来自用户
  function noteTask(taskId, text, by = 'lead') {
    text = requireText(text, '补充说明');
    const task = getTask(taskId);
    if (task.status !== 'working' && task.status !== 'asking') {
      throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，只有进行中的任务能补充说明；待领取的直接 ateam task edit 改卡。`);
    }
    const line = by === 'user' ? `（用户直接说）${text}` : text;
    task.pendingNote = task.pendingNote ? `${task.pendingNote}\n\n${line}` : line;
    addHistory(task, 'note', by, text);
    changed();
    return task;
  }

  function takeNote(task) {
    const note = task.pendingNote;
    if (!note) return null;
    delete task.pendingNote;
    changed();
    return note;
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
    delete task.parked;
    delete task.parkedFor;
    releaseAgentOf(task);
    addHistory(task, 'approved', 'lead', note ?? '');
    // 有新代码进来了：预演过的演播卡，页面可能已经变了
    for (const t of state.tasks) if (isDemo(t) && t.rehearsedAt && !t.mayChange) t.mayChange = true;
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

  function answer(taskId, text, by = 'lead') {
    text = requireText(text, '答复');
    const task = getTask(taskId);
    if (task.status === 'asking' && task.parked) {
      unpark(task);
    } else if (task.status === 'asking') {
      task.status = 'working';
    } else if (!(task.status === 'pending' && task.handoff)) {
      throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，没有待回答的提问。`);
    }
    task.pendingDelivery = by === 'user' ? { kind: 'answer', text, by } : { kind: 'answer', text };
    addHistory(task, 'answered', by, text);
    changed();
    return task;
  }

  // 用户在看板上直接回复：卡在等答复就当答复送给 worker，在做就当补充说明；都通知 leader
  function userReply(taskId, text) {
    const task = getTask(taskId);
    let kind;
    if (task.status === 'asking') { answer(taskId, text, 'user'); kind = 'answer'; }
    else if (task.status === 'working') { noteTask(taskId, text, 'user'); kind = 'note'; }
    else throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，只有进行中、等答复的卡能直接回复。`);
    emit('user_reply', {
      taskId: task.id, agentId: task.assignee ?? undefined, kind,
      text: kind === 'answer' ? `用户直接答复了 ${task.id} 的提问：${text.trim()}` : `用户给正在做 ${task.id} 的 worker 留言：${text.trim()}`,
    });
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
  function cancelJob(jobId, reason = '', userApproved = false) {
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

  function report(jobId, markdown) {
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
  function acceptJobs(ids) {
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

  // ---------- 租约 ----------

  // leader（或用户在看板上）确认原窗口没了，立即收回任务交给别人接手，不必等租约过期。
  // 同时把原 worker 标记为掉线：原窗口万一又活过来，会收到「租约已失效」并重新加入，不会和接手的人抢同一个任务。
  function reclaim(taskId, reason = '') {
    const task = getTask(taskId);
    if (isDemo(task) && (task.status === 'demoing' || task.status === 'wrapping')) {
      const agent = task.assignee && findAgent(task.assignee);
      if (agent) {
        agent.status = 'offline';
        agent.currentTask = null;
        delete agent.stale;
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

  // 从看板和 status 里移除掉线的 worker。记录保留（标记 hidden），历史里的编号和名字照常显示。
  function hideAgents(ids) {
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

  // 租约扫描：
  // - 手上有进行中任务的 worker：没动静超过 leaseMs 只标记「可能停了」并提醒（它可能在跑很长的命令），
  //   任务一直留在它手上，等用户确认后才收回（reclaim）。worker 用 progress --expect 报备过的时长也算有动静。
  // - 其它 worker（空闲、或任务已提交等 review）：超过 leaseMs 直接判掉线，没有任务要转手。
  function sweep(isWaiting) {
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
  function noteActivity(agentId, ts) {
    const agent = findAgent(agentId);
    if (!agent || agent.status !== 'online' || !(ts > agent.lastSeenAt)) return false;
    agent.lastSeenAt = Math.min(ts, now());
    clearStale(agent);
    changed();
    return true;
  }

  // ---------- 演播卡 ----------
  // 演播卡（kind: 'demo'）只能放在演播需求（job.demo）里，脚本是仓库里的一个文件（task.script）。
  // 状态：ready（待演播）→ queued（用户点了开始，等 worker 领）→ demoing（前台浏览器演播中）
  // → wrapping（清理、写操作记录、提交）→ ready，可以无限次重复。每次演播记一条 task.runs。
  // queued、以及没叫停的 demoing 期间全队冻结派发（见 nextFor）。读脚本、提交操作记录在 server 里。

  const DEMO_UNCLAIMED_MS = 2 * 60 * 1000;
  const isDemo = (t) => t.kind === 'demo';
  const lastRun = (task) => task.runs?.[task.runs.length - 1] ?? null;

  function addDemo({ jobId, title, script, role = 'test' } = {}) {
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

  function editDemo(task, patch) {
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
  function demoFrozen() {
    return state.tasks.find((t) => isDemo(t) && (t.status === 'queued' || (t.status === 'demoing' && !t.stopRequested))) ?? null;
  }

  // 开始演播的阻碍，空数组表示可以开始
  function demoBlockers(taskId) {
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
  function startDemo(taskId, mode = 'show', steps = null, totalSteps = null, viewport = null) {
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

  function claimDemo(agent, task) {
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
  function closeRun(task, outcome, text = '') {
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
  function interruptDemo(task, why) {
    if (task.status === 'demoing') closeRun(task, 'interrupted', why);
    else addHistory(task, 'demo_ended', 'system', `收尾中断：${why}`);
    task.status = 'ready';
    task.assignee = null;
    delete task.stopRequested;
    delete task.demoStep;
    delete task.paused;
    emit('demo_interrupted', { taskId: task.id, text: `演播 ${task.id} 中断（${why}），已回到待演播` });
  }

  function demoNext(task) {
    if (task.status === 'wrapping' && task.stopNotice) {
      delete task.stopNotice;
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

  function stopDemo(taskId) {
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
  function pauseDemo(taskId) {
    const task = getTask(taskId);
    if (!isDemo(task) || task.status !== 'demoing' || task.stopRequested) throw new AteamError('BAD_STATE', `演播卡 ${task.id} 不在演播中，不能暂停。`);
    if (task.paused) return task;
    const after = task.demoStep?.n;
    task.paused = { at: now(), afterStep: after ?? null };
    addHistory(task, 'demo_paused', 'user', after ? `暂停（第 ${after} 步做完后停住）` : '暂停（第一步开始前停住）');
    changed();
    return task;
  }

  function resumeDemo(taskId) {
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
  function demoStep(agentId, n, total, text, cue = null, slow = false) {
    const { agent, task } = demoHeld(agentId);
    if (task.status === 'demoing' && task.stopRequested) {
      toWrapping(task);
      changed();
      return { task, stopped: true };
    }
    if (task.status !== 'demoing') {
      if (lastRun(task)?.outcome === 'stopped') {
        if (task.stopNotice) { delete task.stopNotice; changed(); }
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
  function demoEnd(agentId, result, stuck = false) {
    result = requireText(result, '演播结果');
    const { agent, task } = demoHeld(agentId);
    if (task.status === 'wrapping' && lastRun(task)?.outcome === 'stopped') {
      delete task.stopNotice;
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

  function demoTaskForSave(agentId) {
    const { agent, task } = demoHeld(agentId);
    if (task.status !== 'wrapping') {
      throw new AteamError('BAD_STATE', `演播卡 ${task.id} 当前状态是 ${task.status}，演播结束后才能提交操作记录。跑完请先 ateam demo end --as ${agent.id} "<结果>"。`);
    }
    return task;
  }

  function recordDemoSave(agentId, summary, commit) {
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
  function markOpsCleared(taskId, on) {
    const task = getTask(taskId);
    if (on) task.opsCleared = now();
    else delete task.opsCleared;
    changed();
    return task;
  }

  // 用户在看板上「结束收尾」：worker 迟迟不收尾（卡住、窗口没了）时，卡直接回到待演播，不等它。
  // worker 下次调用演播命令时被告知停手（demoReleased）
  function releaseDemo(taskId) {
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
    delete task.stopNotice;
    delete task.stopRequested;
    delete task.demoStep;
    addHistory(task, 'demo_ended', 'user', '用户结束收尾，卡回到待演播（这次的操作记录如果还没提交就不保存）');
    emit('demo_stopped', { taskId: task.id, agentId: agent?.id, text: `用户结束了 ${task.id} 的收尾，卡回到待演播` });
    changed();
    return task;
  }

  // 开始后 2 分钟没人领：撤回，解除冻结
  function expireDemoRequests() {
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
    get leaseMs() { return config().leaseMin * 60000; },
    config,
    createJob, editJob, addTask, editTask,
    join, touch,
    nextFor, waitingInfo, progress, ask, taskForSubmit, addCommits, recordSubmit,
    pauseDemo, resumeDemo, holdTask, holdJob, acceptJobs, setPriority, assignTask, submitCritique, handleCritique, ruleCritique, noteTask, userReply, critiqueQueue, cards, dispatchOrder, approve, reject, answer, release, cancel, cancelJob, reclaim, hideAgents, dismiss, keepAgents, setSettings, keepWaiting, checkIdle, report, sweep, noteActivity,
    getJob, getTask, pendingActions, takeEvents, overlapsFor,
    setLeaderAway, clashes, addDemo, demoBlockers, markOpsCleared, startDemo, stopDemo, releaseDemo, demoFrozen, demoStep, demoEnd, demoTaskForSave, recordDemoSave, expireDemoRequests,
  };
}
