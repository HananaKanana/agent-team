// 「用量」页的汇总：把 usage.collect 给的每次调用明细，按天、需求、卡、角色、worker 汇总。
// 四类：卡上（worker 在做某张卡时）、空转（worker 没在做卡：等活、加入、下线前后）、leader（leader 的会话）、
// 其他会话（认不出是谁的会话，比如用户自己在项目里开的对话）。
// 卡上记的快照（task.tokens，提交、交接、通过、作废时记）比会话记录算出来的多时（会话记录被删了），用快照，日期取记快照的那个时间点。
// 按天存档（history）：已过去的日子算好后封存，之后会话记录被删也不变；今天的数实时算。
import { addUsage, totalOf, zeroUsage } from './usage.js';

const DAY = 24 * 60 * 60 * 1000;
const HEAVY_RATIO = 3; // 超过同角色已通过卡中位数的几倍算偏高
const HEAVY_MIN_SAMPLES = 5; // 同角色至少几张已通过的卡才比较

const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const label = (t) => { const d = new Date(t); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const brief = (u) => ({ input: u.input, cacheRead: u.cacheRead, output: u.output, calls: u.calls, total: totalOf(u) });
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const keyStart = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
const blankDay = () => ({ ...zeroUsage(), work: 0, idle: 0, leader: 0, other: 0, jobs: {} });
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// history：按天的存档 { days: { 'YYYY-MM-DD': 那天的合计 } }。返回的 seal 是这次新算好、该封存的日子（今天以前、还没存档的）
export function buildReport({ state, collected, now = Date.now(), days = 30, jobId = null, history = null }) {
  const tasks = new Map(state.tasks.map((t) => [t.id, t]));
  const jobs = new Map(state.jobs.map((j) => [j.id, j]));
  let records = [...collected.records];
  const perTask = new Map(collected.perTask);
  // 卡上的快照比现算的多（会话记录被删了）：这张卡改用快照，换掉现算的那几条
  const replaced = new Set();
  for (const t of state.tasks) {
    if (!t.tokens) continue;
    const u = { input: t.tokens.input, cacheRead: t.tokens.cacheRead, output: t.tokens.output, calls: t.tokens.calls };
    const live = perTask.get(t.id);
    if (live && totalOf(live) >= totalOf(u)) continue;
    const at = t.tokens.at ?? [...t.history].reverse().find((h) => h.type === 'approved')?.ts ?? t.history.at(-1)?.ts ?? now;
    if (live) replaced.add(t.id);
    perTask.set(t.id, { ...u });
    records.push({ t: at, ...u, agentId: null, task: t.id, snapshot: true });
  }
  if (replaced.size) records = records.filter((r) => r.snapshot || !replaced.has(r.task));
  const kind = (r) => (r.task ? 'work' : r.agentId ? 'idle' : r.leader ? 'leader' : 'other');

  // 按天合计（全项目，含每个需求的分项）。已存档的日子用存档，今天和还没存档的用现算的
  const liveDays = {};
  for (const r of records) {
    const d = (liveDays[dayKey(r.t)] ??= blankDay());
    addUsage(d, r);
    d[kind(r)] += totalOf(r);
    const jid = r.task ? tasks.get(r.task)?.jobId : null;
    if (jid) addUsage((d.jobs[jid] ??= zeroUsage()), r);
  }
  const todayKey = dayKey(now);
  const sealed = history?.days ?? {};
  const seal = {};
  for (const [k, d] of Object.entries(liveDays)) if (k < todayKey && !(k in sealed)) seal[k] = d;
  const allDays = { ...liveDays, ...sealed, ...seal, [todayKey]: liveDays[todayKey] ?? blankDay() };

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
  // 只看一个需求：只留这个需求各卡上的调用（偏高的基准仍按全项目同角色的卡算，上面已算好）
  if (jobId) {
    const inJob = (id) => tasks.get(id)?.jobId === jobId;
    records = records.filter((r) => r.task && inJob(r.task));
    for (const id of [...perTask.keys()]) if (!inJob(id)) perTask.delete(id);
    // 一个需求通常几天就做完：柱状图默认 7 天，需求做得更久就往前延到第一笔用量那天（最多 30 天）
    const firstKey = Object.keys(allDays).filter((k) => allDays[k].jobs?.[jobId]).sort()[0] ?? todayKey;
    days = Math.min(30, Math.max(7, Math.round((dayStart(now) - keyStart(firstKey)) / DAY) + 1));
  }
  // 一天的数：只看一个需求时取这个需求的分项（都是卡上的用量）
  const slice = (d) => {
    if (!d) return null;
    if (!jobId) return d;
    const j = d.jobs?.[jobId];
    return j ? { ...j, work: totalOf(j), idle: 0, leader: 0, other: 0 } : null;
  };
  const sumOf = (list) => {
    const sum = { ...zeroUsage(), work: 0, idle: 0, leader: 0, other: 0 };
    for (const d of list.map(slice).filter(Boolean)) {
      addUsage(sum, d);
      for (const k of ['work', 'idle', 'leader', 'other']) sum[k] += d[k] || 0;
    }
    return { ...brief(sum), work: sum.work, idle: sum.idle, leader: sum.leader, other: sum.other };
  };

  // 合计：今天、近 7 天、全部。取当天中午再归到零点：跨夏令时的日子不是整 24 小时
  const today = dayStart(now);
  const lastDays = (n) => Array.from({ length: n }, (_, i) => dayKey(dayStart(today - (n - 1 - i) * DAY + DAY / 2)));
  const totals = { today: sumOf([allDays[todayKey]]), week: sumOf(lastDays(7).map((k) => allDays[k])) };
  if (jobId) {
    // 需求的合计按卡算（卡上的快照可能比按天存档的多），和需求概览的 Token 一致
    const sum = zeroUsage();
    for (const u of perTask.values()) addUsage(sum, u);
    totals.all = { ...brief(sum), work: totalOf(sum), idle: 0, leader: 0, other: 0 };
  } else totals.all = sumOf(Object.values(allDays));

  // 每天：最近 days 天
  const daily = lastDays(days).map((k) => {
    const d = slice(allDays[k]);
    return { day: keyStart(k), date: label(keyStart(k)), work: d?.work ?? 0, idle: d?.idle ?? 0, leader: d?.leader ?? 0, other: d?.other ?? 0, calls: d?.calls ?? 0 };
  });

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

  // 按 worker：一个会话里的一个编号算一个 worker（编号会让给新 worker，不同时期、不同平台的同一编号不是同一个 worker，不合并）
  const roleOf = new Map([...(state.retiredAgents ?? []), ...state.agents].map((a) => [a.id, a.role]));
  const agentMap = new Map();
  const seen = new Set();
  for (const r of records) {
    if (!r.agentId) continue;
    seen.add(r.agentId);
    const key = `${r.session}|${r.agentId}`;
    if (!agentMap.has(key)) agentMap.set(key, { id: r.agentId, platform: r.platform, from: r.t, to: r.t, work: 0, idle: 0, calls: 0, tasks: new Set() });
    const a = agentMap.get(key);
    a.from = Math.min(a.from, r.t);
    a.to = Math.max(a.to, r.t);
    if (r.task) { a.work += totalOf(r); a.tasks.add(r.task); } else a.idle += totalOf(r);
    a.calls += r.calls ?? 1;
  }
  const agentRows = [...agentMap.values()].map((a) => ({ ...a, role: roleOf.get(a.id) ?? a.id.replace(/-\d+$/, ''), tasks: a.tasks.size, total: a.work + a.idle }))
    .sort((a, b) => b.total - a.total);

  return {
    generatedAt: now,
    job: jobId ? { id: jobId, title: jobs.get(jobId)?.title ?? '', status: jobs.get(jobId)?.status ?? '' } : null,
    sessions: collected.sessions,
    platforms: collected.platforms ?? {},
    totals,
    daily: daily.map(({ day, ...d }) => d),
    jobs: jobRows,
    roles: roleRows,
    agents: agentRows,
    heavy: taskRows.filter((r) => r.heavy).sort((a, b) => b.heavy - a.heavy),
    heavyRule: { ratio: HEAVY_RATIO, minSamples: HEAVY_MIN_SAMPLES },
    // 给卡详情、快照、按天存档用（不发给页面）
    seal,
    perTask,
    heavyOf: (id) => heavyOf(tasks.get(id), perTask.get(id) ?? zeroUsage()),
    agentsSeen: seen,
  };
}
