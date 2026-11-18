// 定时小结（每日 / 每周）的内容：这段时间完成了什么、正在做什么、待你处理的事，可选数字统计和 token 用量。由 server.js 按 push.js 的设置定时推送。
// 统计时段：每日是当天零点到现在，每周是最近 7 天（含今天）。时段内什么都没发生时返回 null，不发。
const DAY = 24 * 60 * 60 * 1000;
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const ms = (v) => (typeof v === 'number' ? v : Date.parse(v ?? '') || 0);
const md = (t) => { const d = new Date(t); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const tokens = (n) => (n >= 1e8 ? `${(n / 1e8).toFixed(2)} 亿` : n >= 1e4 ? `${(n / 1e4).toFixed(1)} 万` : String(n));
const clip = (s, n = 24) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function periodStart(kind, now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (kind === 'weekly') d.setDate(d.getDate() - 6);
  return d.getTime();
}

// 小结的段落，可在看板「推送」页逐项开关：[名称, 缺省是否包含]
export const DIGEST_SECTIONS = {
  done: ['完成了什么', true],
  progress: ['正在做什么', true],
  todo: ['待你处理', true],
  stats: ['数字统计（通过率、打回次数）', false],
  tokens: ['Token 用量', false],
};
export const sectionOn = (sections, k) => sections?.[k] ?? DIGEST_SECTIONS[k]?.[1] ?? true;

// state：store.state；usage：usage-report 的结果（可能为 null）；items：待处理清单；name：项目名
// sections：要哪些段落；brief：简洁格式，压成一行；prefix：标题前缀
export function buildDigest({ kind, state, usage, items = [], name, now = Date.now(), sections = {}, brief = false, prefix = 'ateam' }) {
  const want = (k) => sectionOn(sections, k);
  const from = periodStart(kind, now);
  const when = kind === 'weekly' ? '本周' : '今天';
  const jobs = state.jobs.filter((j) => !j.demo);
  const jobOf = new Map(jobs.map((j) => [j.id, j]));
  const tasks = state.tasks.filter((t) => t.kind !== 'demo' && jobOf.has(t.jobId));
  const lastOf = (t, type) => [...t.history].reverse().find((h) => h.type === type)?.ts ?? 0;

  const accepted = jobs.filter((j) => j.status === 'accepted' && ms(j.acceptedAt) >= from);
  const approved = tasks.filter((t) => t.status === 'approved' && lastOf(t, 'approved') >= from);
  const rejects = tasks.reduce((n, t) => n + t.history.filter((h) => h.type === 'rejected' && h.ts >= from).length, 0);
  const active = jobs.filter((j) => ['planning', 'active', 'awaiting_acceptance'].includes(j.status));
  const tok = usage ? usage.totals[kind === 'weekly' ? 'week' : 'today'] : null;
  const todo = items.filter((i) => i.key !== 'stale' && !i.key.startsWith('doctor:'));

  if (!accepted.length && !approved.length && !rejects && !(tok?.total)) return null;

  const head = prefix ? `${prefix} · ` : '';
  const title = kind === 'weekly'
    ? `${head}${name} 每周小结（${md(from)} – ${md(now)}）`
    : `${head}${name} 每日小结（${md(now)} ${WEEK[new Date(now).getDay()]}）`;

  if (brief) {
    const bits = [];
    if (want('done')) bits.push(`${when}完成 ${accepted.length} 个需求、${approved.length} 张卡`);
    if (want('progress')) bits.push(`进行中 ${active.length} 个需求`);
    if (want('todo')) bits.push(`待处理 ${todo.length} 项`);
    if (want('tokens') && tok?.total) bits.push(`Token ${tokens(tok.total)}`);
    return { title, lines: bits.length ? [bits.join('，')] : [] };
  }

  const lines = [];
  // 完成了什么：按需求分组，先写验收通过的需求，再写其余需求里做完的卡（每日列卡的标题，每周卡多时只列前几张）
  if (want('done')) {
    const byJob = new Map();
    for (const t of approved) { if (!byJob.has(t.jobId)) byJob.set(t.jobId, []); byJob.get(t.jobId).push(t); }
    for (const j of accepted) if (!byJob.has(j.id)) byJob.set(j.id, []);
    const order = [...byJob.keys()].sort((a, b) => Number(accepted.includes(jobOf.get(b))) - Number(accepted.includes(jobOf.get(a))) || byJob.get(b).length - byJob.get(a).length);
    // 每日在需求下面逐行列做完的卡；每周只列到需求
    const maxTasks = kind === 'weekly' ? 0 : 6;
    if (order.length) {
      lines.push(`**${when}完成**`);
      for (const id of order) {
        const j = jobOf.get(id);
        const list = byJob.get(id);
        const status = accepted.includes(j) ? '已验收' : j.status === 'awaiting_acceptance' ? '待验收' : null;
        const done = [list.length ? `完成 ${list.length} 张卡` : null, status].filter(Boolean).join('，');
        lines.push(`· ${j.id} ${clip(j.title, 32)}：${done}`);
        for (const t of list.slice(0, maxTasks)) lines.push(`　- ${clip(t.title, 40)}`);
        if (maxTasks && list.length > maxTasks) lines.push(`　- 等共 ${list.length} 张`);
      }
    }
  }
  // 正在做什么：进行中的需求的进度和正在做的卡
  if (want('progress')) {
    const rows = [];
    for (const j of active) {
      if (j.status === 'awaiting_acceptance') continue; // 待验收的在「待你处理」里
      const mine = tasks.filter((t) => t.jobId === j.id && t.status !== 'cancelled');
      const ok = mine.filter((t) => t.status === 'approved').length;
      const busy = mine.filter((t) => ['working', 'asking', 'wrapping', 'submitted'].includes(t.status));
      const waiting = mine.filter((t) => t.status === 'pending').length;
      const state = !mine.length ? '拆卡中' : `已完成 ${ok}/${mine.length}${busy.length ? '' : j.onHold ? '，已暂停领取' : waiting ? `，${waiting} 张待领取` : ''}`;
      rows.push(`· ${j.id} ${clip(j.title, 32)}：${state}`);
      for (const t of busy.slice(0, 3)) rows.push(`　- 正在做：${clip(t.title, 36)}${t.assignee ? `（${t.assignee}）` : ''}`);
    }
    if (rows.length) lines.push('**正在做**', ...rows);
  }
  if (want('todo') && todo.length) lines.push('**待你处理**', ...todo.slice(0, 5).map((i) => `· ${i.text}`), ...(todo.length > 5 ? [`· 等共 ${todo.length} 项`] : []));
  if (want('stats')) {
    const firstPass = approved.filter((t) => !t.history.some((h) => h.type === 'rejected')).length;
    lines.push(`**数字**：通过 ${approved.length} 张${approved.length ? `，一次通过率 ${Math.round((firstPass / approved.length) * 100)}%` : ''}，打回 ${rejects} 次`);
  }
  if (want('tokens') && tok?.total) {
    const parts = [['worker', tok.work + tok.idle], ['leader', tok.leader]].filter(([, v]) => v).map(([k, v]) => `${k} ${tokens(v)}`);
    lines.push(`**Token**：共 ${tokens(tok.total)}（${parts.join('，')}）${kind === 'weekly' ? `，日均 ${tokens(Math.round(tok.total / 7))}` : ''}`);
  }
  return { title, lines };
}

// 定时：返回本次该发的时刻（毫秒）；还没到点、超过 3 小时（服务当时没在运行）或这一期已经发过时返回 null
export function dueAt(kind, cfg, lastSent, now = Date.now()) {
  const c = cfg[kind];
  if (!c?.on) return null;
  const [h, m] = c.time.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (kind === 'weekly' && d.getDay() !== c.weekday) return null;
  const at = d.getTime();
  if (now < at || now - at > 3 * 60 * 60 * 1000) return null;
  if ((lastSent ?? 0) >= at) return null;
  return at;
}

export { DAY };
