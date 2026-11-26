'use strict';
// 用量页（token）

let usageData = null; // /api/usage 的结果
let usageLoading = false;
let usageOpenJob = null; // 按需求表里展开的需求
let usageAllJobs = false;
let usageAllAgents = false;
// 「11-17 14:02 – 18:30」：同一天只写一次日期
function usageSpan(from, to) {
  const d = (t) => { const x = new Date(t); return `${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  const hm = (t) => new Date(t).toTimeString().slice(0, 5);
  return d(from) === d(to) ? `${d(from)} ${hm(from)}–${hm(to)}` : `${d(from)} – ${d(to)}`;
}
let usageOpen = false; // 需求栏底部「用量」打开的全屏页
let usageJob = null; // 只看一个需求时的需求编号（从需求概览的 Token 点进来）；null 为全部
let usageJobData = null; // /api/usage?job= 的结果
let usageJobLoading = false;
function openUsage(jobId = null) {
  usageOpen = true;
  setUsageJob(jobId);
  if (helper.open) { helper = { open: false, focus: null }; renderHelper(); }
  renderUsagePage();
  renderPeersBtn();
  document.getElementById('usage-page').scrollTop = 0;
}
// 切换范围：某个需求或全部，并重新统计
function setUsageJob(jobId) {
  if (jobId !== usageJob) usageJobData = null;
  usageJob = jobId;
  if (jobId) loadJobUsage(true); else loadUsage(true);
  if (usageOpen) { renderUsagePage(); document.getElementById('usage-page').scrollTop = 0; }
}
function closeUsage() {
  usageOpen = false;
  renderUsagePage();
  renderPeersBtn();
}
function renderUsagePage() {
  const page = document.getElementById('usage-page');
  if (!usageOpen) {
    if (!page.hidden) { page.hidden = true; page.replaceChildren(); if (!view.report) document.body.style.overflow = ''; }
    return;
  }
  const scroll = page.hidden ? 0 : page.scrollTop;
  const job = usageJob ? (usageJobData?.job ?? data?.jobs?.find((j) => j.id === usageJob) ?? { id: usageJob, title: '' }) : null;
  const all = () => setUsageJob(null);
  fill(page,
    el('div', { class: 'report-top' },
      el('button', { class: 'btn ghost', onclick: closeUsage }, icon('back'), '返回看板'),
      el('span', { class: 'crumb' }, data?.root ? `${data.root.split('/').pop()} / ` : '',
        job ? [el('a', { href: '#', onclick: (e) => { e.preventDefault(); all(); } }, '用量'), ' / ', el('b', null, job.id)] : el('b', null, '用量'))),
    el('div', { class: 'report-wrap usage-wrap' },
      el('article', { class: 'report-sheet usage-sheet' },
        el('h1', { class: 'report-title' }, job ? `Token 用量 · ${job.id} ${job.title}` : 'Token 用量'),
        job ? el('button', { class: 'link-btn', type: 'button', onclick: (e) => { e.stopPropagation(); all(); } }, '查看全部需求的用量') : null,
        usagePage())));
  page.hidden = false;
  page.scrollTop = scroll;
  document.body.style.overflow = 'hidden';
}
async function loadUsage(fresh) {
  if (usageLoading) return;
  usageLoading = true;
  if (usageOpen) renderUsagePage();
  try {
    const out = await (await fetch(`/api/usage${fresh ? '?fresh=1' : ''}`, { cache: 'no-store' })).json();
    usageData = out.ok ? out.usage : { error: out.message || '读取失败', generatedAt: Date.now() };
  } catch { usageData = { error: '无法连接 ateam 服务。', generatedAt: Date.now() }; } // 带上时间：失败后 1 分钟内不再重读
  usageLoading = false;
  if (usageOpen) renderUsagePage();
  renderMain();
}
async function loadJobUsage(fresh) {
  const id = usageJob;
  if (!id || usageJobLoading) return;
  usageJobLoading = true;
  if (usageOpen) renderUsagePage();
  let got;
  try {
    const out = await (await fetch(`/api/usage?job=${encodeURIComponent(id)}${fresh ? '&fresh=1' : ''}`, { cache: 'no-store' })).json();
    got = out.ok ? out.usage : { error: out.message || '读取失败' };
  } catch { got = { error: '无法连接 ateam 服务。' }; }
  usageJobLoading = false;
  if (usageJob === id) usageJobData = got;
  else if (usageJob) loadJobUsage(true); // 读的过程中换了需求
  if (usageOpen) renderUsagePage();
}
// 需求概览里的合计要用：超过 1 分钟没读过就在后台读一次
function usageForJob(id) {
  if (!usageLoading && (!usageData || Date.now() - (usageData.generatedAt || 0) > 60000)) loadUsage(false);
  return usageData?.jobs?.find((j) => j.id === id) ?? null;
}
const pct = (part, all) => (all ? `${Math.round((part / all) * 100)}%` : '0%');
const USAGE_KINDS = [['work', '卡上', 'brand'], ['idle', '空转', 'asking'], ['leader', 'leader', 'submitted'], ['other', '其他会话', 'pending']];
const usageAll = (x) => USAGE_KINDS.reduce((s, [k]) => s + (x[k] || 0), 0);
function usageSplit(x) {
  const all = usageAll(x);
  return el('div', { class: 'usage-split', title: USAGE_KINDS.filter(([k]) => x[k]).map(([k, name]) => `${name} ${fmtTokens(x[k])}（${pct(x[k], all)}）`).join(' · ') },
    USAGE_KINDS.map(([k]) => el('i', { class: `u-${k}`, style: `width:${pct(x[k] || 0, all)}` })));
}
// 最近 30 天每天的用量：堆叠柱（卡上 / 空转 / 其他会话），悬停看数字
function usageChart(daily) {
  const ns = 'http://www.w3.org/2000/svg';
  const W = 600; const H = 120; const gap = 3;
  const max = Math.max(1, ...daily.map(usageAll));
  const bw = (W - gap * (daily.length - 1)) / daily.length;
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'usage-chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `最近 ${daily.length} 天每天的 token 用量`);
  daily.forEach((d, i) => {
    let y = H;
    const total = usageAll(d);
    for (const [key] of USAGE_KINDS) {
      const cls = `u-${key}`;
      if (!d[key]) continue;
      const h = Math.max(1, (d[key] / max) * (H - 4));
      y -= h;
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', String(i * (bw + gap)));
      r.setAttribute('y', String(y));
      r.setAttribute('width', String(bw));
      r.setAttribute('height', String(h));
      r.setAttribute('class', `bar ${cls}`);
      r.style.fill = `var(--${USAGE_KINDS.find(([k]) => k === key)[2]})`;
      const tip = document.createElementNS(ns, 'title');
      tip.textContent = `${d.date}：共 ${fmtTokens(total)}，调用 ${d.calls} 次\n${USAGE_KINDS.filter(([k]) => d[k]).map(([k, name]) => `${name} ${fmtTokens(d[k])}`).join(' · ')}`;
      r.appendChild(tip);
      svg.appendChild(r);
    }
  });
  return el('div', null, svg, el('div', { class: 'usage-axis' }, el('span', null, daily[0]?.date), el('span', null, daily[Math.floor(daily.length / 2)]?.date), el('span', null, '今天')));
}
// 团队（多人协作）：自己和各同事共享的用量摘要，最近 30 天。同事关掉共享的显示「未共享」
function teamUsage(u) {
  const s = syncInfo;
  if (!s?.enabled || !s.peers?.length) return null;
  const dates = u.daily.map((d) => d.date);
  const today = dates[dates.length - 1];
  const people = [{ name: `${s.name}（我）`, hue: peerHue(s.name), usage: s.selfUsage }, ...s.peers.map((p) => ({ name: p.name, hue: peerHue(p.name), usage: p.usage }))];
  const sumDays = (us, list) => list.reduce((n, d) => n + (us?.days?.[d]?.total ?? 0), 0);
  const rows = people.map((p) => el('tr', null,
    el('td', null, el('span', { class: 'team-legend' }, el('span', null, el('i', { style: `background:hsl(${p.hue} 55% 52%)` }), p.name))),
    p.usage ? [
      el('td', { class: 'num' }, fmtTokens(sumDays(p.usage, [today]))),
      el('td', { class: 'num' }, fmtTokens(sumDays(p.usage, dates.slice(-7)))),
      el('td', { class: 'num' }, fmtTokens(sumDays(p.usage, dates))),
      el('td', { class: 'num' }, String(p.usage.cards ?? 0)),
      el('td', { class: 'num' }, p.usage.perCard != null ? fmtTokens(p.usage.perCard) : '—'),
      el('td', { class: 'num' }, p.usage.reworkRate != null ? `${Math.round(p.usage.reworkRate * 100)}%` : '—'),
    ] : el('td', { class: 'hint', colspan: '6' }, '未共享用量')));
  // 每天按人叠起来的柱状图
  const ns = 'http://www.w3.org/2000/svg';
  const W = 600; const H = 100; const gap = 3;
  const shared = people.filter((p) => p.usage);
  const totalOf = (d) => shared.reduce((n, p) => n + (p.usage.days?.[d]?.total ?? 0), 0);
  const max = Math.max(1, ...dates.map(totalOf));
  const bw = (W - gap * (dates.length - 1)) / dates.length;
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'usage-chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `最近 ${dates.length} 天每人每天的 token 用量`);
  dates.forEach((d, i) => {
    let y = H;
    for (const p of shared) {
      const v = p.usage.days?.[d]?.total ?? 0;
      if (!v) continue;
      const h = Math.max(1, (v / max) * (H - 4));
      y -= h;
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', String(i * (bw + gap)));
      r.setAttribute('y', String(y));
      r.setAttribute('width', String(bw));
      r.setAttribute('height', String(h));
      r.setAttribute('class', 'bar');
      r.style.fill = `hsl(${p.hue} 55% 52%)`;
      const tip = document.createElementNS(ns, 'title');
      tip.textContent = `${d}：${shared.map((x) => `${x.name} ${fmtTokens(x.usage.days?.[d]?.total ?? 0)}`).join(' · ')}`;
      r.appendChild(tip);
      svg.appendChild(r);
    }
  });
  const cols = (...w) => el('colgroup', null, w.map((x) => el('col', { style: x ? `width:${x}` : '' })));
  return [
    el('h2', null, '团队'),
    el('p', { class: 'hint' }, '来自各人同步的用量摘要（约 10 分钟更新一次），用于对比各人的用量和每张任务的消耗。已通过的任务数、每张任务平均和打回率按最近 30 天通过的任务统计。'),
    shared.length ? el('div', null, svg, el('div', { class: 'usage-axis' }, el('span', null, dates[0]), el('span', null, dates[Math.floor(dates.length / 2)]), el('span', null, '今天'))) : null,
    el('table', { class: 'usage-table' }, cols('', '70px', '78px', '78px', '64px', '86px', '58px'),
      el('thead', null, el('tr', null, el('th', null, '成员'), el('th', { class: 'num' }, '今天'), el('th', { class: 'num' }, '近 7 天'), el('th', { class: 'num' }, '近 30 天'),
        el('th', { class: 'num', title: '最近 30 天通过的任务数' }, '已通过'), el('th', { class: 'num' }, '每张任务平均'), el('th', { class: 'num', title: '已通过的任务中被打回过的比例' }, '打回率'))),
      el('tbody', null, rows)),
  ];
}
// 只看一个需求：worker 在这个需求各卡上的用量（不含 leader 和空转）
function usageJobPage() {
  const u = usageJobData;
  const head = el('div', { class: 'usage-head' },
    el('span', { class: 'hint' }, u?.generatedAt ? `统计时间 ${fmtTime(u.generatedAt)} · 只含 worker 在这个需求各卡上的用量，不含 leader 和空转` : ''),
    el('button', { class: 'btn sm', type: 'button', disabled: usageJobLoading, onclick: (e) => { e.stopPropagation(); loadJobUsage(true); } }, usageJobLoading ? '统计中…' : '刷新'));
  if (!u) return [head, el('p', { class: 'hint' }, '统计中…')];
  if (u.error) return [head, el('p', { class: 'hint' }, u.error)];
  const cards = u.jobs[0]?.tasks ?? [];
  if (!cards.length) return [head, el('p', { class: 'hint' }, '这个需求的卡上还没有 token 记录。WorkBuddy 的 worker 不提供 token 数据；会话记录不在本机时也无法统计。')];
  const open = (id) => { closeUsage(); jumpToTask(id); };
  const tile = (name, x) => el('div', { class: 'usage-tile' },
    el('span', null, name), el('b', null, fmtTokens(x.total)),
    el('small', { title: `输入 ${x.input} · 缓存命中 ${x.cacheRead} · 输出 ${x.output}` }, `调用 ${x.calls} 次`));
  const cols = (...w) => el('colgroup', null, w.map((x) => el('col', { style: x ? `width:${x}` : '' })));
  const laneName = (t) => { const live = data?.tasks?.find((x) => x.id === t.id); const lane = live ? laneOf(live) : t.status; return LANE_LABEL[lane] ?? lane; };
  return [
    head,
    el('div', { class: 'usage-tiles' }, tile('今天', u.totals.today), tile('近 7 天', u.totals.week), tile('合计', u.totals.all)),
    el('h2', null, `最近 ${u.daily.length} 天`),
    usageChart(u.daily),
    el('h2', null, '按卡'),
    el('table', { class: 'usage-table' }, cols('', '64px', '72px', '78px', '58px'),
      el('thead', null, el('tr', null, el('th', null, '卡（点击打开）'), el('th', null, '角色'), el('th', null, '状态'), el('th', { class: 'num' }, 'Token'), el('th', { class: 'num' }, '调用'))),
      el('tbody', null, cards.map((t) => el('tr', { class: 'click', title: `打开 ${t.id}`, onclick: (e) => { e.stopPropagation(); open(t.id); } },
        el('td', { title: `${t.id} ${t.title}` }, `${t.id} ${t.title}`, t.heavy ? el('span', { class: 'heavy-tag' }, `${t.heavy} 倍`) : null),
        el('td', null, el('span', { class: 'tag role', style: roleStyle(t.role) }, t.role)),
        el('td', { class: 'hint' }, laneName(t)),
        el('td', { class: 'num' }, fmtTokens(t.total)),
        el('td', { class: 'num' }, String(t.calls)))))),
    cards.some((t) => t.heavy) ? el('p', { class: 'hint' }, `标「倍」的卡用量偏高：超过全项目同角色已通过卡用量中位数的 ${u.heavyRule.ratio} 倍。`) : null,
    el('h2', null, '按角色'),
    el('table', { class: 'usage-table' }, cols('', '52px', '78px'),
      el('thead', null, el('tr', null, el('th', null, '角色'), el('th', { class: 'num' }, '卡数'), el('th', { class: 'num' }, 'Token'))),
      el('tbody', null, u.roles.map((r) => el('tr', null,
        el('td', null, el('span', { class: 'tag role', style: roleStyle(r.role) }, r.role)),
        el('td', { class: 'num' }, String(r.tasks)),
        el('td', { class: 'num' }, fmtTokens(r.total)))))),
    u.agents.length ? [
      el('h2', null, '按 worker'),
      el('p', { class: 'hint' }, '每行是一个 worker 会话在这个需求上的用量。'),
      el('table', { class: 'usage-table' }, cols('', '130px', '44px', '78px'),
        el('thead', null, el('tr', null, el('th', null, 'worker'), el('th', null, '时间'), el('th', { class: 'num' }, '卡数'), el('th', { class: 'num' }, 'Token'))),
        el('tbody', null, u.agents.map((a) => el('tr', null,
          el('td', { title: `${a.id} · ${a.platform}` }, el('span', { class: 'tag role', style: roleStyle(a.role) }, a.id), el('span', { class: 'hint' }, ` ${a.platform === 'Claude Code' ? 'Claude' : 'DSH'}`)),
          el('td', { class: 'hint', title: `${fmtTime(a.from)} – ${fmtTime(a.to)}` }, usageSpan(a.from, a.to)),
          el('td', { class: 'num' }, String(a.tasks)),
          el('td', { class: 'num' }, fmtTokens(a.work)))))),
    ] : null,
    el('p', { class: 'hint' }, 'worker 的用量按卡的时间线归属：领取到提交算这张卡，打回后接着算。leader 的用量和 worker 不在做卡时的空转无法归到某个需求，只在全部需求的用量里统计。卡在提交、交接、通过、作废时记下当时的用量，会话记录被删除后按记下的数计入。'),
  ];
}
function usagePage() {
  if (usageJob) return usageJobPage();
  const u = usageData;
  const head = el('div', { class: 'usage-head' },
    el('span', { class: 'hint' }, u?.generatedAt ? `统计时间 ${fmtTime(u.generatedAt)} · 来自本机 ${u.sessions} 个会话${Object.keys(u.platforms || {}).length ? `（${Object.entries(u.platforms).map(([k, v]) => `${k} ${v} 个`).join('，')}）` : ''}` : ''),
    el('button', { class: 'btn sm', type: 'button', disabled: usageLoading, onclick: (e) => { e.stopPropagation(); loadUsage(true); } }, usageLoading ? '统计中…' : '刷新'));
  const note = el('p', { class: 'hint' }, '数据来自 Claude Code 和 DeepSeek Harness 在本机的会话记录（只读）。会话按其中执行的命令识别：运行 ateam 命令时带 --as 编号的是该 worker，运行 ateam leader 或 ateam watch 的是 leader。worker 的用量按卡的时间线归属：领取到提交算这张卡，打回后接着算；不在做卡时（等待任务、加入、下线前后）记为「空转」；无法识别的会话（如在项目目录中另开的对话）记为「其他会话」。WorkBuddy 的会话保存在云端，本机没有 token 记录，不在统计内。总量 = 输入（含写入缓存）+ 缓存命中 + 输出，缓存命中部分按低价计费。已过去的日子按天存档（.ateam/usage-daily.json），卡在提交、交接、通过、作废时记下当时的用量；之后会话记录被删除（DeepSeek Harness 手动删除、Claude Code 默认保留 30 天），历史合计、每天的柱状图和各卡用量不受影响，只有按 worker 的明细会随会话记录消失。');
  if (!u) return [head, el('p', { class: 'hint' }, '统计中…（第一次需要读取全部会话记录，可能要几秒）')];
  if (u.error) return [head, el('p', { class: 'hint' }, u.error === '未知接口：GET /api/usage' ? '当前服务仍在运行旧版本代码，请重启 ateam 服务后刷新本页。' : u.error)];
  if (!u.sessions) return [head, el('p', { class: 'hint' }, '本机没有这个项目的 Claude Code 或 DeepSeek Harness 会话记录。WorkBuddy 的 worker 不提供 token 数据。'), note];
  const tile = (name, x) => el('div', { class: 'usage-tile' },
    el('span', null, name), el('b', null, fmtTokens(x.total)),
    el('small', { title: `输入 ${x.input} · 缓存命中 ${x.cacheRead} · 输出 ${x.output}` }, [`调用 ${x.calls} 次`, `leader ${pct(x.leader || 0, x.total)}`, `空转 ${pct(x.idle, x.total)}`].flatMap((t, i) => [i ? ' · ' : '', el('span', null, t)])), usageSplit(x));
  const open = (id) => { closeUsage(); jumpToTask(id); };
  const jobs = usageAllJobs ? u.jobs : u.jobs.slice(0, 12);
  const jobRows = jobs.flatMap((j) => {
    const expanded = usageOpenJob === j.id;
    const heavyN = j.tasks.filter((t) => t.heavy).length;
    const row = el('tr', { class: 'click', title: expanded ? '收起' : '展开查看各卡用量', onclick: (e) => { e.stopPropagation(); usageOpenJob = expanded ? null : j.id; renderUsagePage(); } },
      el('td', { title: `${j.id} ${j.title}` }, `${expanded ? '▾' : '▸'} ${j.id} ${j.title}`, heavyN ? el('span', { class: 'heavy-tag' }, `${heavyN} 张偏高`) : null,
        expanded ? el('button', { class: 'link-btn', type: 'button', onclick: (e) => { e.stopPropagation(); setUsageJob(j.id); } }, ' 只看这个需求') : null),
      el('td', { class: 'num' }, String(j.tasks.length)),
      el('td', { class: 'num' }, fmtTokens(j.total)),
      el('td', { class: 'num' }, String(j.calls)));
    if (!expanded) return [row];
    return [row, ...j.tasks.map((t) => el('tr', { class: 'sub click', title: `打开 ${t.id}`, onclick: (e) => { e.stopPropagation(); open(t.id); } },
      el('td', { title: `${t.id} ${t.title}` }, `${t.id} ${t.title}`, t.heavy ? el('span', { class: 'heavy-tag' }, `${t.heavy} 倍`) : null),
      el('td', { class: 'num' }, el('span', { class: 'tag role', style: roleStyle(t.role) }, t.role)),
      el('td', { class: 'num' }, fmtTokens(t.total)),
      el('td', { class: 'num' }, String(t.calls))))];
  });
  const cols = (...w) => el('colgroup', null, w.map((x) => el('col', { style: x ? `width:${x}` : '' })));
  return [
    head,
    el('div', { class: 'usage-tiles' }, tile('今天', u.totals.today), tile('近 7 天', u.totals.week), tile('全部', u.totals.all)),
    el('h2', null, '最近 30 天'),
    el('div', { class: 'usage-legend' }, USAGE_KINDS.filter(([k]) => k !== 'other' || u.totals.all.other).map(([k, name]) => el('span', null, el('i', { class: `u-${k}` }), name))),
    usageChart(u.daily),
    teamUsage(u),
    el('h2', null, '按需求'),
    u.jobs.length ? el('table', { class: 'usage-table' }, cols('', '52px', '78px', '58px'),
      el('thead', null, el('tr', null, el('th', null, '需求（点击展开）'), el('th', { class: 'num' }, '卡数'), el('th', { class: 'num' }, 'Token'), el('th', { class: 'num' }, '调用'))),
      el('tbody', null, jobRows)) : el('p', { class: 'hint' }, '暂无卡上的用量。'),
    u.jobs.length > 12 ? el('button', { class: 'link-btn', type: 'button', onclick: (e) => { e.stopPropagation(); usageAllJobs = !usageAllJobs; renderUsagePage(); } }, usageAllJobs ? '只显示前 12 个' : `显示全部 ${u.jobs.length} 个需求`) : null,
    el('h2', null, '按角色'),
    el('table', { class: 'usage-table' }, cols('', '52px', '78px', '96px'),
      el('thead', null, el('tr', null, el('th', null, '角色'), el('th', { class: 'num' }, '卡数'), el('th', { class: 'num' }, 'Token'), el('th', { class: 'num', title: '已通过的卡平均每张的用量' }, '每张卡平均'))),
      el('tbody', null, u.roles.map((r) => el('tr', null,
        el('td', null, el('span', { class: 'tag role', style: roleStyle(r.role) }, r.role)),
        el('td', { class: 'num' }, String(r.tasks)),
        el('td', { class: 'num' }, fmtTokens(r.total)),
        el('td', { class: 'num' }, r.perTask != null ? fmtTokens(r.perTask) : '—'))))),
    el('h2', null, '按 worker'),
    el('p', { class: 'hint' }, '每行是一个 worker 会话。编号会让给新加入的 worker，同一编号在不同时期可能是不同的 worker，因此不合并。'),
    el('table', { class: 'usage-table' }, cols('', '130px', '44px', '78px', '78px', '64px'),
      el('thead', null, el('tr', null, el('th', null, 'worker'), el('th', null, '时间'), el('th', { class: 'num' }, '卡数'), el('th', { class: 'num' }, '卡上'), el('th', { class: 'num' }, '空转'), el('th', { class: 'num', title: '空转占这个 worker 总用量的比例' }, '空转占比'))),
      el('tbody', null,
        u.totals.all.leader ? el('tr', null, el('td', { title: '运行 ateam leader / ateam watch 的会话合计' }, el('b', null, 'leader')), el('td', null, '—'), el('td', { class: 'num' }, '—'), el('td', { class: 'num' }, fmtTokens(u.totals.all.leader)), el('td', { class: 'num' }, '—'), el('td', { class: 'num' }, '—')) : null,
        (usageAllAgents ? u.agents : u.agents.slice(0, 15)).map((a) => el('tr', null,
          el('td', { title: `${a.id} · ${a.platform}` }, el('span', { class: 'tag role', style: roleStyle(a.role) }, a.id), el('span', { class: 'hint' }, ` ${a.platform === 'Claude Code' ? 'Claude' : 'DSH'}`)),
          el('td', { class: 'hint', title: `${fmtTime(a.from)} – ${fmtTime(a.to)}` }, usageSpan(a.from, a.to)),
          el('td', { class: 'num' }, String(a.tasks)),
          el('td', { class: 'num' }, fmtTokens(a.work)),
          el('td', { class: 'num' }, fmtTokens(a.idle)),
          el('td', { class: 'num' }, pct(a.idle, a.total)))))),
    u.agents.length > 15 ? el('button', { class: 'link-btn', type: 'button', onclick: (e) => { e.stopPropagation(); usageAllAgents = !usageAllAgents; renderUsagePage(); } }, usageAllAgents ? '只显示前 15 个' : `显示全部 ${u.agents.length} 个 worker 会话`) : null,
    u.totals.all.other ? el('p', { class: 'hint' }, `其他会话共 ${fmtTokens(u.totals.all.other)}：项目目录中既不是 leader、也认不出 worker 编号的会话。`) : null,
    el('h2', null, '用量偏高的卡'),
    u.heavy.length ? el('table', { class: 'usage-table' }, cols('', '78px', '64px'),
      el('thead', null, el('tr', null, el('th', null, '卡'), el('th', { class: 'num' }, 'Token'), el('th', { class: 'num' }, '倍数'))),
      el('tbody', null, u.heavy.map((t) => el('tr', { class: 'click', title: `打开 ${t.id}`, onclick: (e) => { e.stopPropagation(); open(t.id); } },
        el('td', { title: `${t.id} ${t.title}` }, el('span', { class: 'tag role', style: roleStyle(t.role) }, t.role), ` ${t.id} ${t.title}`),
        el('td', { class: 'num' }, fmtTokens(t.total)),
        el('td', { class: 'num' }, `${t.heavy} 倍`))))) : el('p', { class: 'hint' }, '没有用量明显偏高的卡。'),
    el('p', { class: 'hint' }, `偏高：超过同角色已通过卡用量中位数的 ${u.heavyRule.ratio} 倍（该角色至少有 ${u.heavyRule.minSamples} 张已通过的卡才比较），常见原因是需求描述不清、反复试错或卡得过大。`),
    note,
  ];
}
