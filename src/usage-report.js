// 「用量」页的汇总：把 usage.collect 给的每次调用明细，按天、需求、卡、角色、worker 汇总。
// 三类：卡上（worker 在做某张卡时）、空转（worker 没在做卡：等活、加入、下线前后）、其他会话（认不出 worker 的会话）。
// 已通过的卡记在卡上的用量（task.tokens）在会话记录被删后补进来，按通过时间算日期。
import { addUsage, totalOf, zeroUsage } from './usage.js';

const DAY = 24 * 60 * 60 * 1000;
const HEAVY_RATIO = 3; // 超过同角色已通过卡中位数的几倍算偏高
const HEAVY_MIN_SAMPLES = 5; // 同角色至少几张已通过的卡才比较

const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const label = (t) => { const d = new Date(t); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const brief = (u) => ({ input: u.input, cacheRead: u.cacheRead, output: u.output, calls: u.calls, total: totalOf(u) });
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function buildReport({ state, collected, now = Date.now(), days = 30 }) {
  const tasks = new Map(state.tasks.map((t) => [t.id, t]));
  const jobs = new Map(state.jobs.map((j) => [j.id, j]));
  const records = [...collected.records];
  const perTask = new Map(collected.perTask);
  // 会话记录已删除、只剩卡上记的数：按通过时间补一条
  for (const t of state.tasks) {
    if (!t.tokens || (perTask.has(t.id) && totalOf(perTask.get(t.id)) > 0)) continue;
    const at = [...t.history].reverse().find((h) => h.type === 'approved')?.ts ?? t.history.at(-1)?.ts ?? now;
    const u = { input: t.tokens.input, cacheRead: t.tokens.cacheRead, output: t.tokens.output, calls: t.tokens.calls };
    perTask.set(t.id, { ...u });
    records.push({ t: at, ...u, agentId: null, task: t.id, snapshot: true });
  }
  const kind = (r) => (r.task ? 'work' : r.agentId ? 'idle' : 'other');

  // 合计：今天、近 7 天、全部
  const today = dayStart(now);
  const ranges = { today: today, week: today - 6 * DAY, all: 0 };
  const totals = {};
  for (const [key, from] of Object.entries(ranges)) {
    const sum = { all: zeroUsage(), work: 0, idle: 0, other: 0 };
    for (const r of records) {
      if (r.t < from) continue;
      addUsage(sum.all, r);
      sum[kind(r)] += totalOf(r);
    }
    totals[key] = { ...brief(sum.all), work: sum.work, idle: sum.idle, other: sum.other };
  }

  // 每天：最近 days 天
  const daily = [];
  // 取当天中午再归到零点：跨夏令时的日子不是整 24 小时
  for (let i = days - 1; i >= 0; i--) { const day = dayStart(today - i * DAY + DAY / 2); daily.push({ day, date: label(day), work: 0, idle: 0, other: 0, calls: 0 }); }
  const first = daily[0].day;
  for (const r of records) {
    if (r.t < first) continue;
    const i = Math.round((dayStart(r.t) - first) / DAY);
    const d = daily[Math.max(0, Math.min(daily.length - 1, i))];
    d[kind(r)] += totalOf(r);
    d.calls += r.calls ?? 1;
  }

  // 用量偏高的卡：同角色已通过的卡取中位数比较
  const byRole = new Map();
  for (const [id, u] of perTask) {
    const t = tasks.get(id);
    if (!t || t.kind === 'demo' || t.status !== 'approved' || !totalOf(u)) continue;
    const k = t.role.trim().toLowerCase();
    if (!byRole.has(k)) byRole.set(k, []);
    byRole.get(k).push(totalOf(u));
  }
  const roleMedian = new Map([...byRole].filter(([, xs]) => xs.length >= HEAVY_MIN_SAMPLES).map(([k, xs]) => [k, median(xs)]));
  const heavyOf = (t, u) => {
    const m = t && t.kind !== 'demo' ? roleMedian.get(t.role.trim().toLowerCase()) : null;
    const ratio = m ? totalOf(u) / m : 0;
    return ratio >= HEAVY_RATIO ? Math.round(ratio * 10) / 10 : null;
  };
  const taskRow = (id, u) => {
    const t = tasks.get(id);
    return { id, title: t?.title ?? '', role: t?.role ?? '', status: t?.status ?? '', jobId: t?.jobId ?? null, ...brief(u), heavy: heavyOf(t, u) };
  };
  const taskRows = [...perTask].map(([id, u]) => taskRow(id, u));

  // 按需求
  const jobMap = new Map();
  for (const row of taskRows) {
    if (!row.jobId) continue;
    if (!jobMap.has(row.jobId)) jobMap.set(row.jobId, { sum: zeroUsage(), tasks: [] });
    const j = jobMap.get(row.jobId);
    addUsage(j.sum, row);
    j.tasks.push(row);
  }
  const jobRows = [...jobMap].map(([id, j]) => {
    const job = jobs.get(id);
    return { id, title: job?.title ?? '', status: job?.status ?? '', demo: !!job?.demo, ...brief(j.sum), tasks: j.tasks.sort((a, b) => b.total - a.total) };
  }).sort((a, b) => b.total - a.total);

  // 按角色（卡上的用量）
  const roleMap = new Map();
  for (const row of taskRows) {
    const k = row.role || '未知';
    if (!roleMap.has(k)) roleMap.set(k, { sum: zeroUsage(), tasks: 0, approved: 0, approvedTotal: 0 });
    const r = roleMap.get(k);
    addUsage(r.sum, row);
    r.tasks++;
    if (row.status === 'approved') { r.approved++; r.approvedTotal += row.total; }
  }
  const roleRows = [...roleMap].map(([role, r]) => ({ role, ...brief(r.sum), tasks: r.tasks, perTask: r.approved ? Math.round(r.approvedTotal / r.approved) : null }))
    .sort((a, b) => b.total - a.total);

  // 按 worker：卡上和空转分开
  const roleOf = new Map([...(state.retiredAgents ?? []), ...state.agents].map((a) => [a.id, a.role]));
  const agentMap = new Map();
  for (const r of records) {
    if (!r.agentId) continue;
    if (!agentMap.has(r.agentId)) agentMap.set(r.agentId, { work: 0, idle: 0, calls: 0, idleCalls: 0 });
    const a = agentMap.get(r.agentId);
    if (r.task) a.work += totalOf(r); else { a.idle += totalOf(r); a.idleCalls += r.calls ?? 1; }
    a.calls += r.calls ?? 1;
  }
  const agentRows = [...agentMap].map(([id, a]) => ({ id, role: roleOf.get(id) ?? id.replace(/-\d+$/, ''), ...a, total: a.work + a.idle }))
    .sort((a, b) => b.total - a.total);

  return {
    generatedAt: now,
    sessions: collected.sessions,
    totals,
    daily: daily.map(({ day, ...d }) => d),
    jobs: jobRows,
    roles: roleRows,
    agents: agentRows,
    heavy: taskRows.filter((r) => r.heavy).sort((a, b) => b.heavy - a.heavy),
    heavyRule: { ratio: HEAVY_RATIO, minSamples: HEAVY_MIN_SAMPLES },
    // 给卡详情、快照用（不发给页面）
    perTask,
    heavyOf: (id) => heavyOf(tasks.get(id), perTask.get(id) ?? zeroUsage()),
    agentsSeen: new Set(agentMap.keys()),
  };
}
