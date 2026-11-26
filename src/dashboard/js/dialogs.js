// 弹框：通用确认、审卡分歧、worker 无响应

import { data, LANE_LABEL, setView } from './state.js';
import { agentLabel, avatar, el, fill, laneOf, modalHead, renderMarkdown } from './util.js';
import { wakePrompt } from './workers.js';
import { promptBlock } from './helper.js';
import { awaitingUser, critiqueItem, renderDrawer } from './drawer.js';
import { poll, render, saveView } from './app.js';

// 通用确认框：title、body、ok（按钮文字）、reason（要不要填原因）、disabled、run(reason) → { ok, message }
let confirmState = null;
export function closeConfirm() {
  confirmState = null;
  const box = document.getElementById('confirm-dialog');
  box.hidden = true;
  box.replaceChildren();
}
export function openConfirm(opts) {
  confirmState = { ...opts, error: null, busy: false };
  renderConfirm();
}
function renderConfirm() {
  const c = confirmState;
  const box = document.getElementById('confirm-dialog');
  if (!c) return closeConfirm();
  const reason = c.reason ? el('input', { type: 'text', class: 'confirm-reason', placeholder: '原因（选填）' }) : null;
  const go = async (e) => {
    e.stopPropagation();
    c.busy = true;
    const out = await c.run(reason?.value.trim() ?? '');
    if (out?.ok) { closeConfirm(); await poll(); render(); renderDrawer(false); return; }
    c.busy = false;
    c.error = out?.message || '操作失败';
    renderConfirm();
  };
  box.onclick = (e) => { if (e.target === box) closeConfirm(); };
  fill(box, el('div', { class: 'modal', onclick: (e) => e.stopPropagation() },
    modalHead(c.title, closeConfirm),
    el('div', { class: 'modal-body' },
      el('p', null, c.body),
      reason,
      c.error ? el('p', { class: 'hint', style: 'color: var(--rework)' }, c.error) : null),
    el('div', { class: 'modal-foot' },
      el('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); closeConfirm(); } }, '取消'),
      el('button', { class: 'btn warn', disabled: c.disabled || c.busy, onclick: go }, c.ok))));
  box.hidden = false;
  (reason || box.querySelector('.modal-foot .btn'))?.focus();
}
// leader 回复了审卡意见（同意或不同意）后，由你决定怎么办。一次显示一张卡，「稍后再说」这次先不弹。
const decideLater = new Set();
let decideFocus = null;
// 打开某张卡的分歧弹框（之前点过「稍后」的也重新弹）
export function openDecide(id) { decideLater.delete(id); decideFocus = id; renderDecideDialog(); }
let decideCustom = false;
let decideError = null;
function decideTasks() {
  return data.state.tasks.filter((t) => (t.critiques || []).some(awaitingUser));
}
async function decide(t, side, text) {
  try {
    const res = await fetch('/api/critique/rule', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: t.id, side, text }) });
    const out = await res.json();
    decideError = out.ok ? null : out.message;
  } catch { decideError = '无法连接 ateam 服务。'; }
  if (!decideError) { decideCustom = false; decideFocus = null; }
  await poll();
  renderDecideDialog();
}
export function renderDecideDialog() {
  const box = document.getElementById('decide-dialog');
  // 正在写自己的意见：轮询刷新不重画，免得打字丢失
  if (decideCustom && box.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA') return;
  const all = decideTasks();
  for (const id of [...decideLater]) if (!all.some((t) => t.id === id)) decideLater.delete(id);
  const list = all.filter((t) => !decideLater.has(t.id) || t.id === decideFocus);
  if (!list.length) { box.hidden = true; box.replaceChildren(); return; }
  const t = list.find((x) => x.id === decideFocus) || list[0];
  const waiting = t.critiques.filter(awaitingUser);
  const agreed = waiting.some((c) => c.replyKind === 'agree');
  const job = data.state.jobs.find((j) => j.id === t.jobId);
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  const origin = el('div', { class: 'md origin' });
  origin.innerHTML = renderMarkdown(job?.origin || '（该需求未记录原文）');
  const area = el('textarea', { class: 'rules-editor', rows: '4', placeholder: '填写对 leader 的修改要求，例如「按审卡意见修改，但保留原按钮文案」' });
  // 每个选项一张卡片：点了就按它决定
  const choice = (title, desc, fn, on) => el('button', { class: `choice${on ? ' on' : ''}`, onclick: stop(fn) },
    el('span', { class: 'radio' }), el('span', null, el('b', null, title), el('span', { class: 'd' }, desc)));
  const options = agreed ? [
    choice('按 leader 的方案改', 'leader 同意审卡意见并给出修改方案，按该方案修改。', () => decide(t, 'leader')),
    choice('按审卡意见原样改', '不采用 leader 的方案，按审卡意见原样修改。', () => decide(t, 'critic')),
    choice('均不修改', '双方意见均不采纳，任务保持现状。', () => decide(t, 'none')),
  ] : [
    choice('按审卡意见改', '采纳审卡意见，由 leader 按审卡意见修改任务。', () => decide(t, 'critic')),
    choice('维持原样', '采纳 leader 意见，任务保持不变。', () => decide(t, 'leader')),
  ];
  const later = () => { decideLater.add(t.id); decideFocus = null; decideCustom = false; renderDecideDialog(); };
  box.classList.toggle('again', !box.hidden); // 已经开着时重绘不再播弹出动画
  fill(box, el('div', { class: 'modal decide-modal', onclick: (e) => e.stopPropagation() },
    modalHead(all.length > 1 ? `审卡存在分歧，待决定（共 ${all.length} 项）` : '审卡存在分歧，待决定', later),
    el('div', { class: 'modal-body' },
      el('p', { class: 'lead' }, el('b', { style: 'color: var(--ink)' }, `${t.id} ${t.title}`), `　需求 ${t.jobId} · ${t.role} · ${LANE_LABEL[laneOf(t)] || t.status}　`,
        el('button', { class: 'btn ghost sm', onclick: stop(() => { decideLater.add(t.id); renderDecideDialog(); setView({ job: t.jobId, task: t.id, report: false }); saveView(); render(); renderDrawer(true); }) }, '查看任务详情')),
      job?.origin ? [el('div', { class: 'ci-label' }, `需求原文（${t.jobId}）`), origin] : null,
      waiting.map(critiqueItem),
      el('div', { class: 'ci-label', style: 'margin-top: 16px' }, '处理方式'),
      el('div', { class: 'choices' }, options,
        choice('自定义意见', '双方意见均不完全适用，自行填写修改要求。', () => { decideCustom = !decideCustom; renderDecideDialog(); }, decideCustom)),
      decideCustom ? [area, el('div', { class: 'actions' },
        el('button', { class: 'btn primary', onclick: stop(() => decide(t, 'custom', area.value)) }, '按此意见修改'))] : null,
      decideError ? el('p', { class: 'hint', style: 'color: var(--rework)' }, decideError) : null),
    el('div', { class: 'modal-foot' },
      el('span', { class: 'hint' }, '决定后由 leader 执行，并在完成后说明修改内容。'),
      el('button', { class: 'btn', onclick: stop(later) }, '稍后处理'))));
  box.hidden = false;
}
// 手上有进行中任务、但很久没动静的 worker（服务标记 stale）。任务不会自动转手，
// 用户确认「窗口没了」才收回交给别人；确认「还在」就继续等它。点「稍后」只是这次先不弹。
export const staleLater = new Set();
let staleError = null;
async function staleAction(path, body) {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json();
    staleError = out.ok ? null : out.message;
  } catch { staleError = '无法连接 ateam 服务。'; }
  await poll();
  renderStaleDialog();
}
function staleAgents() {
  return data.state.agents.filter((a) => a.status === 'online' && a.stale && a.currentTask);
}
export function renderStaleDialog() {
  const box = document.getElementById('stale-dialog');
  for (const id of [...staleLater]) if (!staleAgents().some((a) => a.id === id)) staleLater.delete(id);
  const list = staleAgents().filter((a) => !staleLater.has(a.id));
  if (!list.length) { box.hidden = true; box.replaceChildren(); return; }
  const items = list.map((a) => {
    const t = data.state.tasks.find((x) => x.id === a.currentTask);
    return el('div', { class: 'stale-item' },
      el('div', { class: 'wcard-head', style: 'margin-bottom: 8px' }, avatar(a.id, a.role),
        el('span', { class: 'who-line' }, el('b', null, agentLabel(a.id)), el('span', { class: 'hint' }, `${a.role} · ${Math.round((Date.now() - a.lastSeenAt) / 60000)} 分钟无活动`))),
      el('p', null, '当前任务：', el('b', null, `${a.currentTask}${t ? ` ${t.title}` : ''}`), '。'),
      el('p', { class: 'hint' }, '该 worker 可能正在执行耗时命令（如导入数据、构建），也可能窗口已停止或 token 已用尽。请检查其 agent 窗口：'),
      el('div', { class: 'actions' },
        el('button', { class: 'btn primary', onclick: (e) => { e.stopPropagation(); staleAction('/api/agents/still-there', { id: a.id }); } }, '仍在工作，继续等待'),
        el('button', { class: 'btn warn', onclick: (e) => { e.stopPropagation(); staleAction('/api/reclaim', { id: a.currentTask, text: '用户确认原窗口没了' }); } }, '窗口已关闭，转交接手'),
        el('button', { class: 'btn ghost', onclick: (e) => { e.stopPropagation(); staleLater.add(a.id); renderStaleDialog(); } }, '稍后处理')),
      el('p', { class: 'hint' }, '窗口仍在但已停止响应：发送以下唤醒提示词即可，无需转交。'),
      promptBlock(wakePrompt(a), renderStaleDialog));
  });
  box.classList.toggle('again', !box.hidden); // 已经开着时重绘不再播弹出动画
  fill(box, el('div', { class: 'modal', onclick: (e) => e.stopPropagation() },
    modalHead(list.length > 1 ? `${list.length} 个 worker 无响应` : 'worker 无响应', null),
    el('div', { class: 'modal-body' },
      el('p', { class: 'lead' }, '任务仍由该 worker 持有，不会自动转交，确认后才会更换。'),
      items,
      staleError ? el('p', { class: 'hint', style: 'color: var(--rework)' }, staleError) : null)));
  box.hidden = false;
}
