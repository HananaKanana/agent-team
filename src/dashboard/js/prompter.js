'use strict';
// 提词：卡片下方提词条、弹出的提词小窗和悬浮窗

// 提词小窗：单独的浏览器小窗口，打开就放到屏幕最下方，像字幕条；可以拖到第二块屏幕
// ?prompter（不带卡号）跟随当前在跑的演播卡：Safari「添加到程序坞」做成网页 App 后一直用这一个
const PROMPTER_PARAMS = new URLSearchParams(location.search);
const PROMPTER_ONLY = PROMPTER_PARAMS.has('prompter') ? PROMPTER_PARAMS.get('prompter') || 'auto' : null;
// &native：在 macOS 提词悬浮窗（src/prompter.jxa）里，顶部留出拖动条，关闭走服务
const PROMPTER_NATIVE = PROMPTER_PARAMS.has('native');
if (PROMPTER_NATIVE) document.documentElement.classList.add('prompter-native');
const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent);
if (PROMPTER_ONLY) document.documentElement.classList.add('prompter-only');
function openPrompter(t) {
  const w = Math.min(1200, screen.availWidth - 40);
  const h = 190;
  const left = (screen.availLeft ?? 0) + Math.round((screen.availWidth - w) / 2);
  const top = (screen.availTop ?? 0) + screen.availHeight - h - 8;
  // macOS：让服务开系统悬浮窗（没有浏览器边框、浮在最上层）；开不了再用普通弹窗
  if (IS_MAC) {
    fetch('/api/prompter/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then((r) => r.json()).catch(() => ({ ok: false }))
      .then((r) => { if (!r.ok) popupPrompter(t, w, h, left, top); });
    return;
  }
  popupPrompter(t, w, h, left, top);
}
function popupPrompter(t, w, h, left, top) {
  const win = window.open(`/?prompter=${encodeURIComponent(t.id)}`, 'ateam-prompter', `popup,width=${w},height=${h},left=${left},top=${top}`);
  win?.focus();
}
function stepsBar(t) {
  const s = t.demoStep;
  if (!s?.total) return null;
  const slow = new Set(t.runs?.[t.runs.length - 1]?.slowSteps || []);
  const only = runSteps(t);
  const scene = sceneOf(t);
  return el('div', { class: 'steps-bar', title: `第 ${s.n}/${s.total} 步${scene ? `，${scene}（虚线格为本场跳过的步骤）` : ''}` }, Array.from({ length: s.total }, (_, i) => {
    const n = i + 1;
    if (only && !only.includes(n)) return el('span', { class: 'skip' });
    return el('span', { class: slow.has(n) && n <= s.n ? 'slow' : n < s.n ? 'done' : n === s.n ? 'now' : '' });
  }));
}
function prompter(t) {
  const c = cueOf(t);
  return el('div', { class: 'prompter', onclick: (e) => e.stopPropagation() },
    el('div', { class: 'head' }, el('b', null, c.head), runSince(t), t.demoStep?.slow ? el('span', { class: 'tag warn', title: '按操作记录未能完成此步，worker 正在自行探索，可能停顿数秒' }, '慢档') : null, pausedTag(t), t.stopRequested ? el('span', { class: 'tag warn' }, '已叫停') : null),
    el('div', { class: 'say' }, c.say),
    stepsBar(t),
    el('button', { class: 'btn sm pop', title: '打开字幕窗口，显示在屏幕底部，可拖至副屏', onclick: (e) => { e.stopPropagation(); openPrompter(t); } }, icon('popout'), '弹出提词'));
}
// 悬浮窗的偏好：置顶、字号、背景浓淡，和其他显示偏好存在一起（prefs）。
// 置顶和关闭要窗口自己做：写进地址的 #pin=0/1、#close=1，src/prompter.jxa 每 0.3 秒读一次
const promptPrefs = (() => {
  const d = { pin: true, scale: 1, alpha: 0.58 };
  try { return { ...d, ...JSON.parse(prefs.get('ateam-prompter-prefs') || '{}') }; } catch { return d; }
})();
function applyPromptPrefs(extra = '') {
  const root = document.documentElement.style;
  root.setProperty('--p-scale', promptPrefs.scale);
  root.setProperty('--p-alpha', promptPrefs.alpha);
  try { prefs.set('ateam-prompter-prefs', JSON.stringify(promptPrefs)); } catch {}
  history.replaceState(null, '', `${location.pathname}${location.search}#pin=${promptPrefs.pin ? 1 : 0}${extra}`);
}
if (PROMPTER_NATIVE) applyPromptPrefs();
function nativeTools() {
  const set = (k, v) => { promptPrefs[k] = v; applyPromptPrefs(); renderPrompterStrip(); };
  const clamp = (v, lo, hi) => Math.round(Math.min(hi, Math.max(lo, v)) * 100) / 100;
  return [
    el('button', { class: promptPrefs.pin ? 'on' : '', title: promptPrefs.pin ? '已置顶：显示在所有窗口上方。点击取消置顶' : '未置顶：可能被其他窗口遮挡。点击置顶', onclick: () => set('pin', !promptPrefs.pin) }, icon('pin')),
    el('span', { class: 'grp' },
      el('button', { title: '缩小字号', onclick: () => set('scale', clamp(promptPrefs.scale - 0.1, 0.6, 1.8)) }, icon('text-down')),
      el('button', { title: '放大字号', onclick: () => set('scale', clamp(promptPrefs.scale + 0.1, 0.6, 1.8)) }, icon('text-up'))),
    el('span', { class: 'grp' },
      el('button', { title: '降低背景不透明度', onclick: () => set('alpha', clamp(promptPrefs.alpha - 0.15, 0, 0.95)) }, icon('bg-less')),
      el('button', { title: '提高背景不透明度', onclick: () => set('alpha', clamp(promptPrefs.alpha + 0.15, 0, 0.95)) }, icon('bg-more'))),
    el('button', { title: '关闭提词窗', onclick: () => applyPromptPrefs('&close=1') }, icon('close')),
  ];
}
// 小窗里的内容：演播没在进行时也留着窗口，显示等待；下次开始自动接上
function renderPrompterStrip() {
  const box = document.getElementById('prompter-strip');
  const tasks = data?.state.tasks || [];
  const t = PROMPTER_ONLY === 'auto'
    ? tasks.find((x) => isDemoTask(x) && x.status === 'demoing') || tasks.find((x) => isDemoTask(x) && (x.status === 'queued' || x.status === 'wrapping'))
    : tasks.find((x) => x.id === PROMPTER_ONLY);
  document.title = t ? `提词 · ${t.title}` : '提词';
  // 暂停 / 继续放在右上角控制键的最前面；原生悬浮窗里是图标按钮
  const canPause = t?.status === 'demoing' && !t.stopRequested;
  const pause = !canPause ? null : PROMPTER_NATIVE
    ? el('button', { class: `pz${t.paused ? ' on' : ''}`, title: t.paused ? '已暂停。点击继续执行下一步' : '暂停：当前步骤完成后暂停', onclick: () => demoAction(t.paused ? 'resume' : 'pause', t) }, icon(t.paused ? 'play' : 'pause'))
    : pauseButton(t, 'strip-pause');
  const tools = el('span', { class: 'tools' }, pause, PROMPTER_NATIVE ? nativeTools() : [
    el('button', { onclick: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()) }, '全屏'),
    el('button', { onclick: () => window.close() }, '关闭')]);
  if (!t || t.status !== 'demoing') {
    const why = !t ? (PROMPTER_ONLY === 'auto' ? '当前没有进行中的预演或演播，开始后将自动显示' : `未找到 ${PROMPTER_ONLY}`) : t.status === 'queued' ? '等待 worker 开始…' : t.status === 'wrapping' ? '已结束，worker 正在收尾' : '尚未开始，在调度台点击开始后将自动显示';
    fill(box, el('div', { class: 'head' }, el('b', null, t ? t.title : '提词'), tools), el('div', { class: 'idle' }, why));
    return;
  }
  const c = cueOf(t);
  const s = t.demoStep;
  // 只在换步时播一次淡入，轮询重绘不重播
  const stepKey = s ? `${s.n}|${s.ts}` : '';
  const changed = stepKey !== lastStripStep;
  lastStripStep = stepKey;
  fill(box,
    s?.total ? el('div', { class: 'bar' }, el('i', { style: `width:${Math.round((runSteps(t) ? (runSteps(t).indexOf(s.n) + 1) / runSteps(t).length : s.n / s.total) * 100)}%` })) : null,
    el('div', { class: 'head' },
      s ? el('span', { class: 'count' }, String(s.n), el('small', null, `/${s.total}`)) : null,
      sceneOf(t) ? el('span', { class: 'scene' }, sceneOf(t)) : null,
      el('b', null, s ? s.text : c.head), runSince(t),
      s?.slow ? el('span', { class: 'tag warn' }, '慢档') : null, pausedTag(t), t.stopRequested ? el('span', { class: 'tag warn' }, '已叫停') : null, tools),
    el('div', { class: `say${changed ? ' enter' : ''}` }, c.say),
    c.next ? el('div', { class: 'next' }, el('span', { class: 'lbl' }, '下一步'), el('span', null, c.next)) : null);
  fitSay();
}
// 讲解放不下时一像素一像素缩小字号（最小 11px），保证整句都看得到；字号上限就是 CSS 里的大小（含 A−/A+）。
// A−/A+ 只放大讲解，上下两行固定 12px，否则放大会挤占讲解的高度、讲解反而被缩小
function fitSay() {
  const say = document.querySelector('#prompter-strip .say');
  if (!say) return;
  say.style.fontSize = '';
  let size = parseFloat(getComputedStyle(say).fontSize);
  while (size > 11 && say.scrollHeight > say.clientHeight + 1) { size -= 1; say.style.fontSize = `${size}px`; }
}
if (PROMPTER_ONLY) addEventListener('resize', fitSay);
if (PROMPTER_NATIVE) {
  const strip = document.getElementById('prompter-strip');
  let hideTimer = null;
  const hide = () => strip.classList.remove('show-tools');
  const show = () => { strip.classList.add('show-tools'); clearTimeout(hideTimer); hideTimer = setTimeout(hide, 2500); };
  strip.addEventListener('mousemove', show);
  strip.addEventListener('mousedown', show);
  strip.addEventListener('mouseleave', () => { clearTimeout(hideTimer); hide(); });
}
let lastStripStep = null;
function demoRow(t) {
  const [label, color] = DEMO_STATUS[t.status] || [t.status, 'pending'];
  const runs = t.runs || [];
  const last = runs[runs.length - 1];
  const progress = demoProgress(t);
  const open = () => { view.task = t.id; saveView(); renderDrawer(true); };
  // 行里有按钮，行本身不能也是 button：用可聚焦的 div
  return el('div', {
    class: 'demo-row', 'data-id': t.id, role: 'button', tabindex: '0', title: `${t.id} ${t.title}`,
    onclick: open, onkeydown: (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } },
    // 右键：和看板上的卡一样，有打开详情、收回、作废、复制
    oncontextmenu: (e) => { e.preventDefault(); getSelection()?.removeAllRanges(); openCardMenu(t.id, e.clientX, e.clientY); },
  },
    el('div', null,
      el('div', { class: 't' }, el('span', { class: 'key' }, t.id), t.title,
        el('span', { class: `lozenge c-${color}` }, t.status === 'demoing' ? `${modeWord(t)}中` : label), t.status === 'ready' ? rehearsalTag(t) : null),
      el('div', { class: 'meta' },
        el('code', null, t.script),
        el('span', null, `已运行 ${runs.length} 次`),
        last ? el('span', null, `上次 ${fmtTime(last.startedAt)} ${RUN_MODE[last.mode] || '演播'}${RUN_OUTCOME[last.outcome] || '进行中'}`) : null,
        t.status === 'ready' && t.mayChange ? el('span', null, '页面可能有变动，建议先重新预演') : null,
        t.rehearsedAt && opsCache.get(t.id)?.viewport ? el('span', { title: '预演时录制的视口；演播时 worker 将浏览器调整至该尺寸' }, `视口 ${opsCache.get(t.id).viewport}`) : null,
        t.status === 'ready' && opsCache.get(t.id)?.legacy ? el('span', { class: 'warn-text' }, '操作记录为旧格式（基于坐标），请重新预演') : null,
        t.assignTo && t.status === 'ready' ? el('span', null, `指派 ${agentName(t.assignTo)}`) : null)),
    el('div', { class: 'demo-acts' }, demoButton(t)),
    t.status === 'demoing' ? prompter(t) : progress ? el('div', { class: 'step' }, progress) : null,
    demoError?.id === t.id ? el('div', { class: 'step hint' }, demoError.message) : null);
}
function renderDemoBanner() {
  const box = document.getElementById('demo-banner');
  const t = data && frozenDemo();
  // 正在看这个演播需求时，卡上已经有完整的进度和停止按钮，不再重复横幅
  const key = t && `demo:${t.id}:${t.runs?.length ?? 0}:${t.status}`;
  if (!t || (view.job === t.jobId && !view.report) || toastClosed.has(key)) { box.hidden = true; box.replaceChildren(); return; }
  fill(box,
    el('b', null, t.status === 'queued' ? `等待 worker 开始${modeWord(t)}：${t.title}` : `${modeWord(t)}中：${t.title}`),
    el('span', null, '派发已暂停'),
    t.status === 'demoing' ? el('span', { class: 'step' }, t.demoStep ? `第 ${t.demoStep.n}/${t.demoStep.total} 步：${cueOf(t).say}` : '准备中') : null,
    el('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); view = { job: t.jobId, task: null, report: false }; saveView(); render(); } }, '查看'),
    t.status === 'demoing' && !t.stopRequested ? pauseButton(t, 'btn sm') : null,
    el('button', { class: 'btn warn sm', onclick: (e) => { e.stopPropagation(); demoAction('stop', t); } }, `停止${modeWord(t)}`),
    toastX(() => { toastClosed.add(key); renderDemoBanner(); }));
  box.hidden = false;
}
