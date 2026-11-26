// 需求页：说明、验收按钮、概览（数字、角色进度、动态）、已作废的卡

import { prefs } from './prefs.js';
import { data, HISTORY, JOB_STATUS, LANES, view } from './state.js';
import {
  agentName, avatar, dur, el, emptyState, fill, fmtTime, icon, laneOf, renderMarkdown, reviewStats,
  roleStyle, strip
} from './util.js';
import { slimLanes } from './settings.js';
import { openGuide } from './helper.js';
import { approvedAt, card, clipCardTags } from './card.js';
import { fmtTokens, stagePanels, stepOutline } from './demo.js';
import { demoRow } from './prompter.js';
import { openUsage, usageForJob } from './usage.js';
import { holdAction, renderDrawer } from './drawer.js';
import { resetRelated } from './search.js';
import { openReport } from './report.js';
import { poll, render, saveView } from './app.js';

const JOB_LOZENGE = { planning: 'pending', active: 'working', awaiting_acceptance: 'asking', accepted: 'approved', cancelled: 'cancelled' };
let descOpenJob = null; // 展开了说明的需求
let acceptArm = null; // 「验收通过」两步确认：记需求编号
let lastOutlineStep = null;

export async function acceptJob(id) {
  try {
    await fetch('/api/jobs/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id] }) });
  } catch {}
  acceptArm = null;
  await poll();
}
// 待验收需求的「验收通过」按钮，点两次生效
export function acceptButtons(job) {
  if (job.status !== 'awaiting_acceptance') return null;
  if (acceptArm !== job.id) {
    return el('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); acceptArm = job.id; render(); } }, '验收通过');
  }
  return [
    el('button', { class: 'btn ghost', onclick: (e) => { e.stopPropagation(); acceptArm = null; render(); } }, '取消'),
    el('button', { class: 'btn primary', onclick: (e) => { e.stopPropagation(); acceptJob(job.id); } }, `确认 ${job.id} 验收通过`),
  ];
}
export const ACCEPT_HINT = '测试无误后点击「验收通过」；如有问题，请在对话中向 leader 说明，leader 将在该需求下新增修复任务。';
export function renderMain() {
  resetRelated();
  requestAnimationFrame(clipCardTags); // 画完再量标签有没有溢出
  const main = document.getElementById('main');
  const job = data.state.jobs.find((j) => j.id === view.job);
  // 已作废的需求：代码还在、但需求不算了。卡片状态照实保留，整页置灰、卡片标题划掉
  main.classList.toggle('job-dropped', job?.status === 'cancelled');
  if (!job) {
    main.removeAttribute('aria-busy');
    fill(main, data.state.jobs.length
      ? emptyState('pointer', '选择需求', '在左侧选择需求以查看任务看板。')
      : emptyState('inbox', '等待 leader 创建需求',
        data.leader?.online ? 'leader 已在线，请在其对话中描述需求，例如「需求是……」。' : '请先启动 leader：在项目目录中新建 Claude Code 会话，发送 leader 加入提示词，再描述需求。',
        data.leader?.online ? null : openGuide('lead')));
    return;
  }
  const all = data.state.tasks.filter((t) => t.jobId === job.id);
  const tasks = all.filter((t) => t.status !== 'cancelled');
  const cancelled = all.filter((t) => t.status === 'cancelled');
  // 说明较长时默认收起几行，可以展开
  const longDesc = (job.description || '').length > 160 || (job.description || '').split('\n').length > 3;
  const descOpen = descOpenJob === job.id;
  const headMain = [
    el('div', { class: 'crumbs' }, `需求 / ${job.id}`,
      job.demo ? null : el('span', { class: `lozenge c-${JOB_LOZENGE[job.status] || 'pending'}` }, JOB_STATUS[job.status] || job.status)),
    el('h2', { class: `job-title${job.status === 'cancelled' ? ' dropped' : ''}` }, job.title),
    job.demo ? el('div', { class: 'head-acts' }, el('span', { class: 'lozenge c-held' }, '演播需求')) : null,
    job.onHold && job.status !== 'cancelled' ? el('div', { class: 'job-cancelled job-hold' },
      `${fmtTime(job.onHold.at)} ${job.onHold.by === 'user' ? '用户' : 'leader'}已暂停领取${job.onHold.reason ? `：${job.onHold.reason}` : ''}。待领取的任务暂不派发，进行中的任务不受影响。`,
      el('button', { class: 'link-btn', onclick: (e) => { e.stopPropagation(); holdAction('jobs', job.id, false); } }, '恢复领取')) : null,
    job.status === 'cancelled' ? el('div', { class: 'job-cancelled' },
      `${job.cancelledAt ? fmtTime(job.cancelledAt) + ' ' : ''}作废${job.cancelReason ? `：${job.cancelReason}` : ''}。已通过的任务及代码保留，未完成的任务已作废。`) : null,
    // 说明和「展开」放一组：宽屏上下排（desc-row 是 display: contents）；窄屏收起时只露一行，「展开」接在行尾
    el('div', { class: 'desc-row' },
      job.description ? (() => {
        const box = el('div', { class: `desc md${longDesc && !descOpen ? ' clamped' : ''}` });
        box.innerHTML = renderMarkdown(job.description); // renderMarkdown 先转义了 HTML
        return box;
      })() : null,
      longDesc ? el('button', { class: 'more', onclick: () => { descOpenJob = descOpen ? null : job.id; renderMain(); } }, descOpen ? '收起说明' : '展开全部说明') : null),
    job.origin ? el('details', { class: 'origin-box' },
      el('summary', null, '需求原文'),
      (() => { const d = el('div', { class: 'md' }); d.innerHTML = renderMarkdown(job.origin); return d; })()) : null];
  const head = job.demo
    ? el('div', { class: 'job-head' }, headMain)
    : el('div', { class: 'job-head has-side' }, el('div', { class: 'job-main' }, headMain), jobSide(job, tasks, longDesc && !descOpen));
  if (job.demo) {
    main.removeAttribute('aria-busy');
    // 一张卡时右边放它的步骤大纲；多张时放正在运行的那张（没有就第一张）
    const focus = tasks.find((t) => ['queued', 'demoing', 'wrapping'].includes(t.status)) || tasks[0];
    const outlineScroll = main.querySelector('.outline ol')?.scrollTop;
    fill(main, head, tasks.length
      ? el('div', { class: 'demo-layout' },
        el('div', { class: 'demo-left' }, el('div', { class: 'demo-list' }, tasks.map(demoRow)), stagePanels(focus)),
        stepOutline(focus))
      : emptyState('split', '暂无演播卡', '向 leader 说明演播内容，leader 将确认演播步骤、编写脚本并创建演播卡。'),
    cancelledSection(cancelled));
    // 重画后保持大纲的滚动位置；当前步换了就把它滚到可见处
    const ol = main.querySelector('.outline ol');
    if (ol) {
      if (outlineScroll != null) ol.scrollTop = outlineScroll;
      const now = ol.querySelector('li.now');
      if (now && now.dataset.n !== lastOutlineStep) { ol.scrollTop = now.offsetTop - ol.clientHeight / 2 + now.offsetHeight / 2; lastOutlineStep = now.dataset.n; }
    }
    return;
  }
  // 统计数字挪到了头部右侧的概览里，这里只留进度条
  const stats = el('div', { class: 'progress' }, tasks.length ? strip(tasks, true) : null);

  let report = null;
  if (job.status === 'awaiting_acceptance' && job.report) {
    report = el('div', { class: 'report-bar' },
      el('span', { class: 'what' }, 'leader 已提交汇报，待验收'),
      el('span', { class: 'when' }, `${fmtTime(job.updatedAt)} 提交`),
      el('button', { class: 'btn primary', onclick: (e) => { e.stopPropagation(); openReport(); } }, '查看汇报'),
      acceptButtons(job),
      el('span', { class: 'hint' }, ACCEPT_HINT));
  } else if (job.status === 'accepted' && job.report) {
    report = el('div', { class: 'report-bar' },
      el('span', { class: 'what' }, '已验收通过'),
      el('span', { class: 'when' }, job.acceptedAt ? `${fmtTime(job.acceptedAt)} 验收` : ''),
      el('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); openReport(); } }, '查看汇报'));
  }

  // 没有卡的列收成一条窄竖条（列名竖排），宽度让给有卡的列；有卡进来自动展开
  const laneCount = (key) => tasks.filter((t) => laneOf(t) === key).length;
  const slim = (key) => slimLanes && !laneCount(key); // 设置 → 显示偏好 →「空列收窄」
  const cols = LANES.map((lane) => (slim(lane.key) ? '40px' : 'minmax(188px, 1fr)')).join(' ');
  const board = el('div', { class: 'board', style: `--cols: ${cols}` }, LANES.map((lane) => {
    const cards = tasks.filter((t) => laneOf(t) === lane.key);
    // 待领取一列按派发顺序排：优先的在最上面（与服务端 dispatchOrder 一致）
    if (lane.key === 'pending') cards.sort((a, b) => ((b.priority ?? 0) - (a.priority ?? 0)) || (b.handoff - a.handoff) || (Number(a.id.slice(1)) - Number(b.id.slice(1))));
    // 已通过一列：越新通过的越靠上
    if (lane.key === 'approved') cards.sort((a, b) => (approvedAt(b) - approvedAt(a)) || (Number(b.id.slice(1)) - Number(a.id.slice(1))));
    return el('section', { class: `lane c-${lane.key}${cards.length ? ' has' : ''}${slim(lane.key) ? ' slim' : ''}${lane.key === 'pending' && job.onHold ? ' held' : ''}`, 'aria-label': lane.label, 'data-lane': lane.key, title: slim(lane.key) ? `${lane.label}：暂无` : null },
      el('h3', null, el('span', { class: 'label' }, lane.label),
        lane.key === 'pending' && job.onHold ? el('span', { class: 'lane-held' }, '已暂停') : null,
        el('span', { class: 'n' }, cards.length)),
      el('div', { class: 'cards' }, cards.length ? cards.map((t) => card(t, lane.key)) : el('div', { class: 'empty-hint' }, '暂无')));
  }));

  const cancelledBox = cancelledSection(cancelled);

  const scrolls = Object.fromEntries([...main.querySelectorAll('.lane[data-lane] .cards')].map((c) => [c.parentNode.dataset.lane, c.scrollTop]));
  main.removeAttribute('aria-busy');
  fill(main, head, tasks.length ? stats : null, report, tasks.length ? board : emptyState('split', 'leader 正在拆分任务', '拆分完成后任务将显示在此处，所需的 worker 角色将由 leader 在对话中告知。'), cancelledBox);
  fitActs();
  for (const c of main.querySelectorAll('.lane[data-lane] .cards')) c.scrollTop = scrolls[c.parentNode.dataset.lane] || 0;
}
// 需求头部右侧：概览（统计、耗时、角色进度、参与者）+ 最近动态（各任务时间线合在一起，新的在上）
const ACTIVITY_TYPES = new Set(['claimed', 'asked', 'answered', 'submitted', 'approved', 'rejected', 'handoff', 'cancelled', 'critique']);
function jobSide(job, tasks, collapsed) {
  const st = reviewStats(tasks);
  const endAt = job.acceptedAt || job.cancelledAt;
  const end = endAt ? new Date(endAt) : Date.now();
  const took = dur(end - new Date(job.createdAt));
  const roles = new Map();
  for (const t of tasks) {
    const r = roles.get(t.role) || { done: 0, all: 0 };
    r.all++; if (t.status === 'approved') r.done++;
    roles.set(t.role, r);
  }
  const workers = [...new Set(tasks.flatMap((t) => t.history.filter((h) => h.type === 'claimed').map((h) => h.actor)))];
  const acts = tasks.flatMap((t) => t.history.filter((h) => ACTIVITY_TYPES.has(h.type)).map((h) => ({ ...h, task: t })));
  if (job.acceptedAt) acts.push({ ts: job.acceptedAt, type: 'job_accepted' });
  acts.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  // 说明收起时不放动态（卡片只留概览，和收起的说明一样矮）；展开后先多渲染一些，fitActs 按卡片剩下的高度留条数
  const shown = collapsed ? [] : acts.slice(0, 30);
  const open = (id) => { view.task = id; saveView(); renderDrawer(true); };
  const ju = job.demo ? null : usageForJob(job.id);
  const heavyN = ju ? ju.tasks.filter((t) => t.heavy).length : 0;
  // 可点的指标：鼠标和键盘都能打开
  const clickKpi = (node, fn) => {
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    node.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
    return node;
  };
  const kpi = (value, label, cls = '', title) => el('div', { class: `kpi ${cls}`, title }, el('b', null, value), el('span', null, label));
  // 整个需求暂停 / 恢复领取：概览卡右上角，平时鼠标移入卡片才出现，暂停中一直显示
  const holdBtn = job.demo || job.status === 'accepted' || job.status === 'cancelled' ? null : el('button', {
    class: `side-hold${job.onHold ? ' on' : ''}`,
    title: job.onHold ? '该需求的待领取任务已暂停派发，点击恢复' : '暂停派发该需求的待领取任务（含后续新增任务），进行中的任务不受影响',
    onclick: (e) => { e.stopPropagation(); holdAction('jobs', job.id, !job.onHold); },
  }, icon(job.onHold ? 'play' : 'pause'), job.onHold ? '已暂停 · 恢复' : '暂停领取');
  return el('aside', { class: `job-side${shown.length ? '' : ' bare'}`, 'aria-label': '概览和最近动态' }, holdBtn,
    el('div', { class: 'inner' },
      // 窄屏：任务进度条放进概览卡底部，不在下面单独占一行（宽屏隐藏，用卡片下面那条）
      tasks.length ? el('div', { class: 'side-strip' }, strip(tasks, true)) : null,
      el('div', { class: `kpis${ju ? ' has-tokens' : ''}` },
        kpi([`${st.approved}`, el('small', null, `/${tasks.length}`)], '已通过'),
        kpi(`${st.reviews}`, 'review'),
        kpi(st.rate, '一次通过'),
        kpi(`${st.rejects}`, '打回', st.rejects ? 'warn' : ''),
        // 整个需求的 token 合计（Claude Code、DeepSeek Harness 的会话记录），没有数据时不占位
        // 标签只写 Token（标签不换行，太长会把「已用时」挤成两行）；有偏高的卡时数字变色，悬停看说明
        ju ? clickKpi(kpi(fmtTokens(ju.total), 'Token', `link${heavyN ? ' warn' : ''}`,
          `共 ${ju.total} · 调用 ${ju.calls} 次（worker 在本需求各卡上的用量，不含 leader）\n输入 ${fmtTokens(ju.input)} · 缓存命中 ${fmtTokens(ju.cacheRead)} · 输出 ${fmtTokens(ju.output)}${heavyN ? `\n${heavyN} 张卡用量偏高（超过同角色中位数 3 倍）` : ''}\n点击查看各卡明细`), () => openUsage(job.id)) : null,
        kpi(took, endAt ? '耗时' : '已用时', 'dur', job.acceptedAt ? '从建需求到验收' : job.cancelledAt ? '从建需求到作废' : '从建需求到现在')),
      roles.size ? el('div', { class: 'roles' },
        [...roles].map(([role, r]) => el('div', { class: `role${r.done === r.all ? ' full' : ''}`, title: `${role}：${r.done}/${r.all} 已通过` },
          el('div', { class: 'rl' }, el('span', null, role), el('b', null, `${r.done}/${r.all}`)),
          el('i', null, el('i', { style: `width:${Math.round((r.done / r.all) * 100)}%` }))))) : null,
      // 没有动态就不占地方（刚建的需求、还没人领）
      shown.length ? el('div', { class: 'activity' },
        el('div', { class: 'side-h' }, el('span', null, '最近动态'),
          el('span', { class: 'sub', title: workers.map(agentName).join('\n') }, `${workers.length} 个 worker 参与 · 共 ${acts.length} 条`)),
        el('ol', { class: 'acts' }, shown.map((a) => {
          if (a.type === 'job_accepted') return el('li', { class: 'c-approved' }, el('i'), el('span', { class: 'when' }, fmtTime(a.ts)), el('span', { class: 'what' }, '需求验收通过'));
          const [label, color] = HISTORY[a.type] || [a.type, 'pending'];
          return el('li', { class: `c-${color} link`, title: `${a.task.id} ${a.task.title}${a.text ? `\n${a.text}` : ''}`, tabindex: '0', role: 'button',
            onclick: () => open(a.task.id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(a.task.id); } } },
          el('i'), el('span', { class: 'when' }, fmtTime(a.ts)),
          el('span', { class: 'what' }, el('span', { class: 'key' }, a.task.id), label, el('span', { class: 'who' }, agentName(a.actor))));
        }))) : null));
}
// 最近动态的条数跟着卡片高度走（卡片高度 = 左栏高度）：放满为止，只显示完整的行；
// 放不下 3 条就把卡片撑高到刚好 3 条。窄屏卡片自己撑高，固定最多 5 条
const MIN_ACTS = 3;
function fitActs() {
  const side = document.querySelector('#main .job-side');
  const ol = side?.querySelector('.acts');
  if (!ol) return;
  const items = [...ol.children];
  for (const li of items) li.hidden = false;
  side.style.minHeight = '';
  const narrow = getComputedStyle(side.querySelector('.inner')).position === 'static';
  if (narrow) { items.forEach((li, i) => { li.hidden = i >= 5; }); return; }
  const fits = () => { const max = ol.getBoundingClientRect().bottom; return items.filter((li) => li.getBoundingClientRect().bottom <= max + 0.5).length; };
  let n = fits();
  const want = Math.min(MIN_ACTS, items.length);
  if (n < want) {
    side.style.minHeight = `${side.getBoundingClientRect().height + (want - n) * items[0].getBoundingClientRect().height + 2}px`;
    n = Math.max(fits(), want);
  }
  items.forEach((li, i) => { li.hidden = i >= n; });
}
addEventListener('resize', () => fitActs());
// 已作废：默认收起，展开后一行一张，点开看详情
let cancelledOpen = false;
try { cancelledOpen = prefs.get('ateam.cancelledOpen') === '1'; } catch {}
function cancelledSection(list) {
  if (!list.length) return null;
  return el('section', { class: 'cancelled-box', 'aria-label': '已作废' },
    el('button', {
      class: 'cancelled-toggle', 'aria-expanded': cancelledOpen ? 'true' : 'false',
      onclick: () => {
        cancelledOpen = !cancelledOpen;
        try { prefs.set('ateam.cancelledOpen', cancelledOpen ? '1' : '0'); } catch {}
        renderMain();
      },
    }, icon('chev-down'), '已作废', el('span', { class: 'n' }, list.length)),
    cancelledOpen ? el('div', { class: 'cancelled-rows' }, list.map((t) => el('button', {
      class: 'cancelled-row', title: `${t.id} ${t.title}${t.cancelReason ? `\n作废原因：${t.cancelReason}` : ''}`,
      onclick: () => { view.task = t.id; saveView(); renderDrawer(true); },
    },
      el('span', { class: 'key' }, t.id),
      el('span', { class: 't' }, t.title),
      el('span', { class: 'tag role', style: roleStyle(t.role) }, t.role),
      el('span', { class: 'why' }, t.cancelReason || '—'),
      avatar(t.assignee || t.prevAssignee, t.role)))) : null);
}
