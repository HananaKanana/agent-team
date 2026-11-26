// 页面入口：整体渲染、视图存取、主题、轮询、全局快捷键、页面启动（最后加载）

import { prefs } from './prefs.js';
import { data, setData, setView, view } from './state.js';
import { el, icon, tickSince } from './util.js';
import { renderWorkers } from './workers.js';
import { touchScroll } from './settings.js';
import { closeHelper, helper, openHelper } from './helper.js';
import { renderNeeds } from './spawn.js';
import { renderJobs } from './nav.js';
import { renderMain } from './job-page.js';
import { closeShowDialog, renderShowDialog, showDlg } from './demo.js';
import { PROMPTER_ONLY, renderDemoBanner, renderPrompterStrip } from './prompter.js';
import { renderModePill, renderUpdatePill } from './update.js';
import { closePeers, peersOpen, renderPeersBtn } from './sync.js';
import { closeUsage, renderUsagePage, usageOpen } from './usage.js';
import { assignOpen, closeAssign, closeDrawer, renderDrawer } from './drawer.js';
import { closeCardMenu, openCardMenu, openJobMenu } from './menu.js';
import { closeSpotlight, spot } from './search.js';
import { closeConfirm, renderDecideDialog, renderStaleDialog } from './dialogs.js';
import { closeReport, renderReport } from './report.js';
import {
  attentionOpen, closeAttention, enableNotify, renderAttention, renderAttentionList, setBadge,
  toggleAttention
} from './attention.js';

let lastJson = '';
let lastEtag = '';

