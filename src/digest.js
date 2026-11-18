// 定时小结（每日 / 每周）的内容：需求、任务、token 用量、待处理事项。由 server.js 按 push.js 的设置定时推送。
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

// 小结的段落，可在看板「推送」页逐项开关
export const DIGEST_SECTIONS = { jobs: '需求', tasks: '任务', tokens: 'Token 用量', daily: '每天用量（仅每周小结）', heavy: '用量偏高的卡', todo: '待你处理' };

// state：store.state；usage：usage-report 的结果（可能为 null）；items：待处理清单；name：项目名
// sections：要哪些段落（缺省全要）；brief：简洁格式，所有内容压成一行；prefix：标题前缀
export function buildDigest({ kind, state, usage, items = [], name, now = Date.now(), sections = {}, brief = false, prefix = 'ateam' }) {
  const want = (k) => sections[k] !== false;
  const from = periodStart(kind, now);
  const jobs = state.jobs.filter((j) => !j.demo);
  const tasks = state.tasks.filter((t) => t.kind !== 'demo');
  const lastOf = (t, type) => [...t.history].reverse().find((h) => h.type === type)?.ts ?? 0;

  const accepted = jobs.filter((j) => j.status === 'accepted' && ms(j.acceptedAt) >= from);
  const created = jobs.filter((j) => ms(j.createdAt) >= from);
  const active = jobs.filter((j) => ['planning', 'active', 'awaiting_acceptance'].includes(j.status));
  const approved = tasks.filter((t) => t.status === 'approved' && lastOf(t, 'approved') >= from);
  const firstPass = approved.filter((t) => !t.history.some((h) => h.type === 'rejected')).length;
  const rejects = tasks.reduce((n, t) => n + t.history.filter((h) => h.type === 'rejected' && h.ts >= from).length, 0);
  const working = tasks.filter((t) => ['working', 'asking', 'wrapping'].includes(t.status)).length;
  const pending = tasks.filter((t) => t.status === 'pending').length;
  const tok = usage ? usage.totals[kind === 'weekly' ? 'week' : 'today'] : null;

  if (!accepted.length && !created.length && !approved.length && !rejects && !(tok?.total)) return null;

  const head = prefix ? `${prefix} · ` : '';
  const title = kind === 'weekly'
    ? `${head}${name} 每周小结（${md(from)} – ${md(now)}）`
    : `${head}${name} 每日小结（${md(now)} ${WEEK[new Date(now).getDay()]}）`;
  const todo = items.filter((i) => i.key !== 'stale' && !i.key.startsWith('doctor:'));
  if (brief) {
    const bits = [];
    if (want('jobs')) bits.push(`验收 ${accepted.length} 个需求`);
    if (want('tasks')) bits.push(`通过 ${approved.length} 张卡`, `打回 ${rejects} 次`);
    if (want('tokens') && tok?.total) bits.push(`Token ${tokens(tok.total)}`);
    if (want('todo')) bits.push(`待处理 ${todo.length} 项`);
    return { title, lines: bits.length ? [bits.join(' · ')] : [] };
  }
  const lines = [];
  if (want('jobs')) lines.push(`需求：验收通过 ${accepted.length} 个${accepted.length ? `（${accepted.slice(0, 3).map((j) => `${j.id} ${clip(j.title)}`).join('；')}${accepted.length > 3 ? ' 等' : ''}）` : ''}，新建 ${created.length} 个，进行中 ${active.length} 个`);
  if (want('tasks')) lines.push(`任务：通过 ${approved.length} 张${approved.length ? `，一次通过率 ${Math.round((firstPass / approved.length) * 100)}%` : ''}，打回 ${rejects} 次；当前进行中 ${working} 张，待领取 ${pending} 张`);
  if (want('tokens') && tok?.total) {
    const parts = [['worker 卡上', tok.work], ['空转', tok.idle], ['leader', tok.leader], ['其他', tok.other]].filter(([, v]) => v).map(([k, v]) => `${k} ${tokens(v)}`);
    lines.push(`Token：共 ${tokens(tok.total)}，调用 ${tok.calls} 次（${parts.join(' · ')}）${kind === 'weekly' ? `，日均 ${tokens(Math.round(tok.total / 7))}` : ''}`);
  }
  if (want('daily') && kind === 'weekly' && usage) {
    const days = usage.daily.slice(-7).map((d) => `${d.date} ${tokens(d.work + d.idle + (d.leader || 0) + d.other)}`);
    lines.push(`每天：${days.join(' · ')}`);
  }
  const heavy = (usage?.heavy ?? []).filter((h) => { const t = state.tasks.find((x) => x.id === h.id); return t && lastOf(t, 'approved') >= from; });
  if (want('heavy') && heavy.length) lines.push(`用量偏高：${heavy.slice(0, 3).map((h) => `${h.id}（同角色中位数的 ${h.heavy} 倍）`).join('、')}`);
  if (want('todo')) lines.push(todo.length ? `待你处理 ${todo.length} 项：${todo.slice(0, 3).map((i) => i.text).join('；')}${todo.length > 3 ? ' 等' : ''}` : '待你处理：无');
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
