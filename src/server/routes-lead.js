// leader 和看板操作需求、卡、worker 的接口：建卡、改卡、审卡、review、留言、规则、启动和下线 worker

import { AteamError } from '../errors.js';
import { addRule, leadRules, needsTidy, rulesFor, unreceived } from '../rules.js';
import { spawnWorker } from '../spawn.js';
import { root, store } from './context.js';
import { requireId } from './http.js';
import { finishWaiter, waiters } from './live.js';
import { approvedRules, countsChange, knownRoles, readRules } from './rules.js';
import { spawnTimes } from './agents.js';
import { ownersFor } from './owners.js';

const SPAWN_JOIN_MS = 2 * 60 * 1000;

export const leadRoutes = {
  'POST /api/jobs': (b) => ({ job: store.createJob({ title: b.title, description: b.description, origin: b.origin, demo: !!b.demo }) }),
  // 用户在看板上宣布 leader 下线（进入无 leader 模式）或恢复
  'POST /api/leader/away': (b) => ({ away: store.setLeaderAway(!!b.on, 'user') }),
  'POST /api/jobs/edit': (b) => {
    const { jobId, ...patch } = b;
    return { job: store.editJob(jobId, patch) };
  },
  'POST /api/jobs/accept': (b) => ({ jobs: store.acceptJobs(b.ids) }),
  'POST /api/jobs/cancel': (b) => store.cancelJob(requireId(b), b.text ?? '', !!b.userApproved),
  'POST /api/tasks': (b) => {
    const task = store.addTask({
      jobId: b.jobId, title: b.title, role: b.role, paths: b.paths,
      description: b.description, acceptance: b.acceptance, dependsOn: b.dependsOn, top: !!b.top,
    });
    return { task, overlaps: store.overlapsFor(task), owners: ownersFor(task.paths) };
  },
  'POST /api/critique': (b) => ({ tasks: store.submitCritique(b.as, b.ids, b.verdict, b.text, b.because, b.basis) }),
  'POST /api/critique/handle': (b) => ({ task: store.handleCritique(requireId(b), b.action, b.text, b.basis) }),
  'POST /api/critique/rule': (b) => ({ task: store.ruleCritique(requireId(b), b.side, b.text) }),
  'GET /api/staffing': () => store.staffingNeeds(),
  'POST /api/spawn': async (b) => {
    const cfg = store.config();
    // 看板上的按钮是用户点的，不受限；leader 的命令要用户在设置里开了才行
    if (b.by !== 'user' && !cfg.leaderSpawn) {
      throw new AteamError('NEEDS_USER', '用户没有允许 leader 自动启动 worker（看板「设置 → 自动启动 worker」）。请告诉用户需要哪个角色的 worker，由用户开窗口或在看板上点「启动」。');
    }
    // 同时在线上限：刚启动、还没加入的也算上，免得 leader 连着开几个都没被拦住
    const max = cfg.maxWorkers;
    const now = Date.now();
    while (spawnTimes.length && now - spawnTimes[0] > SPAWN_JOIN_MS) spawnTimes.shift();
    const joined = store.state.agents.filter((a) => a.joinedAt && now - a.joinedAt <= SPAWN_JOIN_MS).map((a) => a.joinedAt).sort((x, y) => x - y);
    const pending = spawnTimes.filter((t) => { const i = joined.findIndex((j) => j >= t); if (i < 0) return true; joined.splice(i, 1); return false; }).length;
    const count = store.state.agents.filter((a) => a.status === 'online').length + pending;
    const over = max > 0 && count >= max;
    if (b.by !== 'user' && over) {
      throw new AteamError('NEEDS_USER', `在线 worker 已有 ${count} 个（含刚启动、还在加入的），达到用户设定的上限 ${max} 个，不能再自动启动。等别的 worker 空闲下线后再开；确实急需的话，告诉用户可以在看板「设置 → 同时在线 worker 上限」里调高。`);
    }
    const out = await spawnWorker({ root, role: b.role, name: b.name, platform: cfg.spawnPlatform });
    spawnTimes.push(Date.now());
    return { ...out, over, count: count + 1, max };
  },
  'POST /api/message': (b) => store.messageAgent(String(b.to ?? ''), b.text, b.by === 'user' ? 'user' : 'lead'),
  'POST /api/note': (b) => ({ task: store.noteTask(requireId(b), b.text) }),
  'GET /api/cards': (_b, url) => ({ cards: store.cards({ jobId: url.searchParams.get('job') ?? '', todo: url.searchParams.get('todo') === '1' }) }),
  'POST /api/tasks/assign': (b) => ({ task: store.assignTask(requireId(b), b.to) }),
  // by：看板传 user，命令行（leader）不传
  'POST /api/tasks/hold': (b) => ({ task: store.holdTask(requireId(b), !!b.on, b.text ?? '', b.by === 'user' ? 'user' : 'lead') }),
  'POST /api/jobs/hold': (b) => ({ job: store.holdJob(requireId(b), !!b.on, b.text ?? '', b.by === 'user' ? 'user' : 'lead') }),
  'POST /api/tasks/priority': (b) => ({ task: store.setPriority(requireId(b), !!b.top) }),
  'POST /api/tasks/edit': (b) => {
    const { id, ...patch } = b;
    const task = store.editTask(requireId({ id }), patch);
    // 只在改了路径或依赖时提醒
    return { task, overlaps: patch.paths !== undefined || patch.dependsOn !== undefined ? store.overlapsFor(task) : [], owners: patch.paths !== undefined ? ownersFor(task.paths) : [] };
  },
  'POST /api/approve': (b) => ({ task: store.approve(requireId(b), b.text ?? '') }),
  'POST /api/reject': (b) => ({ task: store.reject(requireId(b), b.text) }),
  'POST /api/answer': (b) => ({ task: store.answer(requireId(b), b.text, 'lead', !!b.userApproved) }),
  'POST /api/reply': (b) => ({ task: store.userReply(requireId(b), b.text) }),
  'POST /api/release': (b) => ({ task: store.release(requireId(b)) }),
  'POST /api/cancel': (b) => ({ task: store.cancel(requireId(b), b.text ?? '') }),
  'POST /api/agents/hide': (b) => ({ hidden: store.hideAgents(b.ids) }),
  'POST /api/dismiss': (b) => {
    const dismissed = store.dismiss({ ids: b.ids, role: b.role, all: !!b.all, userApproved: !!b.userApproved, afterTask: !!b.afterTask });
    // 正挂在 wait 上的 worker 立即收到「已下线」（「做完再下线」的等任务结束后由 nextFor 处理）
    for (const { id, later } of dismissed) {
      if (later) continue;
      const waiter = waiters.get(id);
      if (waiter) finishWaiter(id, waiter, 200, { ok: true, result: { kind: 'dismissed' } });
    }
    return { dismissed };
  },
  'POST /api/agents/still-there': (b) => ({ agent: store.keepWaiting(String(b.id ?? '')) }),
  'POST /api/agents/keep': (b) => ({ kept: store.keepAgents(b.ids) }),
  'POST /api/reclaim': (b) => {
    const { task, agentId } = store.reclaim(requireId(b), b.text ?? '');
    // 原 worker 若正挂在 wait 上，立即告诉它租约已失效
    const waiter = agentId && waiters.get(agentId);
    if (waiter) {
      finishWaiter(agentId, waiter, 400, { ok: false, code: 'LEASE_LOST', message: `你的租约已失效，任务已被收回。请重新运行 ateam join --role ${task.role} --id ${agentId}（沿用原编号）` });
    }
    return { task, agentId };
  },
  'GET /api/rules': (_b, url) => {
    const rules = readRules();
    const role = url.searchParams.get('role');
    const roles = knownRoles();
    return { rules, lead: leadRules(rules).trim(), ...(role ? { forRole: rulesFor(rules, role) } : {}), unreceived: unreceived(rules, roles), needsTidy: needsTidy(rules), roles };
  },
  'POST /api/rules': (b) => ({ rules: approvedRules(b.text, !!b.userApproved, countsChange(readRules(), String(b.text ?? ''))) }),
  'POST /api/rules/add': (b) => {
    const line = String(b.text ?? '').trim();
    if (!line) throw new AteamError('INVALID', '规则不能为空。');
    const roles = Array.isArray(b.roles) ? b.roles.map(String).filter((r) => r.trim()) : [];
    const { text, section } = addRule(readRules(), line, roles);
    const rule = `- ${line.replace(/^[-*]\s+/, '')}`;
    return { rules: approvedRules(text, !!b.userApproved, `将在 ${section} 段加一条：${rule}。`), section };
  },
  'POST /api/report': (b) => ({ job: store.report(b.jobId, b.report) }),
};
