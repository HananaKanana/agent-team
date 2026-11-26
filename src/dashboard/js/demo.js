// 演播卡：开始 / 预演弹框、步骤进度、抽屉里的演播详情和脚本大纲

import { data, RUN_MODE, RUN_OUTCOME, view } from './state.js';
import { agentName, el, fill, fmtTime, icon, modalHead, renderMarkdown, tickSince } from './util.js';
import { renderMain } from './jobs.js';
import { assignBox, reclaimBox, renderDrawer } from './drawer.js';
import { poll, render } from './app.js';

const VIEWPORT_PRESETS = [['1280x720', ['1280×720', '小屏']], ['1600x800', ['1600×800', '默认']], ['1920x1080', ['1920×1080', '1K']], ['2560x1440', ['2560×1440', '2K']]];

export const isDemoTask = (t) => t.kind === 'demo';
// 造成「派发暂停」的演播卡：等 worker 领的，或正在演播、没被叫停的（与服务端 demoFrozen 一致）
export const frozenDemo = () => data.state.tasks.find((t) => isDemoTask(t) && (t.status === 'queued' || (t.status === 'demoing' && !t.stopRequested)));
export let demoError = null; // { id, message }
export async function demoAction(kind, t, mode, steps, viewport) {
  try {
    const res = await fetch(`/api/demo/${kind}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: t.id, mode, ...(steps ? { steps } : {}), ...(viewport ? { viewport } : {}) }) });
    const out = await res.json();
    demoError = out.ok ? null : { id: t.id, message: out.message };
  } catch { demoError = { id: t.id, message: '无法连接 ateam 服务。' }; }
  await poll();
  render();
  return !demoError;
}
// 一场演播选中的步骤（没有 = 完整演播），和服务端 stepsLabel 同一种写法
export const runSteps = (t) => t.runs?.[t.runs.length - 1]?.steps || null;
function stepsLabel(steps) {
  if (!steps?.length) return '';
  const contiguous = steps.every((n, i) => i === 0 || n === steps[i - 1] + 1);
  return contiguous && steps.length > 1 ? `第 ${steps[0]}–${steps[steps.length - 1]} 步` : `第 ${steps.join('、')} 步`;
}
// 部分演播时当前步在本场里是第几步：「本场 2/10」
export function sceneOf(t) {
  const steps = runSteps(t);
  const n = t.demoStep?.n;
  if (!steps || !n) return '';
  return `本场 ${steps.indexOf(n) + 1}/${steps.length}`;
}
// 「开始演播」弹窗：从头完整演播 / 从第 N 步开始 / 只演选中的几步。预演不弹（预演总是完整走）
export let showDlg = null; // { id, pick: 'all' | 'from' | 'some', from, some: Set, error, resume }
function openShowDialog(t) {
  const last = t.runs?.[t.runs.length - 1];
  const resume = last && (last.outcome === 'interrupted' || last.outcome === 'stopped') && last.lastStep ? last.lastStep : null;
  showDlg = { id: t.id, pick: resume ? 'from' : 'all', from: resume || 1, some: new Set(), error: null, resume };
  renderShowDialog();
}
// 预演前选视口：默认这张卡上次录的尺寸，没有就用上次预演选的
function openRehearsalDialog(t) {
  const vp = opsCache.get(t.id)?.viewport || data.config?.demoViewport || '1600x800';
  const preset = VIEWPORT_PRESETS.some(([v]) => v === vp);
  showDlg = { id: t.id, kind: 'rehearsal', pick: preset ? vp : 'custom', custom: vp, error: null };
  renderShowDialog();
}
export function closeShowDialog() { showDlg = null; renderShowDialog(); }
function renderRehearsalDialog(box, t) {
  const d = showDlg;
  const stop = (fn) => (e) => { e.stopPropagation(); fn(e); };
  const blockers = data.demoBlockers?.[t.id] ?? [];
  const recorded = opsCache.get(t.id)?.viewport;
  const norm = (v) => v.trim().toLowerCase().replace(/[×*\s]/g, 'x').replace(/x+/g, 'x');
  const value = d.pick === 'custom' ? norm(d.custom) : d.pick;
  const m = value.match(/^(\d{3,4})x(\d{3,4})$/);
  const valid = !!m && [m[1], m[2]].every((n) => Number(n) >= 320 && Number(n) <= 7680);
  const go = async () => {
    const ok = await demoAction('start', t, 'rehearsal', null, value);
    if (ok) closeShowDialog();
    else if (showDlg) { showDlg.error = demoError?.message || '开始失败'; renderShowDialog(); }
  };
  const opt = (v, label) => el('button', { class: `vp-opt${d.pick === v ? ' on' : ''}`, onclick: stop(() => { Object.assign(d, { pick: v, error: null }); renderShowDialog(); }) },
    el('b', null, label[0]), label[1] ? el('span', null, label[1]) : null, recorded === v ? el('em', null, '上次') : null);
  const custom = el('input', { type: 'text', class: 'vp-custom', value: d.custom, placeholder: '例如 1440x900' });
  // 点进自定义框就切到自定义；重画后把光标放回框里
  custom.addEventListener('focus', () => { if (d.pick !== 'custom') { Object.assign(d, { pick: 'custom', error: null, refocus: true }); renderShowDialog(); } });
  custom.addEventListener('input', () => { d.custom = custom.value; d.error = null; const b = box.querySelector('.modal-foot .primary'); const v = norm(custom.value).match(/^(\d{3,4})x(\d{3,4})$/); if (b) b.disabled = blockers.length > 0 || !v || ![v[1], v[2]].every((n) => Number(n) >= 320 && Number(n) <= 7680); });
  custom.addEventListener('click', (e) => e.stopPropagation());
  box.classList.toggle('again', !box.hidden);
  box.onclick = (e) => { if (e.target === box) closeShowDialog(); };
  fill(box, el('div', { class: 'modal show-modal', onclick: (e) => e.stopPropagation() },
    modalHead(`开始预演：${t.title}`, closeShowDialog),
    el('div', { class: 'modal-body' },
      el('p', { class: 'lead' }, '选择本次预演的浏览器视口。worker 开始前将浏览器调整至该尺寸并据此录制操作记录，后续演播沿用此尺寸。'),
      el('div', { class: 'vp-opts' }, VIEWPORT_PRESETS.map(([v, label]) => opt(v, label))),
      el('label', { class: `vp-custom-row${d.pick === 'custom' ? ' on' : ''}`, onclick: (e) => e.stopPropagation() },
        el('span', { class: 'vp-custom-label' }, '自定义'), custom, el('span', { class: 'hint' }, '宽x高'),
        recorded && !VIEWPORT_PRESETS.some(([v]) => v === recorded) ? el('em', null, '上次') : null),
      el('p', { class: 'hint' }, '浏览器窗口需大于视口（含标签栏、地址栏）；超出屏幕尺寸时无法调整，预演将中止。'),
      d.pick === 'custom' && d.custom && !valid ? el('p', { class: 'hint', style: 'color: var(--rework)' }, '格式为 宽x高，取值范围 320–7680。') : null,
      d.error ? el('p', { class: 'hint', style: 'color: var(--rework)' }, d.error) : null),
    el('div', { class: 'modal-foot' },
      blockers.length ? el('span', { class: 'hint' }, `暂不能开始：${blockers.join('；')}`) : null,
      el('button', { class: 'btn', onclick: stop(closeShowDialog) }, '取消'),
      el('button', { class: 'btn primary', disabled: blockers.length > 0 || !valid, onclick: stop(go) }, '开始预演'))));
  box.hidden = false;
  if (d.refocus) { d.refocus = false; custom.focus(); custom.setSelectionRange(custom.value.length, custom.value.length); }
}
export function renderShowDialog() {
  const box = document.getElementById('show-dialog');
  const t = showDlg && data?.state.tasks.find((x) => x.id === showDlg.id);
  if (!t || t.status !== 'ready') { showDlg = null; box.hidden = true; box.replaceChildren(); return; }
  if (showDlg.kind === 'rehearsal') return renderRehearsalDialog(box, t);
  const sc = loadScript(t);
  const steps = sc?.steps || [];
  const total = steps.length;
  const d = showDlg;
  const stop = (fn) => (e) => { e.stopPropagation(); fn(e); };
  const set = (patch) => { Object.assign(d, patch, { error: null }); renderShowDialog(); };
  const choice = (key, title, desc) => el('button', { class: `choice${d.pick === key ? ' on' : ''}`, onclick: stop(() => set({ pick: key })) },
    el('span', { class: 'radio' }), el('span', null, el('b', null, title), el('span', { class: 'd' }, desc)));
  const picked = d.pick === 'all' ? null
    : d.pick === 'from' ? steps.filter((st) => st.n >= d.from).map((st) => st.n)
    : [...d.some].sort((a, b) => a - b);
  const label = d.pick === 'all' ? '开始演播'
    : d.pick === 'from' ? `从第 ${d.from} 步开始演播（${d.from}–${total}）`
    : `演播选中的 ${picked.length} 步`;
  const blockers = data.demoBlockers?.[t.id] ?? [];
  const go = async () => {
    const ok = await demoAction('start', t, 'show', picked && picked.length < total ? picked : null);
    if (ok) closeShowDialog();
    else if (showDlg) { showDlg.error = demoError?.message || '开始失败'; renderShowDialog(); }
  };
  let detail = null;
  if (!sc) detail = el('p', { class: 'hint' }, '正在读取脚本步骤…');
  else if (d.pick === 'from') {
    detail = el('select', { class: 'step-select', onchange: (e) => set({ from: Number(e.target.value) }) },
      steps.map((st) => el('option', { value: st.n, selected: st.n === d.from }, `${st.n}. ${st.text}`)));
  } else if (d.pick === 'some') {
    detail = el('div', { class: 'step-pick' },
      el('div', { class: 'pick-tools' },
        el('button', { class: 'btn ghost sm', onclick: stop(() => set({ some: new Set(steps.map((st) => st.n)) })) }, '全选'),
        el('button', { class: 'btn ghost sm', onclick: stop(() => set({ some: new Set() })) }, '全不选'),
        el('span', { class: 'hint' }, `已选 ${d.some.size} / ${total} 步`)),
      el('div', { class: 'pick-list' }, steps.map((st) => el('label', { class: d.some.has(st.n) ? 'on' : '' },
        el('input', { type: 'checkbox', checked: d.some.has(st.n), onchange: (e) => { const some = new Set(d.some); e.target.checked ? some.add(st.n) : some.delete(st.n); set({ some }); } }),
        el('span', { class: 'no' }, st.n), el('span', null, st.text)))));
  }
  // 重画会换掉整个弹窗：先记下步骤列表和正文的滚动位置，画完放回去，勾选时不跳回顶部
  const keep = ['.pick-list', '.modal-body'].map((sel) => [sel, box.querySelector(sel)?.scrollTop ?? 0]);
  box.classList.toggle('again', !box.hidden); // 已经开着时重绘不再播弹出动画
  box.onclick = (e) => { if (e.target === box) closeShowDialog(); };
  fill(box, el('div', { class: 'modal show-modal', onclick: (e) => e.stopPropagation() },
    modalHead(`开始演播：${t.title}`, closeShowDialog),
    el('div', { class: 'modal-body' },
      t.mayChange ? el('p', { class: 'lead warn-line' }, '页面可能有变动，建议先重新预演。') : null,
      el('div', { class: 'choices' },
        choice('all', '从头完整演播', `从第 1 步演到第 ${total || '…'} 步。`),
        choice('from', d.resume ? `从第 ${d.resume} 步继续` : '从第 N 步开始', d.resume ? '上一场在此中断，从该步演播至最后一步。' : '从所选步骤演播至最后一步。'),
        choice('some', '只演选中的几步', '只演勾选的步骤，其余跳过。')),
      detail,
      d.pick !== 'all' ? el('p', { class: 'hint' }, '跳过的步骤不会补执行，其所需的数据和页面状态须已存在（例如上一场遗留）。未执行到最后一步时，结束后不清理数据。') : null,
      d.error ? el('p', { class: 'hint', style: 'color: var(--rework)' }, d.error) : null),
    el('div', { class: 'modal-foot' },
      blockers.length ? el('span', { class: 'hint' }, `暂不能开始：${blockers.join('；')}`) : null,
      el('button', { class: 'btn', onclick: stop(closeShowDialog) }, '取消'),
      el('button', { class: 'btn primary', disabled: !sc || blockers.length > 0 || (picked && !picked.length), onclick: stop(go) }, label))));
  box.hidden = false;
  for (const [sel, top] of keep) { const n = box.querySelector(sel); if (n) n.scrollTop = top; }
}
const runMode = (t) => t.runs?.[t.runs.length - 1]?.mode ?? 'show';
export const modeWord = (t) => (t.status === 'queued' ? t.pendingMode : runMode(t)) === 'rehearsal' ? '预演' : '演播';
// 预演状态：未预演 / 已预演 / 页面可能有变动
export function rehearsalTag(t) {
  if (!t.rehearsedAt) return el('span', { class: 'lozenge c-pending', title: '尚未完成预演，需先预演' }, '未预演');
  if (t.mayChange) return el('span', { class: 'lozenge c-asking', title: `${fmtTime(t.rehearsedAt)} 预演后有新代码通过 review，建议重新预演` }, '页面可能有变动');
  return el('span', { class: 'lozenge c-approved', title: `${fmtTime(t.rehearsedAt)} 预演` }, '已预演');
}
export function demoButton(t) {
  const stop = (e) => e.stopPropagation();
  // Windows 版不支持预演和演播（提词悬浮窗、窗口控制只有 Mac 版）
  if (t.status === 'ready' && data.platform === 'win32') return el('span', { class: 'lozenge c-pending', title: '请在 Mac 上运行 ateam 预演和演播这张卡' }, 'Windows 版不支持演播');
  if (t.status === 'ready') {
    const blockers = data.demoBlockers?.[t.id] ?? [];
    // 旧的按坐标录的操作记录：只能重新预演
    const legacy = !!opsCache.get(t.id)?.legacy;
    const why = blockers.join('；');
    const start = (mode, label, primary, tip) => el('button', {
      class: `btn${primary ? ' primary' : ''}`, disabled: blockers.length > 0 || (mode === 'show' && legacy),
      title: why || (mode === 'show' && legacy ? '操作记录为旧格式（基于坐标），请先重新预演' : tip),
      onclick: (e) => { stop(e); if (mode === 'show') openShowDialog(t); else openRehearsalDialog(t); },
    }, label);
    if (!t.rehearsedAt) return start('rehearsal', '开始预演', true, '逐步执行并录制操作记录；开始后暂停派发');
    if (legacy) return [start('rehearsal', '重新预演', true, '操作记录为旧格式（基于坐标），需按新格式重新录制'), start('show', '开始演播', false, '')];
    return [
      start('show', '开始演播', true, t.mayChange ? '页面可能有变动，建议先重新预演' : '按操作记录快速执行；开始后暂停派发'),
      start('rehearsal', '重新预演', false, '重新执行并校正操作记录'),
    ];
  }
  if (t.status === 'demoing' && !t.stopRequested) {
    return [pauseButton(t, 'btn'), el('button', { class: 'btn warn', onclick: (e) => { stop(e); demoAction('stop', t); } }, `停止${modeWord(t)}`)];
  }
  if (t.status === 'queued') {
    return el('button', { class: 'btn warn', onclick: (e) => { stop(e); demoAction('stop', t); } }, `停止${modeWord(t)}`);
  }
  // 收尾中（或老数据里叫停了还停在演播中）：worker 迟迟不收尾时，用户可以直接结束
  if (t.status === 'wrapping' || (t.status === 'demoing' && t.stopRequested)) {
    return el('button', { class: 'btn', title: `不再等待 ${agentName(t.assignee)} 收尾，演播卡直接回到待演播（本次未提交的操作记录不保存）`, onclick: (e) => { stop(e); demoAction('release', t); } }, '结束收尾');
  }
  return null;
}
// 当前进行到哪一步 + 已演播多久（演播中）；等 worker 领（等待开始）；收尾中
export function demoProgress(t) {
  if (t.status === 'queued') return el('span', null, `等待 ${t.role} worker 领取…`);
  if (t.status === 'wrapping') return el('span', null, `${agentName(t.assignee)} 正在收尾：清理数据、写入操作记录`);
  if (t.status !== 'demoing') return null;
  const run = t.runs?.[t.runs.length - 1];
  const since = run ? el('span', { class: 'since', title: '已演播时长', 'data-since': run.startedAt }, icon('clock'), el('span')) : null;
  if (since) tickSince(since);
  const step = t.demoStep ? [el('b', null, `第 ${t.demoStep.n}/${t.demoStep.total} 步`), ' ', t.demoStep.text] : '准备中';
  return [el('span', null, step), ' ', since, pausedTag(t), t.stopRequested ? el('span', { class: 'tag warn' }, '已叫停') : null];
}
// 暂停 / 继续：worker 做完当前这一步后停住，点继续接着做下一步
export function pauseButton(t, cls) {
  const paused = !!t.paused;
  return el('button', {
    class: `${cls} pause-btn`, title: paused ? '继续执行下一步' : '当前步骤完成后暂停，浏览器停留在当前页面，便于讲解与答疑',
    onclick: (e) => { e.stopPropagation(); demoAction(paused ? 'resume' : 'pause', t); },
  }, icon(paused ? 'play' : 'pause'), paused ? '继续' : '暂停');
}
export function pausedTag(t) {
  if (!t.paused) return null;
  const s = t.demoStep;
  const waiting = s && t.paused.afterStep === s.n ? '当前步骤完成后暂停' : '已暂停';
  return el('span', { class: 'tag paused', title: `暂停中：${waiting}。点击「继续」执行下一步` }, '已暂停');
}
// 提词：这一步的讲解（没写就用这一步做什么）、下一步预告
export function cueOf(t) {
  const s = t.demoStep;
  if (!s) return { head: '准备中', say: '即将开始第 1 步', next: '' };
  const scene = sceneOf(t);
  return { head: `第 ${s.n}/${s.total} 步${scene ? `（${scene}）` : ''} · ${s.text}`, say: s.cue?.narration || s.text, next: s.cue?.next || '' };
}
export function runSince(t) {
  const run = t.runs?.[t.runs.length - 1];
  if (!run) return null;
  const n = el('span', { class: 'since', title: '已演播时长', 'data-since': run.startedAt }, icon('clock'), el('span'));
  tickSince(n);
  return n;
}
export function demoDrawerBody(t) {
  const progress = demoProgress(t);
  return [
    el('div', { class: 'prompt' }, demoButton(t), progress ? el('span', { class: 'hint' }, progress) : null),
    demoError?.id === t.id ? el('p', { class: 'hint' }, demoError.message) : null,
    t.status === 'ready' ? assignBox(t) : null,
    (t.status === 'demoing' || t.status === 'wrapping') && t.assignee ? reclaimBox(t) : null,
    el('p', { class: 'hint' }, '操作记录、运行记录和脚本步骤请在演播需求页查看；此处用于指派、收回及查看时间线。'),
  ];
}
// 脚本缓存：演播需求页的步骤大纲、操作记录面板用
export const opsCache = new Map(); // taskId -> { key, html | error }
// 卡的 token 用量（Claude Code、DeepSeek Harness 的会话记录）：打开卡时读，卡状态变了重读，进行中的卡最多 30 秒重读一次
const tokenCache = new Map(); // taskId -> { key, at, value, loading }
function loadTokens(t) {
  const key = `${t.status}:${t.history.length}:${'tokens' in t}`;
  const hit = tokenCache.get(t.id);
  const stale = !hit || hit.key !== key || (t.status !== 'approved' && Date.now() - hit.at > 30000);
  if (stale && !hit?.loading) {
    tokenCache.set(t.id, { ...(hit || {}), key, at: Date.now(), loading: true });
    fetch(`/api/task-tokens?id=${encodeURIComponent(t.id)}`, { cache: 'no-store' }).then((r) => r.json())
      .then((out) => tokenCache.set(t.id, { key, at: Date.now(), value: out.ok ? out.tokens : { error: true } }))
      .catch(() => tokenCache.set(t.id, { key, at: Date.now(), value: { error: true } }))
      .then(() => { if (view.task === t.id) renderDrawer(false); });
  }
  return hit && 'value' in hit ? hit.value : undefined;
}
export const fmtTokens = (n) => (n >= 1e8 ? `${(n / 1e8).toFixed(2)} 亿` : n >= 1e4 ? `${(n / 1e4).toFixed(1)} 万` : String(n));
// 详情里的「Token」一行；卡还没人领过时不显示
export function tokenFact(t, fact) {
  if (!t.history.some((h) => h.type === 'claimed')) return null;
  const v = loadTokens(t);
  if (v === undefined) return fact('Token', el('span', { class: 'hint' }, '统计中…'));
  if (v.none) return null;
  if (v.error) return fact('Token', el('span', { class: 'hint' }, '读取失败'));
  if (v.unavailable) return fact('Token', el('span', { class: 'hint', title: 'WorkBuddy 的会话保存在云端，本机没有 token 记录；本机也找不到这张卡的 Claude Code 或 DeepSeek Harness 会话记录。' }, '无数据'));
  const total = v.input + v.cacheRead + v.output;
  return fact('Token', el('span', { class: 'tokens', title: `模型调用 ${v.calls} 次。缓存命中的输入按低价计费。${v.missing ? `有 ${v.missing} 个会话在本机找不到记录，未计入。` : ''}` },
    el('b', null, `共 ${fmtTokens(total)}`),
    v.heavy ? el('span', { class: 'heavy-tag', title: '超过同角色已通过卡用量中位数的倍数，详见需求栏底部「用量」' }, `用量偏高 ${v.heavy} 倍`) : null,
    el('span', { class: 'hint' }, ` 输入 ${fmtTokens(v.input)} · 缓存命中 ${fmtTokens(v.cacheRead)} · 输出 ${fmtTokens(v.output)} · 调用 ${v.calls} 次${v.live ? '（进行中，实时统计）' : ''}`)));
}
// 操作记录里某一步的那一条（「### 3. ...」到下一个「### 」之前）
function opsForStep(raw, n) {
  const parts = String(raw || '').split(/^(?=###\s)/m);
  return parts.find((p) => new RegExp(`^###\\s*${n}[.、\\s]`).test(p)) || '';
}
// 左栏卡片下面：运行中是「下一步」「这一步怎么操作」；没在运行是「操作记录概况」。最下面是运行记录
export function stagePanels(t) {
  const sc = loadScript(t);
  const steps = sc?.steps || [];
  const running = t.status === 'demoing' && t.demoStep;
  const cur = running ? t.demoStep.n : 0;
  const next = steps.find((st) => st.n === cur + 1);
  const opsHtml = (md) => { const d = el('div', { class: 'md' }); d.innerHTML = renderMarkdown(md); return d; }; // renderMarkdown 先转义了 HTML
  let top;
  if (running) {
    const op = opsForStep(sc?.raw, cur).replace(/^###[^\n]*\n?/, '').trim();
    top = el('div', { class: 'stage-grid' },
      el('section', { class: 'panel' }, el('h5', null, '下一步', next ? el('span', { class: 'hint' }, `第 ${next.n} 步`) : null),
        next ? [el('div', { class: 'big' }, next.text), next.narration ? el('div', { class: 'say' }, `讲解：${next.narration}`) : null]
          : el('div', { class: 'big' }, '这是最后一步，完成后演播结束')),
      el('section', { class: 'panel' }, el('h5', null, '本步操作', el('span', { class: 'hint' }, '来自操作记录')),
        op ? opsHtml(op) : el('div', { class: 'empty' }, modeWord(t) === '预演' ? 'worker 预演完成此步后将记录在此' : '操作记录中无此步骤，worker 正在自行探索')));
  } else {
    const written = steps.filter((st) => sc?.recorded?.has(st.n)).length;
    top = el('section', { class: 'panel' },
      el('h5', null, '操作记录', el('span', { class: 'hint' }, steps.length ? `已录 ${written} / ${steps.length} 步${sc?.viewport ? ` · 视口 ${sc.viewport}` : ''}` : '')),
      !sc ? el('div', { class: 'empty' }, '读取中…') : written ? opsHtml(sc.raw) : el('div', { class: 'empty' }, '暂无操作记录。点击「开始预演」，worker 将逐步执行并记录在此。'));
  }
  const runs = (t.runs || []).slice().reverse().slice(0, 5);
  const history = el('section', { class: 'panel' },
    el('h5', null, '运行记录', el('span', { class: 'hint' }, `共 ${(t.runs || []).length} 次${(t.runs || []).length > 5 ? '，显示最近 5 次' : ''}`)),
    runs.length ? el('table', { class: 'demo-runs' },
      el('thead', null, el('tr', null, ['开始', '类型', '执行者', '结果', '说明'].map((h) => el('th', null, h)))),
      el('tbody', null, runs.map((r) => el('tr', null,
        el('td', null, fmtTime(r.startedAt)),
        el('td', null, RUN_MODE[r.mode] || '演播'),
        el('td', null, agentName(r.by)),
        el('td', { class: r.outcome ? `r-${r.outcome}` : '' }, RUN_OUTCOME[r.outcome] || '进行中'),
        el('td', { class: 'note' }, r.steps?.length ? el('span', { class: 'only' }, r.steps.length > 1 && r.steps.every((n, i) => i === 0 || n === r.steps[i - 1] + 1) ? stepsLabel(r.steps) : `选 ${r.steps.length} 步：${r.steps.join('、')}`) : null, r.result || '—', r.slowSteps?.length ? el('div', { class: 'hint' }, `慢档：第 ${r.slowSteps.join('、')} 步`) : null))))) : el('div', { class: 'empty' }, '暂无运行记录'));
  return [top, history];
}
// 缓存键：提交、运行次数，以及当前步（预演中 worker 边走边写操作记录，每走一步重读一次脚本）
const opsKey = (t) => `${t.commits.length}:${(t.runs || []).length}:${t.status}:${t.demoStep?.ts ?? ''}`;
// 读脚本（操作记录 + 步骤列表），读完重画；返回缓存，还没读到时返回 null
function loadScript(t) {
  const key = opsKey(t);
  const hit = opsCache.get(t.id);
  if (!hit) { refetchOps(t, null); return null; }
  if (hit.key !== key && !hit.loading) refetchOps(t, hit);
  return hit.steps ? hit : null; // 重读期间返回旧数据
}
// 右栏：脚本步骤大纲。走过的灰、慢档的红、当前步高亮并展开讲解
export function stepOutline(t) {
  const sc = loadScript(t);
  const s = t.status === 'demoing' ? t.demoStep : null;
  const run = t.runs?.[t.runs.length - 1];
  const slow = new Set(run?.slowSteps || []);
  const cur = s?.n ?? 0;
  const only = t.status === 'demoing' ? runSteps(t) : null;
  const recCount = sc ? sc.steps.filter((st) => sc.recorded?.has(st.n)).length : 0;
  const head = el('h4', null, '脚本步骤', el('span', { class: 'hint', title: '已录：操作记录中有有效的动作块，演播时可直接回放' }, sc ? `共 ${sc.steps.length} 步 · 已录 ${recCount}` : ''),
    sc && recCount < sc.steps.length ? el('span', { class: 'hint legend', title: '编号带红色虚线圈的步骤尚未录制动作块' }, el('i'), '未录') : null);
  if (!sc) return el('aside', { class: 'outline' }, head, el('div', { class: 'empty' }, '读取中…'));
  if (sc.error && !sc.steps.length) return el('aside', { class: 'outline' }, head, el('div', { class: 'empty' }, sc.error));
  if (!sc.steps.length) return el('aside', { class: 'outline' }, head, el('div', { class: 'empty' }, '脚本中未找到「## 演示步骤」'));
  return el('aside', { class: 'outline' }, head, el('ol', null, sc.steps.map((st) => {
    const rec = sc.recorded?.has(st.n);
    const skip = only && !only.includes(st.n);
    const cls = [skip ? 'skip' : '', !skip && st.n < cur ? 'done' : '', st.n === cur ? 'now' : '', slow.has(st.n) && (cur ? st.n <= cur : true) ? 'slow' : '', rec ? '' : 'unrec'].filter(Boolean).join(' ');
    return el('li', { class: cls, 'data-n': st.n, title: rec ? '已录动作块，演播时直接回放' : '尚未录制动作块，演播至此步时速度较慢' },
      el('span', { class: 'no' }, st.n < cur && !slow.has(st.n) && !skip ? '✓' : st.n),
      el('div', null, el('div', { class: 'what' }, st.text, skip ? el('span', { class: 'skip-tag' }, '本场跳过') : null),
        st.narration && (st.n === cur || !cur) ? el('div', { class: 'say' }, st.narration) : null));
  })));
}
// 读脚本：操作记录 + 步骤列表。prev 是旧数据，读的时候先留着，读完再换
function refetchOps(t, prev) {
  const key = opsKey(t);
  {
    opsCache.set(t.id, { ...(prev || {}), key, loading: true });
    fetch(`/api/demo/ops?id=${encodeURIComponent(t.id)}`).then((r) => r.json()).then((out) => {
      const ops = (out.ops || '').replace(/<!--[\s\S]*?-->/g, '').trim();
      opsCache.set(t.id, { key, raw: ops, html: ops ? renderMarkdown(ops) : '', steps: out.steps || [], recorded: new Set(out.recorded || []), viewport: out.viewport || null, legacy: !!out.legacy, error: out.ok ? out.error : out.message });
    }).catch(() => opsCache.set(t.id, { ...(prev || {}), key, steps: prev?.steps || [], error: '无法连接 ateam 服务。' })).then(() => { if (view.task === t.id) renderDrawer(false); if (view.job === t.jobId) renderMain(); if (showDlg?.id === t.id) renderShowDialog(); });
  }
}
