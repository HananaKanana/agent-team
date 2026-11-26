// 「需要你处理」：标题徽标、浏览器通知、待处理列表、体检修复、验收

import { READONLY } from './prefs.js';
import { data, setView } from './state.js';
import { el, fill, fmtTime, modalHead, post } from './util.js';
import { pendingCancel } from './workers.js';
import {
  closeHelper, helper, installProfile, openHelper, promptBlock, rolesNeedingWorkers, workerPrompt
} from './helper.js';
import { frozenDemo } from './demo.js';
import { restartServer } from './update.js';
import { awaitingUser, renderDrawer } from './drawer.js';
import { openDecide, renderStaleDialog, staleLater } from './dialogs.js';
import { poll, render, saveView, toastClosed } from './app.js';

// 需要你操作的事：待验收的需求、缺 worker 的角色、有活干时 leader 没连上。
// 数量显示在标签页标题和图标上，看板不在前台时也能看到。
const BASE_TITLE = 'ateam 调度台';
let lastBadge = null;
// 每件事 { key, text, body }：key 用来给浏览器通知去重，text 是按钮提示，body 是通知正文
function attentionItems() {
  if (!data) return [];
  const items = [];
  for (const j of data.state.jobs.slice().reverse()) {
    if (j.status === 'awaiting_acceptance') items.push({ key: `accept:${j.id}`, text: `${j.id} 待验收`, body: `${j.id} ${j.title} 待验收` });
  }
  for (const [role, ts] of (frozenDemo() ? new Map() : rolesNeedingWorkers())) {
    items.push({ key: `needs:${role.toLowerCase()}`, role, tasks: ts.map((t) => t.id + (t.handoff ? ' 待接手' : '')).join('、'), text: `${role} 缺少 worker`, body: `${role} 角色的任务无人处理，需启动一个 ${role} worker` });
  }
  if (data.stale) items.push({ key: 'stale', text: '服务需要重启', body: data.staleWhy === 'dev' || data.staleWhy === 'installed' ? '已切换运行模式，请重启 ateam serve 以使用对应的代码' : 'ateam 代码已更新，请重启 ateam serve' });
  for (const t of data.state.tasks) {
    if ((t.critiques || []).some(awaitingUser)) {
      items.push({ key: `dispute:${t.id}`, text: `${t.id} 审卡分歧待决定`, body: `${t.id} ${t.title}：审卡与 leader 存在分歧，待决定` });
    }
  }
  for (const t of data.state.tasks) {
    if (!t.assignTo || (t.status !== 'pending' && t.status !== 'held')) continue;
    const a = data.state.agents.find((x) => x.id === t.assignTo);
    if (!a || a.status !== 'online') {
      items.push({ key: `assign:${t.id}`, text: `${t.id} 指派的 ${t.assignTo} 不在线`, body: `${t.id} 已指派给 ${t.assignTo}，但其不在线，任务处于等待中` });
    }
  }
  for (const a of data.state.agents) {
    const cancelled = pendingCancel(a);
    if (cancelled) {
      items.push({ key: `cancel:${a.id}:${cancelled.id}`, text: `${a.id} 仍在处理已作废的 ${cancelled.id}`, body: `${cancelled.id} 已作废，但 ${a.id} 尚未收到通知，可在其窗口中叫停` });
    }
    if (a.status === 'online' && a.stale && a.currentTask) {
      items.push({ key: `quiet:${a.id}`, text: `${a.id} 无响应`, body: `${a.id} 长时间无活动（当前任务 ${a.currentTask}），请确认窗口状态` });
    }
  }
  for (const c of data.doctor ?? []) items.push({ key: `doctor:${c.key}`, text: `自检：${c.title}有问题`, body: c.detail, fix: c.fix });
  // 多人协作：代码分支（与服务端 codeAttention 同一套规则）
  const code = data.code;
  if (code && !code.detached && !code.noUpstream) {
    const now = Date.now();
    if (code.error) items.push({ key: 'code:error', text: '代码同步失败', body: code.error });
    if (code.ahead > 0 && code.aheadSince && now - code.aheadSince >= 30 * 60 * 1000) items.push({ key: 'code:ahead', text: `${code.ahead} 个提交未推送`, body: `本地 ${code.branch} 有 ${code.ahead} 个提交超过 30 分钟未推送，同事拉取不到这些改动；与其路径重叠的同事任务会一直等待。请推送，或在「帮助 → 设置 → 多人协作」中开启自动推送。` });
    if (code.behind > 0 && code.behindSince && now - code.behindSince >= 10 * 60 * 1000) items.push({ key: 'code:behind', text: `落后远程 ${code.behind} 个提交`, body: `本地 ${code.branch} 落后远程 ${code.behind} 个提交，worker 仍在旧代码上修改，后续合并更易冲突。请拉取，或在「帮助 → 设置 → 多人协作」中开启自动拉取。` });
  }
  // 演播需求一直是进行中，但不需要 leader 在线
  const busy = data.state.jobs.some((j) => !j.demo && (j.status === 'planning' || j.status === 'active'));
  if (busy && data.leader && (data.leader.away || !data.leader.online)) {
    items.push(data.leader.away
      ? { key: 'leader', text: '无 leader 模式', body: 'leader 不在线：等待答复、待 review 的任务已搁置，worker 转做无依赖的任务。leader 恢复后将依次处理' }
      : { key: 'leader', text: 'leader 未连接', body: 'leader 未连接，仍有未完成的需求' });
  }
  return items;
}
// 一件事持续 1 分钟才通知（worker 掉线马上重连、leader 短暂断开都不打扰），同一件事只通知一次，
// 事情消失后再出现会再通知。打开页面时已经存在的事不通知（标题上已经有数字了）。
const NOTIFY_SETTLE_MS = 60 * 1000;
const notifySeen = new Map(); // key -> 第一次看到的时间
const notifyDone = new Set();
let notifyPrimed = false;
const canNotify = () => typeof Notification !== 'undefined';
function checkNotify(items) {
  const keys = new Set(items.map((i) => i.key));
  for (const key of [...notifySeen.keys()]) {
    if (!keys.has(key)) { notifySeen.delete(key); notifyDone.delete(key); }
  }
  for (const i of items) {
    if (!notifySeen.has(i.key)) {
      notifySeen.set(i.key, Date.now());
      if (!notifyPrimed) notifyDone.add(i.key);
    }
  }
  notifyPrimed = true;
  if (!canNotify() || Notification.permission !== 'granted') return;
  const fresh = items.filter((i) => !notifyDone.has(i.key) && Date.now() - notifySeen.get(i.key) >= NOTIFY_SETTLE_MS);
  if (!fresh.length) return;
  for (const i of fresh) notifyDone.add(i.key);
  const project = (data.root || '').split('/').filter(Boolean).pop() || '';
  const body = fresh.length === 1 ? fresh[0].body : `${fresh.length} 项待处理：${fresh.map((i) => i.text).join('；')}`;
  try {
    const n = new Notification(`ateam${project ? ` · ${project}` : ''}`, { body, tag: `ateam-${project}`, silent: true });
    n.onclick = () => { window.focus(); n.close(); };
  } catch {}
}
function renderNotifyButton() {
  const btn = document.getElementById('notify-btn');
  const show = canNotify() && Notification.permission === 'default';
  btn.hidden = !show;
}
export async function enableNotify() {
  if (!canNotify()) return;
  try { await Notification.requestPermission(); } catch {}
  renderNotifyButton();
  if (Notification.permission === 'granted') {
    try { new Notification('ateam 通知已开启', { body: '需求待验收、任务缺少 worker、leader 离线时将在此提醒。请保持看板标签页打开（可在后台）。', silent: true }); } catch {}
  }
}
export function setBadge(text, color) {
  const key = `${text}|${color}`;
  if (key === lastBadge) return;
  lastBadge = key;
  document.title = text ? `(${text}) ${BASE_TITLE}` : BASE_TITLE;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">`
    + `<rect x="2" y="2" width="28" height="28" rx="7" fill="#2f7d55"/>`
    + `<text x="16" y="22" font-size="16" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">a</text>`
    + (text ? `<circle cx="25" cy="7" r="7" fill="${color}"/>` : '')
    + '</svg>';
  let link = document.querySelector('link[rel="icon"]');
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.append(link); }
  link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
