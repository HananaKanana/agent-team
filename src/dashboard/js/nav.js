// 左侧需求列表：分组（进行中、待验收、已验收、演播、已作废）、收起和展开

import { prefs } from './prefs.js';
import { data, DEMO_STATUS, JOB_STATUS, view } from './state.js';
import { el, emptyState, fill, icon, strip } from './util.js';
import { modeWord } from './demo.js';
import { peersNav } from './sync.js';
import { openJobMenu } from './menu.js';
import { render, saveView } from './app.js';

// 已验收的需求收进左侧底部一个可展开的分组，默认收起
let acceptedOpen = false;
try { acceptedOpen = prefs.get('ateam.acceptedOpen') === '1'; } catch {}
// 左侧需求栏收起成一条窄栏（只留编号）。记在本浏览器；没设过时窄屏（平板）默认收起
export let navCollapsed = window.innerWidth < 1200;
try { const v = prefs.get('ateam.navCollapsed'); if (v !== null) navCollapsed = v === '1'; } catch {}
function setNavCollapsed(on) {
  navCollapsed = on;
  try { prefs.set('ateam.navCollapsed', on ? '1' : '0'); } catch {}
  renderJobs();
}
// 开发中的需求（规划中、进行中、待验收）：第一组，默认展开
let openJobsOpen = true;
try { openJobsOpen = prefs.get('ateam.openJobsOpen') !== '0'; } catch {}
// 演播需求一直是进行中，不和开发需求混在一起：单独一组，默认收起
let demoJobsOpen = false;
try { demoJobsOpen = prefs.get('ateam.demoJobsOpen') === '1'; } catch {}
// 已作废的需求：单独一组，默认收起
let cancelledJobsOpen = false;
try { cancelledJobsOpen = prefs.get('ateam.cancelledJobsOpen') === '1'; } catch {}
export function renderJobs() {
  const nav = document.getElementById('jobs');
  const { jobs, tasks } = data.state;
  const jobItem = (j) => {
    const jt = tasks.filter((t) => t.jobId === j.id && t.status !== 'cancelled');
    const done = jt.filter((t) => t.status === 'approved').length;
    if (j.demo) {
      const live = jt.find((t) => t.status === 'queued' || t.status === 'demoing');
      return el('button', {
        class: `job${j.status === 'cancelled' ? ' dropped' : ''}`, 'data-job': j.id, 'aria-current': view.job === j.id ? 'true' : 'false',
        onclick: () => { view.job = j.id; view.task = null; view.report = false; saveView(); render(); },
        oncontextmenu: (e) => { e.preventDefault(); getSelection()?.removeAllRanges(); openJobMenu(j.id, e.clientX, e.clientY); },
      },
      el('div', { class: 'title' }, el('span', { class: 'jid' }, j.id), j.title),
      el('div', { class: 'sub' }, el('span', { class: 'tag' }, '演播'), el('span', null, live ? (live.status === 'demoing' ? `${modeWord(live)}中` : DEMO_STATUS[live.status][0]) : `${jt.length} 张演播卡`)));
    }
    const paused = j.onHold && j.status !== 'accepted' && j.status !== 'cancelled';
    return el('button', {
      class: `job${j.status === 'cancelled' ? ' dropped' : ''}${paused ? ' paused' : ''}`, 'data-job': j.id, 'aria-current': view.job === j.id ? 'true' : 'false',
      onclick: () => { view.job = j.id; view.task = null; view.report = false; saveView(); render(); },
      oncontextmenu: (e) => { e.preventDefault(); getSelection()?.removeAllRanges(); openJobMenu(j.id, e.clientX, e.clientY); },
    },
    el('div', { class: 'title' }, el('span', { class: 'jid' }, j.id), j.title),
    el('div', { class: 'sub' }, j.status === 'accepted' ? el('span', { class: 'accepted' }, '✓ 已验收') : paused ? el('span', { class: 'lane-held', title: '该需求已暂停领取' }, '已暂停') : el('span', null, JOB_STATUS[j.status] || j.status), el('span', null, `${done}/${jt.length} 已通过`)),
    jt.length ? strip(jt, false) : null);
  };
  const newest = jobs.slice().reverse();
  const open = newest.filter((j) => !j.demo && j.status !== 'accepted' && j.status !== 'cancelled');
  const demos = newest.filter((j) => j.demo && j.status !== 'accepted' && j.status !== 'cancelled');
  const done = newest.filter((j) => j.status === 'accepted');
  const dropped = newest.filter((j) => j.status === 'cancelled');
  // 收起时也提示正在预演 / 演播的
  const liveDemo = demos.some((j) => tasks.some((t) => t.jobId === j.id && (t.status === 'queued' || t.status === 'demoing' || t.status === 'wrapping')));
  const openGroup = open.length ? [
    el('button', {
      class: 'accepted-toggle first', 'aria-expanded': openJobsOpen ? 'true' : 'false',
      onclick: () => {
        openJobsOpen = !openJobsOpen;
        try { prefs.set('ateam.openJobsOpen', openJobsOpen ? '1' : '0'); } catch {}
        renderJobs();
      },
    }, el('span', null, openJobsOpen ? '▾' : '▸'), `开发中（${open.length}）`),
    openJobsOpen ? open.map(jobItem) : null,
  ] : [];
  const demoGroup = demos.length ? [
    el('button', {
      class: 'accepted-toggle', 'aria-expanded': demoJobsOpen ? 'true' : 'false',
      onclick: () => {
        demoJobsOpen = !demoJobsOpen;
        try { prefs.set('ateam.demoJobsOpen', demoJobsOpen ? '1' : '0'); } catch {}
        renderJobs();
      },
    }, el('span', null, demoJobsOpen ? '▾' : '▸'), `演播（${demos.length}）`, liveDemo && !demoJobsOpen ? el('span', { class: 'tag live' }, '进行中') : null),
    demoJobsOpen ? demos.map(jobItem) : null,
  ] : [];
  const droppedGroup = dropped.length ? [
    el('button', {
      class: 'accepted-toggle', 'aria-expanded': cancelledJobsOpen ? 'true' : 'false',
      onclick: () => {
        cancelledJobsOpen = !cancelledJobsOpen;
        try { prefs.set('ateam.cancelledJobsOpen', cancelledJobsOpen ? '1' : '0'); } catch {}
        renderJobs();
      },
    }, el('span', null, cancelledJobsOpen ? '▾' : '▸'), `已作废（${dropped.length}）`),
    cancelledJobsOpen ? dropped.map(jobItem) : null,
  ] : [];
  const doneGroup = done.length ? [
    el('button', {
      class: 'accepted-toggle', 'aria-expanded': acceptedOpen ? 'true' : 'false',
      onclick: () => {
        acceptedOpen = !acceptedOpen;
        try { prefs.set('ateam.acceptedOpen', acceptedOpen ? '1' : '0'); } catch {}
        renderJobs();
      },
    }, el('span', null, acceptedOpen ? '▾' : '▸'), `已验收（${done.length}）`),
    acceptedOpen ? done.map(jobItem) : null,
  ] : [];
  const empty = jobs.length ? (open.length || demos.length ? [] : [emptyState('done', '所有需求已验收', '如有新需求，请直接告知 leader。')])
    : [emptyState('inbox', '暂无需求', '向 leader 描述需求后，任务将显示在此处。')];
  document.querySelector('.layout').classList.toggle('nav-collapsed', navCollapsed);
  const toggle = el('button', {
    class: 'nav-toggle', title: navCollapsed ? '展开需求栏' : '收起需求栏', 'aria-label': navCollapsed ? '展开需求栏' : '收起需求栏',
    'aria-expanded': navCollapsed ? 'false' : 'true', onclick: () => setNavCollapsed(!navCollapsed),
  }, icon('sidebar'));
  if (navCollapsed) {
    // 窄栏：进行中的需求 + 当前看的那个（可能在已验收里），只显示编号和进度，悬停看标题
    const shown = [...open, ...demos.filter((j) => tasks.some((t) => t.jobId === j.id && ['queued', 'demoing', 'wrapping'].includes(t.status)))];
    const cur = jobs.find((j) => j.id === view.job);
    if (cur && !shown.includes(cur)) shown.push(cur);
    fill(nav, el('div', { class: 'nav-head' }, toggle), shown.map((j) => {
      const jt = tasks.filter((t) => t.jobId === j.id && t.status !== 'cancelled');
      const doneN = jt.filter((t) => t.status === 'approved').length;
      return el('button', {
        class: `job-mini${j.status === 'accepted' ? ' ok' : ''}${j.status === 'cancelled' ? ' dropped' : ''}${j.onHold && j.status !== 'accepted' && j.status !== 'cancelled' ? ' paused' : ''}`, 'data-job': j.id,
        'aria-current': view.job === j.id ? 'true' : 'false',
        title: `${j.id} ${j.title}\n${j.demo ? `${jt.length} 张演播卡` : `${doneN}/${jt.length} 已通过`}`,
        onclick: () => { view.job = j.id; view.task = null; view.report = false; saveView(); render(); },
        oncontextmenu: (e) => { e.preventDefault(); getSelection()?.removeAllRanges(); openJobMenu(j.id, e.clientX, e.clientY); },
      }, j.id, el('i', { class: j.demo || !jt.length ? 'none' : '' }, el('i', { style: `width:${jt.length ? Math.round((doneN / jt.length) * 100) : 0}%` })));
    }), done.length || dropped.length || demos.length ? el('button', { class: 'job-mini more', title: `展开查看演播 ${demos.length}、已验收 ${done.length}、已作废 ${dropped.length}`, onclick: () => setNavCollapsed(false) }, '···') : null, peersNav());
    return;
  }
  fill(nav, el('div', { class: 'nav-head' }, el('h2', null, '需求'), toggle), openGroup, empty, demoGroup, doneGroup, droppedGroup, peersNav());
}
