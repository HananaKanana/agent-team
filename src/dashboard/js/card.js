// 看板上的任务卡片，标签一行放不下时逐级压缩

import { data, view } from './state.js';
import { agentName, avatar, el, icon, laneTime, roleStyle } from './util.js';
import { lastClaimSince } from './workers.js';
import { critiqueTag, renderDrawer } from './drawer.js';
import { flashId, openCardMenu } from './menu.js';
import { saveView } from './app.js';

export function approvedAt(t) {
  const h = t.history.findLast((x) => x.type === 'approved');
  return h ? new Date(h.ts).getTime() || 0 : 0;
}
export function card(t, lane) {
  const handedOff = t.history.some((h) => h.type === 'handoff');
  const waiting = t.status === 'pending' || t.status === 'held';
  const top = t.priority && waiting;
  return el('button', {
    class: `card c-${lane}${lane === 'cancelled' ? ' cancelled' : ''}${waiting && t.onHold ? ' paused' : ''}${flashId === t.id ? ' flash' : ''}`, title: `${t.id} ${t.title}${waiting && t.onHold ? `\n已暂停领取${t.onHold.reason ? `：${t.onHold.reason}` : ''}` : ''}`, 'data-id': t.id,
    onclick: () => { view.task = t.id; saveView(); renderDrawer(true); },
    oncontextmenu: (e) => { e.preventDefault(); getSelection()?.removeAllRanges(); openCardMenu(t.id, e.clientX, e.clientY); },
  },
    el('div', { class: 't' }, t.title),
    el('div', { class: 'flags' },
      // 标签放不下时只裁标签（右边渐隐），后面的计时始终完整显示
      el('span', { class: 'tags' },
      top ? el('span', { class: 'tag urgent' }, '优先') : null,
      t.assignTo && waiting ? el('span', { class: 'tag assigned', title: `已指派给 ${t.assignTo}` }, `指派 ${agentName(t.assignTo)}`) : null,
      t.parked ? (() => {
        // 先放下这张、转去做的那张卡（最近一次领的）；那张作废了就把编号划掉
        const to = t.parkedFor || lastClaimSince(t.assignee, t.parked);
        const gone = to && data.state.tasks.find((x) => x.id === to)?.status === 'cancelled';
        return el('span', { class: 'tag hold', title: `leader 不在线，${agentName(t.assignee)} 暂时搁置该任务，转做${to ? ` ${to}${gone ? '（已作废）' : ''}` : '其他任务'}；leader 处理后交回原 worker` },
          el('span', { class: 'lbl' }, '转做'), el('span', { class: 'sym' }, '→'), to ? [el('span', { class: 'opt' }, ' '), el('span', { class: gone ? 'gone' : '' }, to)] : null);
      })() : null,
      !t.parked && data.leader?.away && (t.status === 'asking' || t.status === 'submitted')
        ? el('span', { class: 'tag leader-wait', title: `无 leader 模式：等待 leader 恢复后${t.status === 'asking' ? '答复' : ' review'}。${agentName(t.assignee)} 当前没有其他可处理的任务（同角色任务均在等待依赖，或与该任务修改同一批文件），因此暂时保留；出现可处理的任务后将搁置该任务并转做` }, '等 leader') : null,
      t.returnTo && waiting ? el('span', { class: 'tag assigned', title: `搁置后已由 leader 处理，优先交回原 worker ${t.returnTo}（其不在线时同角色 worker 均可领取）` }, `留给 ${agentName(t.returnTo)}`) : null,
      t.rejectCount ? el('span', { class: 'tag warn', title: `打回 ${t.rejectCount} 次` }, el('span', { class: 'lbl' }, '打回'), el('span', { class: 'opt' }, ' '), el('span', { class: 'sym' }, '↺'), String(t.rejectCount), el('span', { class: 'opt' }, ' 次')) : null,
      handedOff ? el('span', { class: 'tag handoff' }, '接手') : null,
      critiqueTag(t)),
      lane === 'cancelled' ? null : laneTime(t, lane)),
    el('div', { class: 'foot' },
      top ? icon('top', 'top') : null,
      lane === 'approved' ? icon('check', 'ok') : null,
      lane === 'working' || lane === 'rework' ? el('span', { class: 'pulse' }) : null,
      el('span', { class: 'key' }, t.id),
      el('span', { class: 'tag role', style: roleStyle(t.role) }, t.role),
      // 单张暂停领取的卡：右下角本该是「未领取」的虚线圈，换成暂停标记（整个需求暂停时列头已标明，不用）
      waiting && t.onHold
        ? el('span', { class: 'av held', title: `已暂停领取${t.onHold.reason ? `：${t.onHold.reason}` : ''}`, 'aria-label': '已暂停领取' }, icon('pause'))
        : avatar(t.assignee, t.role)));
}
// 卡片的标签一行放不下时：先压缩（去掉「次」和多余空格），再不够换成符号，还放不下才加渐隐。放得下就照常显示全
export function clipCardTags() {
  const over = (n) => n.scrollWidth > n.clientWidth + 1;
  for (const n of document.querySelectorAll('.card .flags > .tags')) {
    n.classList.remove('tight', 'tiny', 'clip');
    if (!over(n)) continue;
    n.classList.add('tight');
    if (!over(n)) continue;
    n.classList.add('tiny'); // 再不够：「转做」「打回」换成符号 →T208、↺1
    if (over(n)) n.classList.add('clip');
  }
}
addEventListener('resize', () => clipCardTags());