export function renderAttention() {
  // 局域网只读访客重启不了服务，不显示这条提示
  document.getElementById('stale').hidden = !data?.stale || toastClosed.has('stale') || READONLY;
  document.getElementById('stale-why').textContent = data?.staleWhy === 'dev' ? '已切换到开发模式，当前服务仍在运行安装版的代码。' : data?.staleWhy === 'installed' ? '已切换回安装版，当前服务仍在运行源码仓库的代码。' : 'ateam 代码已更新，当前服务仍在运行旧版本。';
  const restartBtn = document.getElementById('stale-restart');
  restartBtn.onclick ??= (e) => { e.stopPropagation(); restartServer(restartBtn); };
  const items = attentionItems();
  setBadge(items.length ? String(items.length) : '', '#d9534f');
  checkNotify(items);
  renderNotifyButton();
  const btn = document.getElementById('attention');
  if (!items.length) { btn.hidden = true; return; }
  btn.hidden = false;
  fill(btn, '待处理', el('span', { class: 'cnt' }, String(items.length)));
  btn.title = items.map((i) => i.text).join('\n');
}
// 「需要你处理」：点开一个列表，每件事一行，点哪件就去处理哪件
export let attentionOpen = false;
export function closeAttention() { attentionOpen = false; renderAttentionList(); }
// 页头「需要你处理」按钮：打开时重置勾选和体检结果
export function toggleAttention() {
  attentionOpen = !attentionOpen;
  if (attentionOpen && helper.open) closeHelper();
  acceptPick = null;
  acceptConfirm = false;
  acceptMsg = '';
  doctorFix = { busy: null, key: null, msg: '', error: false };
  renderAttentionList();
  if (attentionOpen) recheckDoctor();
}
function goAttention(key) {
  attentionOpen = false;
  renderAttentionList();
  const [kind, id] = key.split(':');
  if (kind === 'accept') {
    setView({ job: id, task: null, report: false });
    saveView();
    render();
    document.getElementById('main').scrollTop = 0;
  } else if (kind === 'needs') {
    needsExpanded.add(id ? [...rolesNeedingWorkers().keys()].find((r) => r.toLowerCase() === id) || id : id);
    attentionOpen = true;
    renderAttentionList();
  } else if (kind === 'leader') {
    openHelper({ tab: 'lead' });
  } else if (kind === 'quiet') {
    staleLater.delete(id);
    renderStaleDialog();
  } else if (kind === 'dispute') {
    openDecide(id);
  } else if (kind === 'assign') {
    const t = data.state.tasks.find((x) => x.id === id);
    if (t) { setView({ job: t.jobId, task: t.id, report: false }); saveView(); render(); renderDrawer(true); }
  } else if (kind === 'cancel') {
    openHelper({ focus: id });
  }
  // stale（服务需要重启）：顶部黄色提示条已经写了怎么做
}
// 「其它」里每件事前面的类别：[文字, 颜色]
const needsExpanded = new Set(); // 「需要你处理」里展开了提示词的缺人角色
const ATT_KIND = {
  needs: ['缺人', 'asking'], stale: ['重启', 'rework'], dispute: ['分歧', 'submitted'], assign: ['指派', 'working'],
  cancel: ['作废', 'rework'], quiet: ['无响应', 'asking'], leader: ['leader', 'rework'], doctor: ['自检', 'pending'],
};
// 自检项的「修复」：由服务改配置并重跑自检，修好的项随下次刷新消失；结果提示留在原处
let doctorFix = { busy: null, key: null, msg: '', error: false };
async function fixDoctor(key) {
  doctorFix = { busy: key, key, msg: '', error: false };
  renderAttentionList();
  const out = await post('/api/doctor/fix', { key, profile: installProfile });
  doctorFix = { busy: null, key, msg: out.message || '', error: !out.ok };
  await poll();
  renderAttentionList();
}
// 打开「待处理」时重跑一次自检：手动改好的配置不用重启服务就能消失
async function recheckDoctor() {
  try { await fetch('/api/doctor?fresh=1', { cache: 'no-store' }); } catch {}
  await poll();
  if (attentionOpen) renderAttentionList();
}
// 弹框：待验收的需求可以勾选后一次验收通过；其它事每件一行，点「去处理」跳过去
let acceptPick = null;    // 勾选的需求编号；null 表示还没动过，默认全选
let acceptConfirm = false; // 「验收通过」两步确认
let acceptMsg = '';
export function renderAttentionList() {
  const box = document.getElementById('attention-list');
  const items = attentionOpen ? attentionItems() : [];
  // 最后一项刚被「修复」掉时先不关，留着修复结果的提示
  if (!items.length && !(attentionOpen && doctorFix.msg)) { attentionOpen = false; box.hidden = true; box.replaceChildren(); return; }
  const jobs = data.state.jobs.filter((j) => j.status === 'awaiting_acceptance').reverse();
  if (acceptPick === null) acceptPick = new Set(jobs.map((j) => j.id));
  for (const id of [...acceptPick]) if (!jobs.some((j) => j.id === id)) acceptPick.delete(id);
  const others = items.filter((i) => !i.key.startsWith('accept:'));
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  const picked = jobs.filter((j) => acceptPick.has(j.id));
  const allOn = picked.length === jobs.length;

  const allBox = el('input', { type: 'checkbox', 'aria-label': '全选' });
  allBox.checked = allOn;
  allBox.indeterminate = picked.length > 0 && !allOn;
  allBox.addEventListener('change', () => { acceptPick = new Set(allOn ? [] : jobs.map((j) => j.id)); acceptConfirm = false; renderAttentionList(); });
  const acceptSec = jobs.length ? [
    el('label', { class: 'acc-head', title: allOn ? '全不选' : '全选' }, allBox, `待验收（${jobs.length}）`),
    el('div', { class: 'acc-list' }, jobs.map((j) => {
      const tasks = data.state.tasks.filter((t) => t.jobId === j.id && t.status !== 'cancelled');
      const box2 = el('input', { type: 'checkbox' });
      box2.checked = acceptPick.has(j.id);
      box2.addEventListener('change', () => { if (box2.checked) acceptPick.add(j.id); else acceptPick.delete(j.id); acceptConfirm = false; renderAttentionList(); });
      return el('label', { class: `acc-row${box2.checked ? ' on' : ''}` }, box2,
        el('span', { class: 'txt' }, el('b', null, j.id), j.title, el('div', { class: 'hint' }, `${tasks.length} 个任务 · ${fmtTime(j.updatedAt)} 提交汇报`)),
        el('button', { class: 'btn sm', onclick: (e) => { e.preventDefault(); e.stopPropagation(); attentionOpen = false; renderAttentionList(); setView({ job: j.id, task: null, report: true }); saveView(); render(); } }, '查看汇报'));
    })),
    el('div', { class: 'acc-foot' },
      acceptMsg ? el('span', { class: 'hint', style: 'margin-right: auto' }, acceptMsg) : null,
      acceptConfirm ? el('button', { class: 'btn ghost', onclick: stop(() => { acceptConfirm = false; renderAttentionList(); }) }, '取消') : null,
      el('button', {
        class: 'btn primary', disabled: picked.length === 0,
        onclick: stop(async () => {
          if (!acceptConfirm) { acceptConfirm = true; renderAttentionList(); return; }
          acceptConfirm = false;
          try {
            const res = await fetch('/api/jobs/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: picked.map((j) => j.id) }) });
            const out = await res.json();
            acceptMsg = out.ok ? `已验收通过 ${picked.length} 个需求。` : out.message;
          } catch { acceptMsg = '无法连接 ateam 服务。'; }
          acceptPick = null;
          await poll();
          renderAttentionList();
        }),
      }, acceptConfirm ? `确认验收 ${picked.length} 个需求` : `验收所选（${picked.length}）`)),
  ] : (acceptMsg ? el('p', { class: 'hint' }, acceptMsg) : null);

  const otherSec = others.length ? [
    jobs.length ? el('div', { class: 'att-head' }, el('h4', null, `其他（${others.length}）`)) : null,
    others.map((i) => {
      // 缺人：不跳走，就地展开开 worker 的提示词
      const role = i.key.startsWith('needs:') ? i.role : null;
      const open = role && needsExpanded.has(role);
      return [el('div', { class: 'att-row' },
        el('span', { class: 'what' }, el('span', { class: `lozenge kind c-${ATT_KIND[i.key.split(':')[0]]?.[1] || 'pending'}` }, ATT_KIND[i.key.split(':')[0]]?.[0] || '其他'), el('span', null, i.body)),
        i.key === 'stale' ? el('span', { class: 'hint' }, '见右上角提示')
          : i.key.startsWith('doctor:') ? (i.fix ? el('button', { class: 'btn sm', disabled: doctorFix.busy, onclick: stop(() => fixDoctor(i.key.slice(7))) }, doctorFix.busy === i.key.slice(7) ? '修复中…' : '修复') : null)
          : role ? el('button', { class: 'btn sm', onclick: stop(() => { open ? needsExpanded.delete(role) : needsExpanded.add(role); renderAttentionList(); }) }, open ? '收起' : '添加 worker')
          : el('button', { class: 'btn sm', onclick: stop(() => goAttention(i.key)) }, '去处理')),
        open ? el('div', { class: 'att-prompt' },
          el('p', { class: 'hint' }, `任务：${i.tasks}。新建 agent 窗口（可使用其他账号），工作目录选择项目目录，发送以下提示词，worker 将自动接手。如需命名，在第一行末尾添加「，名字 账号B」。`),
          promptBlock(workerPrompt(role), renderAttentionList)) : null];
    }),
  ] : null;
  // 修好的自检项会从列表里消失，结果提示（比如需要重启 DeepSeek Harness）单独放在最后
  const fixMsg = doctorFix.msg ? el('p', { class: `att-fix${doctorFix.error ? ' err' : ''}` }, doctorFix.msg) : null;

  box.classList.toggle('again', !box.hidden); // 已经开着时重绘不再播弹出动画
  // 气泡的小箭头对准页头的「需要你处理」按钮
  const r = document.getElementById('attention').getBoundingClientRect();
  box.style.setProperty('--arrow-x', `${Math.max(16, window.innerWidth - 20 - (r.left + r.width / 2) - 5)}px`);
  fill(box, el('div', { class: 'modal att-modal', onclick: (e) => e.stopPropagation() },
    modalHead(`待处理事项（${items.length}）`, () => { attentionOpen = false; renderAttentionList(); }),
    el('div', { class: 'modal-body' }, acceptSec, otherSec, fixMsg)));
  box.hidden = false;
}
