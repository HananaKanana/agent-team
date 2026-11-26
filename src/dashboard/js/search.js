// 搜索（⌘K 或 /）和悬停卡片时标出相关的卡

import { data, JOB_STATUS, LANE_LABEL, view } from './state.js';
import { el, fill, icon, laneOf } from './util.js';
import { showRelations } from './settings.js';
import { closeCardMenu, jumpToTask } from './menu.js';
import { render, saveView } from './app.js';

// 按卡号、需求编号或标题搜。卡号打全了排第一；回车跳过去
export let spot = null; // { q, sel }
function openSpotlight() {
  closeCardMenu();
  spot = { q: '', sel: 0 };
  renderSpotlight(true);
}
export function closeSpotlight() {
  spot = null;
  const box = document.getElementById('spotlight');
  box.hidden = true;
  box.replaceChildren();
}
function spotResults(q) {
  const s = q.trim().toLowerCase();
  if (!s) return { tasks: [], jobs: [] };
  const idQ = s.replace(/^#/, '');
  const numQ = /^\d+$/.test(idQ); // 只输数字：按卡号、需求号的数字部分找（248 → T248、J248）
  const score = (id, title) => {
    const i = id.toLowerCase();
    const n = i.slice(1);
    if (i === idQ || (numQ && n === idQ)) return 0;
    if (i.startsWith(idQ) || (numQ && n.startsWith(idQ))) return 1;
    if (title.toLowerCase().includes(s)) return 2;
    return -1;
  };
  const rank = (list, f) => list.map((x) => [f(x), x]).filter(([n]) => n >= 0)
    .sort((a, b) => a[0] - b[0] || Number(b[1].id.slice(1)) - Number(a[1].id.slice(1))).map(([, x]) => x);
  return {
    tasks: rank(data.state.tasks, (t) => score(t.id, t.title)).slice(0, 30),
    jobs: rank(data.state.jobs, (j) => score(j.id, j.title)).slice(0, 8),
  };
}
function renderSpotlight(fresh) {
  const box = document.getElementById('spotlight');
  if (!spot) return closeSpotlight();
  const { tasks, jobs } = spotResults(spot.q);
  // 卡号精确命中时卡排前面，否则需求排前面（需求少，一眼看完）
  const q0 = spot.q.trim().replace(/^#/, '');
  const tasksFirst = tasks.length && (/^t\d/i.test(q0) || (/^\d+$/.test(q0) && !(jobs[0]?.id.slice(1) === q0 && tasks[0]?.id.slice(1) !== q0)));
  const rows = tasksFirst ? [...tasks.map((t) => ['t', t]), ...jobs.map((j) => ['j', j])] : [...jobs.map((j) => ['j', j]), ...tasks.map((t) => ['t', t])];
  spot.sel = Math.max(0, Math.min(spot.sel, rows.length - 1));
  const hl = (title) => {
    const q = spot.q.trim();
    const i = q ? title.toLowerCase().indexOf(q.toLowerCase()) : -1;
    return i < 0 ? title : [title.slice(0, i), el('mark', null, title.slice(i, i + q.length)), title.slice(i + q.length)];
  };
  const pick = ([kind, x]) => {
    closeSpotlight();
    if (kind === 't') jumpToTask(x.id);
    else { view.job = x.id; view.task = null; view.report = false; saveView(); render(); }
  };
  const row = (r, i) => {
    const [kind, x] = r;
    const lane = kind === 't' ? (x.status === 'cancelled' ? 'cancelled' : laneOf(x)) : null;
    const job = kind === 't' ? data.state.jobs.find((j) => j.id === x.jobId) : null;
    return el('button', { class: `spot-row${i === spot.sel ? ' on' : ''}`, 'data-i': i,
      onmousemove: () => { if (spot.sel !== i) { spot.sel = i; renderSpotlight(false); } },
      onclick: (e) => { e.stopPropagation(); pick(r); } },
      el('span', { class: kind === 't' ? `dot s-${lane}` : 'dot job' }),
      el('span', { class: 'k' }, x.id),
      el('span', { class: 't' }, hl(x.title)),
      el('span', { class: 'st' }, kind === 't' ? `${job ? `${job.id} · ` : ''}${LANE_LABEL[lane] || x.status}` : (JOB_STATUS[x.status] || x.status)));
  };
  let input = box.querySelector('input');
  if (fresh || !input) {
    input = el('input', { type: 'text', placeholder: '搜索任务编号、需求编号或标题', autocomplete: 'off', spellcheck: 'false' });
    input.addEventListener('input', () => { spot.q = input.value; spot.sel = 0; renderSpotlight(false); });
    input.addEventListener('keydown', (e) => {
      const n = box.querySelectorAll('.spot-row').length;
      if (e.key === 'ArrowDown') { e.preventDefault(); spot.sel = Math.min(n - 1, spot.sel + 1); renderSpotlight(false); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); spot.sel = Math.max(0, spot.sel - 1); renderSpotlight(false); }
      else if (e.key === 'Enter') { e.preventDefault(); const cur = spotResults(spot.q); const list = /^#?t\d/i.test(spot.q.trim()) && cur.tasks.length ? [...cur.tasks.map((t) => ['t', t]), ...cur.jobs.map((j) => ['j', j])] : [...cur.jobs.map((j) => ['j', j]), ...cur.tasks.map((t) => ['t', t])]; if (list[spot.sel]) pick(list[spot.sel]); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSpotlight(); }
    });
    box.onclick = (e) => { if (e.target === box) closeSpotlight(); };
    fill(box, el('div', { class: 'spot', onclick: (e) => e.stopPropagation() },
      el('label', { class: 'spot-input' }, icon('search'), input, el('kbd', null, 'esc')),
      el('div', { class: 'spot-list' }), el('div', { class: 'spot-empty', hidden: true }), el('div', { class: 'spot-foot' }, el('span', null, '↑↓ 选择'), el('span', null, '↵ 打开'), el('span', null, 'esc 关闭'))));
    box.hidden = false;
    input.focus();
  }
  const list = box.querySelector('.spot-list');
  const sections = [];
  let i = 0;
  const firstKind = rows[0]?.[0];
  for (const kind of firstKind === 't' ? ['t', 'j'] : ['j', 't']) {
    const part = rows.filter((r) => r[0] === kind);
    if (!part.length) continue;
    sections.push(el('div', { class: 'spot-sec' }, kind === 't' ? `任务卡（${part.length}）` : `需求（${part.length}）`));
    for (const r of part) sections.push(row(r, i++));
  }
  fill(list, sections);
  const empty = box.querySelector('.spot-empty');
  empty.hidden = !(spot.q.trim() && !rows.length);
  empty.textContent = '无匹配结果';
  list.querySelector('.spot-row.on')?.scrollIntoView({ block: 'nearest' });
}
document.getElementById('search-btn').addEventListener('click', (e) => { e.stopPropagation(); openSpotlight(); });
addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey)) {
    e.preventDefault();
    if (spot) closeSpotlight(); else openSpotlight();
  }
});
// 悬停卡片时把它依赖的卡和依赖它的卡标出来（设置里开了「悬停显示依赖关系」才标）
let relFor = null;
// 卡片重画后调用：下一次悬停重新标
export function resetRelated() { relFor = null; }
export function markRelated(id) {
  if (relFor === id) return;
  relFor = id;
  for (const n of document.querySelectorAll('.card.rel-self, .card.rel-dep, .card.rel-after')) { n.classList.remove('rel-self', 'rel-dep', 'rel-after'); n.removeAttribute('data-rel'); }
  if (!id || !showRelations) return;
  const t = data.state.tasks.find((x) => x.id === id);
  if (!t) return;
  const mark = (tid, cls, label) => {
    const n = document.querySelector(`.card[data-id="${tid}"]`);
    if (n) { n.classList.add(cls); n.setAttribute('data-rel', label); }
  };
  const after = data.state.tasks.filter((o) => o.dependsOn.includes(id));
  if (!t.dependsOn.length && !after.length) return; // 没有依赖关系就什么都不标
  document.querySelector(`.card[data-id="${id}"]`)?.classList.add('rel-self');
  for (const d of t.dependsOn) mark(d, 'rel-dep', `被 ${id} 依赖`);
  for (const o of after) mark(o.id, 'rel-after', `依赖 ${id}`);
}
document.addEventListener('mouseover', (e) => markRelated(e.target.closest?.('.card[data-id]')?.dataset.id ?? null));