// 关掉的气泡：本次打开页面内不再弹（演播的按「这一场 + 状态」记，状态变了会重新出现；页头的「预演中」标签一直在）
export const toastClosed = new Set();
export const toastX = (onClose) => el('button', { class: 'toast-x', type: 'button', title: '关闭', 'aria-label': '关闭', onclick: (e) => { e.stopPropagation(); onClose(); } }, icon('close'));
document.addEventListener('click', (e) => {
  const x = e.target.closest('[data-x]');
  if (!x) return;
  toastClosed.add(x.dataset.x);
  document.getElementById(x.dataset.x).hidden = true;
});
// 深浅色：默认跟随系统，手动切换后记在本浏览器里
const themeBtn = document.getElementById('theme-btn');
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const dark = theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  themeBtn.replaceChildren(icon(dark ? 'sun' : 'moon'));
  themeBtn.title = dark ? '切换到浅色' : '切换到深色';
  themeBtn.setAttribute('aria-label', themeBtn.title);
  return dark;
}
let savedTheme = null;
try { savedTheme = prefs.get('ateam.theme'); } catch {}
applyTheme(savedTheme);
themeBtn.addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try { prefs.set('ateam.theme', next); } catch {}
});
export function render() {
  if (!data) return;
  renderNeeds();
  if (PROMPTER_ONLY) { renderPrompterStrip(); return; }
  renderDemoBanner();
  renderModePill();
  renderUpdatePill();
  renderPeersBtn();
  // 演播开始弹窗：卡已经不是待演播（被别处开始了、作废了）就关掉；其余时候不随轮询重画，免得下拉框被收起
  if (showDlg && data.state.tasks.find((x) => x.id === showDlg.id)?.status !== 'ready') renderShowDialog();
  if (!view.job && data.state.jobs.length) view.job = data.state.jobs[data.state.jobs.length - 1].id;
  renderWorkers();
  renderJobs();
  renderMain();
  renderDrawer(false);
  renderReport();
  renderUsagePage();
  renderStaleDialog();
  renderDecideDialog();
  if (attentionOpen) renderAttentionList(); // 只在数据变化时重画，免得每次轮询都替换掉正在点的勾选框
}
// 选中的需求和打开的任务记在地址栏 hash 里，刷新页面后保留
export function saveView() {
  const hash = [view.job, view.report ? 'report' : view.task].filter(Boolean).join('/');
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname);
}
function loadView() {
  const [job, second] = location.hash.slice(1).split('/');
  const report = second === 'report';
  setView({ job: job || null, task: report ? null : second || null, report });
}
export async function poll() {
  let json;
  try {
    // 带上次的 ETag：状态没变时服务只回 304，不用重新下载和解析整份状态
    const res = await fetch('/api/state?view=dashboard', { cache: 'no-store', headers: lastEtag ? { 'if-none-match': lastEtag } : {} });
    if (res.status !== 200 && res.status !== 304) throw new Error(`HTTP ${res.status}`);
    json = res.status === 304 ? lastJson : await res.text();
    lastEtag = res.headers.get('etag') || '';
  } catch {
    document.getElementById('banner').hidden = toastClosed.has('banner');
    lastJson = null; // 恢复连接后重新渲染，刷新提醒
    lastEtag = '';
    setBadge('!', '#d9534f');
    return;
  }
  document.getElementById('banner').hidden = true;
  toastClosed.delete('banner'); // 连上了：下次再断开时重新提醒
  // 页面代码出错不算断线，不显示「无法连接」；错误在浏览器控制台里看
  try {
    if (json !== lastJson) {
      setData(JSON.parse(json));
      lastJson = json;
      render();
    } else {
      renderWorkers(); // 只刷新「心跳 N 分钟前」
    }
    if (!PROMPTER_ONLY) renderAttention();
  } catch (err) {
    console.error('[ateam] 看板渲染出错', err);
  }
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (spot) { closeSpotlight(); return; }
  if (!document.getElementById('card-menu').hidden) { closeCardMenu(); return; }
  if (!document.getElementById('confirm-dialog').hidden) { closeConfirm(); return; }
  if (showDlg) { closeShowDialog(); return; }
  if (assignOpen) { closeAssign(); return; }
  if (attentionOpen) { closeAttention(); return; }
  if (helper.open) { closeHelper(); return; }
  if (usageOpen) { closeUsage(); return; }
  if (peersOpen) { closePeers(); return; }
  if (view.report) closeReport();
  else if (view.task) closeDrawer();
});
// 点抽屉以外的地方关闭抽屉；点任务卡片则切换到那张卡片（卡片自己的点击处理负责打开）
document.addEventListener('click', (e) => {
  if (!e.target.closest('#card-menu')) closeCardMenu();
  if (attentionOpen && !e.target.closest('#attention, #attention-list')) closeAttention();
  if (helper.open && !e.target.closest('#helper, #helper-btn')) { closeHelper(); }
  if (assignOpen && !e.target.closest('.assign-picker')) closeAssign();
  if (!view.task) return;
  if (e.target.closest('#drawer, .card, .cancelled-row, .demo-row, #demo-banner, #stale-dialog, #decide-dialog, #show-dialog, #confirm-dialog, #card-menu')) return;
  closeDrawer();
});
document.getElementById('notify-btn').addEventListener('click', (e) => { e.stopPropagation(); enableNotify(); });
document.getElementById('attention').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleAttention();
});
document.getElementById('helper-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (helper.open) { closeHelper(); return; }
  if (attentionOpen) closeAttention();
  openHelper();
});
loadView();
// 地址栏的 #需求/卡号 被外部改了（菜单栏、通知点进来）：跳到对应需求并打开那张卡
addEventListener('hashchange', () => {
  const before = JSON.stringify(view);
  loadView();
  if (JSON.stringify(view) !== before) { render(); renderDrawer(true); }
});
poll();
setInterval(poll, 3000);
// 卡片上的时间每秒走一次，不等数据变化
setInterval(() => { for (const n of document.querySelectorAll('.since[data-since]')) tickSince(n); }, 1000);
// 服务有变化时推送过来，立即刷新：后台标签页的定时器会被浏览器暂停，推送不会，标题上的提醒才能及时更新
let pollPending = false;
function pollSoon() {
  if (pollPending) return;
  pollPending = true;
  setTimeout(() => { pollPending = false; poll(); }, 300);
}
try {
  const stream = new EventSource('/api/stream');
  stream.onmessage = () => { if (document.hidden) poll(); else pollSoon(); };
} catch {}
// 切回标签页时马上刷新一次
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
// 排查触屏点不动：地址带 ?inputlog 时，左下角列出最近收到的指针 / 触摸 / 点击事件（类型、来源、目标、是否被拦下）
if (new URLSearchParams(location.search).has('inputlog')) {
  const box = document.createElement('pre');
  box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;margin:0;padding:8px 10px;max-width:70vw;font:11px/1.5 ui-monospace,Menlo,monospace;background:rgba(0,0,0,.82);color:#9fe;border-radius:6px;pointer-events:none;white-space:pre-wrap';
  document.body.append(box);
  const lines = [];
  const desc = (t) => t && t.nodeType === 1 ? `${t.tagName.toLowerCase()}${t.className && typeof t.className === 'string' ? '.' + t.className.trim().split(/\s+/).join('.') : ''}` : String(t);
  // 只记按下、抬起、点击，行数少一点好对照；另外标出「展开全部说明」按钮的位置
  const where = () => { const b = document.querySelector('.job-head .more')?.getBoundingClientRect(); return b ? `展开按钮 x ${Math.round(b.left)}–${Math.round(b.right)}, y ${Math.round(b.top)}–${Math.round(b.bottom)}` : ''; };
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'click']) {
    addEventListener(type, (e) => {
      setTimeout(() => {
        const at = e.clientX != null ? ` @${Math.round(e.clientX)},${Math.round(e.clientY)}` : '';
        lines.push(`${new Date().toLocaleTimeString()} ${type}${e.pointerType ? ` [${e.pointerType}]` : ''}${at} ${e.defaultPrevented ? '(拦下) ' : ''}${desc(e.target).slice(0, 50)}`);
        while (lines.length > 14) lines.shift();
        box.textContent = `${where()}\n${lines.join('\n')}`;
      }, 0);
    }, true);
  }
}
// Mac 外接触摸屏（设置里开启「触屏模式」才生效）：macOS 把单指当成鼠标按住拖动，页面不会滚。这里在可滚动区域按住拖动就滚动（上下、左右都行），
// 松手带一点惯性；拖过之后的那次点击吞掉，不误开卡片。输入框、代码块不接管，照常能选中文字
(() => {
  if (PROMPTER_ONLY) return;
  // 输入框里不接管（要能选字、移动光标）
  // 顶部 worker 标签按住是拖动排序，也不接管
  const SKIP = 'input, textarea, select, [contenteditable], .worker[data-id]';
  // 按在按钮、链接、设置项、代码块、提示词上也能拖动滚动，只是要多拖一段才接管：手指点按时难免挪动几像素，
  // 被当成拖动后这次点击会被吞掉。卡片、需求列表这类整块的按钮照常
  const FIRM = 'pre, code, .pblock, a, summary, label, button:not(.card):not(.job):not(.job-mini):not(.worker)';
  // 往上找所有能在这个方向滚动的容器，近的在前，最后是整页：y 上下（主区、列内、面板），x 左右（顶部 worker 一排、看板各列）
  const scrollers = (node, axis) => {
    const out = [];
    for (let n = node; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (axis === 'y' && /(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) out.push(n);
      if (axis === 'x' && /(auto|scroll)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1) out.push(n);
    }
    const page = document.scrollingElement;
    if (page && (axis === 'y' ? page.scrollHeight > page.clientHeight + 1 : page.scrollWidth > page.clientWidth + 1)) out.push(page);
    return out;
  };
  // 往 d 方向（手指移动的距离）还能滚的第一个：里层滚到头了就交给外层
  const canMove = (n, axis, d) => {
    const pos = axis === 'x' ? n.scrollLeft : n.scrollTop;
    const max = axis === 'x' ? n.scrollWidth - n.clientWidth : n.scrollHeight - n.clientHeight;
    return d < 0 ? pos < max - 1 : pos > 1;
  };
  let st = null;
  let glide = 0;
  addEventListener('pointerdown', (e) => {
    cancelAnimationFrame(glide);
    if (!touchScroll) return; // 设置里的「触屏模式」，默认关闭
    if (e.button !== 0 || e.pointerType === 'pen' || e.target.closest(SKIP)) return;
    const boxes = { x: scrollers(e.target, 'x'), y: scrollers(e.target, 'y') };
    if (boxes.x.length || boxes.y.length) st = { boxes, firm: !!e.target.closest(FIRM), id: e.pointerId, x: e.clientX, y: e.clientY, axis: null, box: null, start: 0, v: 0, last: 0, lastT: e.timeStamp };
  }, true);
  addEventListener('pointermove', (e) => {
    if (!st || e.pointerId !== st.id) return;
    const dx = e.clientX - st.x;
    const dy = e.clientY - st.y;
    if (!st.axis) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < (st.firm ? 16 : 8)) return;
      // 按先动的方向定：横着拖滚左右，竖着拖滚上下；这个方向没有可滚的就不接管
      st.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      const list = st.boxes[st.axis];
      st.box = list.find((n) => canMove(n, st.axis, st.axis === 'x' ? dx : dy)) ?? list[0];
      if (!st.box) { st = null; return; }
      st.start = st.axis === 'x' ? st.box.scrollLeft : st.box.scrollTop;
      st.last = st.axis === 'x' ? e.clientX : e.clientY;
      document.documentElement.classList.add('drag-scrolling');
      getSelection()?.removeAllRanges();
    }
    const pos = st.axis === 'x' ? e.clientX : e.clientY;
    const d = st.axis === 'x' ? dx : dy;
    if (st.axis === 'x') st.box.scrollLeft = st.start - d; else st.box.scrollTop = st.start - d;
    const dt = e.timeStamp - st.lastT;
    if (dt > 0) st.v = (pos - st.last) / dt;
    st.last = pos;
    st.lastT = e.timeStamp;
    e.preventDefault();
  }, true);
  const end = () => {
    if (st?.box) {
      document.documentElement.classList.remove('drag-scrolling');
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', swallow, true), 0);
      // 惯性：按松手前的速度继续滚，逐渐减速
      const { box, axis } = st;
      let v = st.v * 16;
      let last = performance.now();
      const step = (now) => {
        const k = (now - last) / 16;
        last = now;
        if (axis === 'x') box.scrollLeft -= v * k; else box.scrollTop -= v * k;
        v *= Math.pow(0.94, k);
        if (Math.abs(v) > 0.3) glide = requestAnimationFrame(step);
      };
      if (Math.abs(v) > 1) glide = requestAnimationFrame(step);
    }
    st = null;
  };
  addEventListener('pointerup', end, true);
  addEventListener('pointercancel', end, true);
  // 长按卡片 = 右键菜单（触屏没有右键）。手指一动、松开就取消；打开菜单后吞掉松手时的那次点击
  let press = 0;
  addEventListener('pointerdown', (e) => {
    clearTimeout(press);
    if (!touchScroll || e.button !== 0) return;
    const c = e.target.closest('.card[data-id], .demo-row[data-id], .job[data-job], .job-mini[data-job]');
    if (!c) return;
    const { clientX: x, clientY: y } = e;
    press = setTimeout(() => {
      st = null;
      if (c.dataset.id) openCardMenu(c.dataset.id, x, y); else openJobMenu(c.dataset.job, x, y);
      const swallow = (ev) => { if (!ev.target.closest('#card-menu')) { ev.stopPropagation(); ev.preventDefault(); } };
      addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', swallow, true), 400);
    }, 550);
  }, true);
  const unpress = () => clearTimeout(press);
  addEventListener('pointerup', unpress, true);
  addEventListener('pointercancel', unpress, true);
  addEventListener('pointermove', (e) => { if (st?.axis) unpress(); }, true);
})();
