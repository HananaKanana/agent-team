'use strict';
// leader 汇报阅读页

function openReport() {
  view.task = null;
  view.report = true;
  saveView();
  render();
  const page = document.getElementById('report');
  page.scrollTop = 0;
  page.querySelector('.btn')?.focus();
}
function closeReport() {
  view.report = false;
  saveView();
  render();
}
function renderReport() {
  const page = document.getElementById('report');
  const job = data.state.jobs.find((j) => j.id === view.job);
  if (!view.report || !job || !job.report) {
    page.hidden = true;
    page.replaceChildren();
    document.body.style.overflow = '';
    return;
  }
  const scroll = page.hidden ? 0 : page.scrollTop;
  const tasks = data.state.tasks.filter((t) => t.jobId === job.id && t.status !== 'cancelled');
  const st = reviewStats(tasks);
  const body = el('div', { class: 'md' });
  body.innerHTML = renderMarkdown(job.report); // renderMarkdown 先转义了 HTML
  // 汇报后面附上这个需求所有的审卡意见和处理结果，方便你看有没有跑偏
  const crit = tasks.flatMap((t) => (t.critiques || []).map((c) => ({ t, c })));
  const critSec = crit.length ? [
    el('h2', { class: 'crit-head' }, `审卡改动（${crit.length} 条）`),
    crit.map(({ t, c }) => [el('div', { class: 'hint' }, `${t.id} ${t.title}`), critiqueItem(c)]),
  ] : null;
  // 目录：取正文和「审卡改动」的二级标题
  const heads = [...body.querySelectorAll('h2')];
  heads.forEach((h, i) => { h.id = `sec-${i}`; });
  const toc = heads.length + (critSec ? 1 : 0) >= 3 ? el('nav', { class: 'report-toc', 'aria-label': '目录' },
    el('h5', null, '目录'),
    heads.map((h) => el('a', { href: `#${h.id}`, onclick: (e) => { e.preventDefault(); h.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, h.textContent)),
    critSec ? el('a', { href: '#crit', onclick: (e) => { e.preventDefault(); page.querySelector('.crit-head')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, '审卡改动') : null) : null;
  fill(page,
    el('div', { class: 'report-top' },
      el('button', { class: 'btn ghost', onclick: closeReport }, icon('back'), '返回看板'),
      el('span', { class: 'crumb' }, `需求 ${job.id} / `, el('b', null, '汇报')),
      acceptButtons(job)),
    el('div', { class: `report-wrap${toc ? ' has-toc' : ''}` },
      el('article', { class: 'report-sheet' },
        body.firstElementChild?.tagName === 'H1' ? null : el('h1', { class: 'report-title' }, job.title), // 汇报自己带标题就不重复
        el('div', { class: 'report-meta' },
          el('span', null, '状态', el('b', null, JOB_STATUS[job.status] || job.status)),
          el('span', null, '提交于', el('b', null, fmtTime(job.updatedAt))),
          el('span', null, '已通过', el('b', null, `${st.approved} / ${tasks.length}`)),
          el('span', null, 'review', el('b', null, `${st.reviews} 次`)),
          el('span', null, '一次通过率', el('b', null, st.rate))),
        body,
        critSec,
        job.status === 'awaiting_acceptance' ? el('p', { class: 'accept-tip' }, ACCEPT_HINT) : null),
      toc));
  page.hidden = false;
  page.scrollTop = scroll;
  document.body.style.overflow = 'hidden';
}
