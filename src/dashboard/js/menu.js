// 卡片和需求的右键（长按）菜单、跳到某张卡。会改动东西又不好撤回的（收回、作废）先弹确认框

import { data, LANE_LABEL, view } from './state.js';
import { agentLabel, avatar, el, fill, icon, laneOf, pathsOverlap, post } from './util.js';
import { lastClaimSince } from './workers.js';
import { acceptJob } from './jobs.js';
import { focusReply, holdAction, renderDrawer } from './drawer.js';
import { openConfirm } from './dialogs.js';
import { openReport } from './report.js';
import { poll, render, saveView } from './app.js';

export let flashId = null; // 刚跳到的卡，闪一下（jumpToTask 设置，card() 读）
let flashTimer = 0;

// 跳到某张卡：不在当前需求就先切过去；滚到看得见、闪一下，打开它的详情
export function jumpToTask(id) {
  const t = data.state.tasks.find((x) => x.id === id);
  if (!t) return;
  if (t.jobId !== view.job) { view.job = t.jobId; view.report = false; }
  view.task = id;
  saveView();
  flashId = id;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashId = null; }, 1700);
  render();
  renderDrawer(true);
  requestAnimationFrame(() => document.querySelector(`.card[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }));
}
export function closeCardMenu() {
  const m = document.getElementById('card-menu');
  if (m.hidden) return;
  m.hidden = true;
  m.replaceChildren();
}
export function openCardMenu(id, x, y) {
  const t = data.state.tasks.find((q) => q.id === id);
  if (!t) return;
  const tasks = data.state.tasks;
  const m = document.getElementById('card-menu');
  const act = (fn) => (e) => { e.stopPropagation(); closeCardMenu(); fn(); };
  const item = (ic, label, fn, cls = '') => el('button', { role: 'menuitem', class: cls, onclick: act(fn) }, icon(ic), el('span', { class: 't' }, label));
  const taskItem = (o) => {
    const lane = o.status === 'cancelled' ? 'cancelled' : laneOf(o);
    return el('button', { role: 'menuitem', title: `跳转至 ${o.id} ${o.title}`, onclick: act(() => jumpToTask(o.id)) },
      el('span', { class: `dot s-${lane}` }), el('span', { class: 'k' }, o.id), el('span', { class: 't' }, o.title), el('span', { class: 'st' }, LANE_LABEL[lane] || o.status));
  };
  const group = (title, list) => (list.length ? [el('div', { class: 'ctx-group' }, title), list.map(taskItem)] : []);
  const sep = () => el('div', { class: 'sep' });
  const live = (o) => o.status !== 'approved' && o.status !== 'cancelled';

  const deps = t.dependsOn.map((d) => tasks.find((o) => o.id === d)).filter(Boolean);
  const dependents = tasks.filter((o) => o.status !== 'cancelled' && o.dependsOn.includes(t.id));
  // 已经列在依赖里的不再重复列
  const overlaps = t.kind === 'demo' || !live(t) ? [] : tasks.filter((o) => o.id !== t.id && o.kind !== 'demo' && live(o) && pathsOverlap(t.paths, o.paths)
    && !t.dependsOn.includes(o.id) && !o.dependsOn.includes(t.id));
  const parkedTo = t.parked ? (t.parkedFor || lastClaimSince(t.assignee, t.parked)) : null;
  const parkedFrom = tasks.filter((o) => o.parked && (o.parkedFor || lastClaimSince(o.assignee, o.parked)) === t.id);
  const jumps = [
    ...group('依赖', deps),
    ...group('下游任务', dependents),
    ...group('修改相同文件', overlaps),
    ...group('转做的任务', parkedTo ? [tasks.find((o) => o.id === parkedTo)].filter(Boolean) : []),
    ...group('转做前搁置的任务', parkedFrom),
  ];

  const waiting = t.kind !== 'demo' && (t.status === 'pending' || t.status === 'held');
  const actions = [];
  if (waiting) {
    actions.push(item('top', t.priority ? '取消优先' : '设为优先', async () => { await post('/api/tasks/priority', { id: t.id, top: !t.priority }); await poll(); render(); }));
    actions.push(item(t.onHold ? 'play' : 'pause', t.onHold ? '恢复领取' : '暂停领取', () => holdAction('tasks', t.id, !t.onHold)));
    const role = t.role.trim().toLowerCase();
    const online = data.state.agents.filter((a) => a.status === 'online' && a.role.trim().toLowerCase() === role);
    const assign = (to) => async () => { const out = await post('/api/tasks/assign', { id: t.id, to }); if (!out.ok) openConfirm({ title: '指派失败', body: out.message, ok: '确定', run: async () => ({ ok: true }) }); await poll(); render(); };
    actions.push(el('div', { class: 'ctx-group' }, '指派给'));
    actions.push(el('button', { role: 'menuitem', onclick: act(assign('')) }, avatar(null), el('span', { class: 't' }, `不指派`), el('span', { class: 'st' }, `${t.role} 角色均可领取`), !t.assignTo ? icon('tick', 'ok') : null));
    for (const a of online) actions.push(el('button', { role: 'menuitem', onclick: act(assign(a.id)) }, avatar(a.id, a.role), el('span', { class: 't' }, agentLabel(a.id)), el('span', { class: 'st' }, a.currentTask ? `正在处理 ${a.currentTask}` : '空闲'), t.assignTo === a.id ? icon('tick', 'ok') : null));
  }
  const dangers = [];
  if (!t.parked && (t.status === 'working' || t.status === 'asking' || (t.kind === 'demo' && (t.status === 'demoing' || t.status === 'wrapping')))) {
    dangers.push(item('back', '收回换人…', () => openConfirm({
      title: `收回 ${t.id}？`,
      body: `${agentLabel(t.assignee)} 将被标记为离线，${t.kind === 'demo' ? '本次演播记为中断，演播卡回到待演播' : '任务退回待领取，由同角色 worker 接手，已有改动保留'}。如窗口仅停止响应，使用唤醒提示词即可。`,
      ok: '确认收回',
      run: () => post('/api/reclaim', { id: t.id, text: '用户在看板上收回' }),
    }), 'danger'));
  }
  if (live(t)) {
    const blockers = dependents;
    dangers.push(item('ban', '作废…', () => openConfirm({
      title: `作废 ${t.id}？`,
      body: blockers.length
        ? `${blockers.map((o) => o.id).join('、')} 依赖此任务，无法直接作废。请先作废这些任务，或由 leader 移除依赖。`
        : `「${t.title}」作废后将不再派发，且无法恢复。${t.assignee && (t.status === 'working' || t.status === 'asking') ? `${agentLabel(t.assignee)} 正在处理该任务，将在下次调用 ateam 命令时收到作废通知，停止工作并还原改动。` : ''}已提交的代码不会撤销。`,
      reason: !blockers.length,
      ok: '确认作废',
      disabled: blockers.length > 0,
      run: (reason) => post('/api/cancel', { id: t.id, text: reason || '用户在看板上作废' }),
    }), 'danger'));
  }

  // 复制：一行小按钮，点了变「已复制」再关菜单
  const copyBtn = (label, text) => el('button', { onclick: async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(text); } catch {}
    e.currentTarget.textContent = '已复制';
    e.currentTarget.classList.add('done');
    setTimeout(closeCardMenu, 450);
  } }, label);
  const copies = el('div', { class: 'ctx-copy' }, icon('copy'),
    copyBtn('卡号', t.id), copyBtn('卡号 + 标题', `${t.id} ${t.title}`), t.commits?.length ? copyBtn('提交号', t.commits.join(' ')) : null);

  fill(m,
    el('div', { class: 'ctx-head' }, el('span', { class: 'id' }, t.id), el('span', { class: 't' }, t.title)),
    item('popout', '打开详情', () => { view.task = t.id; saveView(); renderDrawer(true); }),
    t.kind !== 'demo' && ['asking', 'working', 'submitted'].includes(t.status) ? item('reply', t.status === 'asking' ? '回复提问…' : '补充说明…', () => focusReply(t.id)) : null,
    jumps.length ? [sep(), jumps] : null,
    actions.length ? [sep(), actions] : null,
    dangers.length ? [sep(), dangers] : null,
    sep(), copies);
  placeMenu(m, x, y);
}
// 贴着鼠标打开，碰到屏幕边就往里收
function placeMenu(m, x, y) {
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  m.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  m.querySelector('button')?.focus();
}
// 左侧需求的右键菜单：查看、验收 / 汇报、暂停领取、跳到需要处理的卡、作废、复制
export function openJobMenu(id, x, y) {
  const j = data.state.jobs.find((q) => q.id === id);
  if (!j) return;
  const m = document.getElementById('card-menu');
  const tasks = data.state.tasks.filter((t) => t.jobId === j.id);
  const act = (fn) => (e) => { e.stopPropagation(); closeCardMenu(); fn(); };
  const item = (ic, label, fn, cls = '') => el('button', { role: 'menuitem', class: cls, onclick: act(fn) }, icon(ic), el('span', { class: 't' }, label));
  const go = () => { view.job = j.id; view.task = null; view.report = false; saveView(); render(); };
  const sep = () => el('div', { class: 'sep' });
  const open = j.status !== 'accepted' && j.status !== 'cancelled';

  const main = [item('popout', '打开', go)];
  if (j.report) main.push(item('inbox', j.status === 'awaiting_acceptance' ? '查看汇报（待验收）' : '查看汇报', () => { go(); openReport(); }));
  if (j.status === 'awaiting_acceptance') {
    main.push(item('check', '验收通过…', () => openConfirm({
      title: `验收 ${j.id}？`,
      body: `「${j.title}」将标记为已验收并归入左侧「已验收」。如需后续修改，在该需求下新增任务后，需求将恢复为进行中。`,
      ok: '验收通过',
      run: async () => { await acceptJob(j.id); return { ok: true }; },
    })));
  }
  // 需要你看一眼的卡：等答复、待 review、挂起
  const LABEL = { asking: '等待答复', submitted: '待 review', held: '已挂起' };
  const notable = tasks.filter((t) => LABEL[t.status]);
  const jumps = notable.length ? [sep(), el('div', { class: 'ctx-group' }, '待处理任务'), notable.map((o) => el('button', { role: 'menuitem', title: `跳转至 ${o.id} ${o.title}`, onclick: act(() => jumpToTask(o.id)) },
    el('span', { class: `dot s-${laneOf(o)}` }), el('span', { class: 'k' }, o.id), el('span', { class: 't' }, o.title), el('span', { class: 'st' }, LABEL[o.status])))] : [];

  const actions = [];
  if (open && !j.demo) actions.push(item(j.onHold ? 'play' : 'pause', j.onHold ? '恢复领取' : '暂停领取（整个需求）', () => holdAction('jobs', j.id, !j.onHold)));
  const dangers = [];
  if (open) {
    const left = tasks.filter((t) => t.status !== 'approved' && t.status !== 'cancelled');
    dangers.push(item('ban', '作废需求…', () => openConfirm({
      title: `作废 ${j.id}？`,
      body: `「${j.title}」作废后不能恢复。${left.length ? `将同时作废 ${left.length} 个未完成任务（${left.map((t) => t.id).join('、')}），相关 worker 将收到通知并停止工作。` : '无未完成任务。'}已通过的任务及已提交的代码保留。`,
      reason: true,
      ok: '确认作废',
      run: (reason) => post('/api/jobs/cancel', { id: j.id, text: reason || '用户在看板上作废', userApproved: true }),
    }), 'danger'));
  }
  const copyBtn = (label, text) => el('button', { onclick: async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(text); } catch {}
    e.currentTarget.textContent = '已复制';
    e.currentTarget.classList.add('done');
    setTimeout(closeCardMenu, 450);
  } }, label);
  fill(m,
    el('div', { class: 'ctx-head' }, el('span', { class: 'id' }, j.id), el('span', { class: 't' }, j.title)),
    main, jumps,
    actions.length ? [sep(), actions] : null,
    dangers.length ? [sep(), dangers] : null,
    sep(), el('div', { class: 'ctx-copy' }, icon('copy'), copyBtn('编号', j.id), copyBtn('编号 + 标题', `${j.id} ${j.title}`)));
  placeMenu(m, x, y);
}
addEventListener('scroll', closeCardMenu, true);
addEventListener('resize', closeCardMenu);
