// 任务详情抽屉：详情、时间线、回复、暂停、审卡意见、指派、优先级、收回

import { prefs } from './prefs.js';
import { data, DEMO_STATUS, HISTORY, LANE_LABEL, view } from './state.js';
import {
  agentLabel, avatar, dur, el, fill, fmtTime, icon, laneOf, post, renderMarkdown, roleStyle, spent
} from './util.js';
import { pendingCancel, stopPrompt } from './workers.js';
import { promptBlock, promptBox } from './helper.js';
import { platformLabel, spawnButton, spawnMessage, spawnState } from './spawn.js';
import { demoDrawerBody, isDemoTask, modeWord, rehearsalTag, tokenFact } from './demo.js';
import { openDecide } from './dialogs.js';
import { poll, render, saveView } from './app.js';

// 抽屉是否展开到大半屏；记在显示偏好里，下次打开保持
let drawerWide = false;
try { drawerWide = prefs.get('ateam.drawerWide') === '1'; } catch {}

export function renderDrawer(fresh) {
  const drawer = document.getElementById('drawer');
  const t = view.task && data.state.tasks.find((x) => x.id === view.task);
  if (!t) { drawer.hidden = true; drawer.replaceChildren(); assignOpen = null; return; }
  // 正在写回复：轮询刷新不重画，免得打字被打断
  if (!fresh && document.activeElement?.classList?.contains('reply-input') && drawer.contains(document.activeElement) && document.activeElement.dataset.id === t.id) return;
  const scroll = fresh ? 0 : drawer.scrollTop;
  const lane = laneOf(t);
  // 子节点里有条件出现的数组和 null：走 fill，与 el() 一样展开并过滤
  const job = data.state.jobs.find((j) => j.id === t.jobId);
  const fact = (label, value) => [el('dt', null, label), el('dd', null, value)];
  const demo = isDemoTask(t);
  const facts = demo ? el('dl', { class: 'facts' },
    fact('状态', el('span', { class: `lozenge c-${(DEMO_STATUS[t.status] || [])[1] || 'pending'}` }, t.status === 'demoing' ? `${modeWord(t)}中` : (DEMO_STATUS[t.status] || [t.status])[0])),
    fact('角色', el('span', { class: 'tag role', style: roleStyle(t.role) }, t.role)),
    fact('处理人', t.assignee ? el('span', { class: 'who' }, avatar(t.assignee, t.role), agentLabel(t.assignee)) : '无'),
    fact('脚本', el('code', null, t.script)),
    fact('预演', rehearsalTag(t)),
    fact('运行次数', `${(t.runs || []).length} 次`),
    fact('创建', t.history[0] ? fmtTime(t.history[0].ts) : '—'),
    tokenFact(t, fact)) : el('dl', { class: 'facts' },
    fact('状态', el('span', { class: `lozenge c-${lane}` }, LANE_LABEL[lane])),
    fact('角色', el('span', { class: 'tag role', style: roleStyle(t.role) }, t.role)),
    fact('处理人', t.assignee ? el('span', { class: 'who' }, avatar(t.assignee, t.role), agentLabel(t.assignee)) : '未领取'),
    // ego-browser 测试用 profile：分到的 profile，或全被占用时共用默认 profile
    t.egoProfile || t.egoShared ? fact('ego profile', t.egoShared ? '默认（测试用 profile 均被占用）' : t.egoProfile.name) : null,
    fact('依赖', t.dependsOn.length ? t.dependsOn.join('、') : '无'),
    fact('打回', `${t.rejectCount} 次`),
    fact('创建', t.history[0] ? fmtTime(t.history[0].ts) : '—'),
    t.status === 'approved' && spent(t) != null ? fact('总耗时', dur(spent(t))) : null,
    fact('路径', t.paths.length ? t.paths.map((p) => el('code', null, p)) : '无'),
    tokenFact(t, fact));
  fill(drawer,
    el('div', { class: 'drawer-bar' },
      el('span', { class: 'crumbs', title: job ? `${job.id} ${job.title}` : t.jobId }, `需求 ${t.jobId} / `, el('b', null, t.id)),
      el('button', {
        class: 'btn ghost icon widen',
        title: drawerWide ? '收窄' : '展开',
        'aria-label': drawerWide ? '收窄' : '展开',
        onclick: (e) => {
          e.stopPropagation();
          drawerWide = !drawerWide;
          try { prefs.set('ateam.drawerWide', drawerWide ? '1' : '0'); } catch {}
          renderDrawer(false);
        },
      }, icon(drawerWide ? 'shrink' : 'expand')),
      el('button', { class: 'btn ghost icon close', title: '关闭', 'aria-label': '关闭', onclick: closeDrawer }, icon('close'))),
    el('div', { class: 'drawer-body' },
    el('h2', null, t.title),
    facts,
    demo ? demoDrawerBody(t) : [
    (t.status === 'working' || t.status === 'asking') && t.assignee ? reclaimBox(t) : null,
    t.status === 'pending' || t.status === 'held' ? [assignBox(t), priorityBox(t), holdBox(t)] : null,
    critiqueBox(t),
    (() => {
      // 作废了、但拿着它的 worker 还不知道：给出叫停的话
      const a = t.status === 'cancelled' && data.state.agents.find((x) => pendingCancel(x)?.id === t.id);
      return a ? [
        el('h4', null, `${agentLabel(a.id)} 仍在处理该任务`),
        el('p', { class: 'hint' }, '该 worker 需在下次调用 ateam 命令时才会收到作废通知。如需立即停止，请在其 agent 窗口中点击停止，并发送以下提示词。'),
        promptBlock(stopPrompt(a, t), () => renderDrawer(false)),
      ] : null;
    })(),
    t.status === 'pending' ? [
      el('div', { class: 'drawer-sec-head' }, el('h4', null, t.handoff ? '让新 worker 接手' : '分配 worker'), spawnButton(t.role, t.id)),
      el('p', { class: 'hint' }, `点击「启动」在 ${platformLabel()} 中新建会话并自动发送提示词，或在新建的 agent 窗口（可使用其他账号）中手动发送以下提示词。若已有同角色 worker 在线，无需新建窗口，其完成当前任务后将自动领取。`),
      promptBox(t.role),
    ] : null,
    // 从这里启动的提示：卡被新 worker 领走后也留着，直到自动消失
    spawnState.taskId === t.id ? spawnMessage(t.role) : null,
    el('h4', null, '验收标准'),
    t.acceptance.length ? el('ol', { class: `checklist${t.status === 'approved' ? ' done' : ''}` }, t.acceptance.map((a) => el('li', null, a))) : el('p', { class: 'meta' }, '未填写'),
    el('h4', null, '描述'),
    (() => {
      const box = el('div', { class: 'descbox md' });
      if (t.description?.trim()) box.innerHTML = renderMarkdown(t.description); // renderMarkdown 先转义了 HTML
      else box.textContent = '（无）';
      return box;
    })(),
    el('h4', null, '提交'),
    t.commits.length ? el('ul', { class: 'commits' }, t.commits.map((c) => el('li', null, el('code', null, c)))) : el('p', { class: 'meta' }, '暂无'),
    ],
    el('h4', null, '时间线'),
    el('ol', { class: 'timeline' }, t.history.filter((h) => h.type !== 'note_delivered').map((h) => {
      const [label, color] = HISTORY[h.type] || [h.type, 'pending'];
      return el('li', { class: `c-${color}` },
        el('div', null, el('span', { class: 'what' }, label), ' ', el('span', { class: 'when' }, `${fmtTime(h.ts)}  ${agentLabel(h.actor)}`), readFlags(h)),
        h.text ? timelineText(h.text) : null,
        h.commit ? el('div', { class: 'when' }, '提交 ', el('code', null, h.commit)) : null);
    })),
    demo ? null : replyBox(t)));
  drawer.hidden = false;
  drawer.scrollTop = scroll;
  drawer.classList.toggle('wide', drawerWide);
  if (fresh) drawer.querySelector('.close').focus();
}
// 消息的已读状态：字段不存在是功能上线前的旧记录，不显示
function readFlags(h) {
  // 已经写下状态的旧记录也只显示这几类：提问、答复、补充说明、用户发的话
  if (h.type !== 'asked' && h.type !== 'answered' && h.type !== 'note' && h.actor !== 'user') return [];
  const flag = (who, at, tip) => el('span', { class: at ? 'read-flag read' : 'read-flag', title: at ? `${fmtTime(at)} 已读。${tip}` : tip }, `${who}${at ? '已读' : '未读'}`);
  const flags = [];
  if (h.workerReadAt !== undefined) {
    if (!h.workerReadAt && h.workerDeliveredAt) {
      // 经 hook 送出、还没回执：内容已交给 agent 平台，未确认 worker 看到
      flags.push(el('span', { class: 'read-flag sent', title: `${fmtTime(h.workerDeliveredAt)} 已在工具调用结束后送出，等待 worker 回执。未回执的内容会在它下一次调用 ateam（最迟提交时）再给一遍。` }, 'worker 已送达'));
    } else {
      // 老记录的 via 是 'hook'（那时 hook 送出即算已读）
      const via = h.workerReadVia === 'ack' ? '经工具调用后送达，worker 已回执。' : h.workerReadVia === 'hook' ? '工具调用结束后送达。' : h.workerReadAt ? '调用 ateam 时送达。' : '';
      flags.push(flag('worker ', h.workerReadAt, `${via}已读表示 worker 已收到这条内容，不代表已照做。`));
    }
  }
  if (h.leaderReadAt !== undefined) flags.push(flag('leader ', h.leaderReadAt, '已读表示 leader 已收到通知或已查看这张卡。'));
  return flags;
}
// 时间线里的文字：worker 的交付说明、进度常按 Markdown 写（## 小标题、- 列表、代码块），像 Markdown 的就渲染，其余原样显示
const MD_HINT = /^\s*(#{1,6}\s|[-*]\s|\d+\.\s|```|\|.*\|\s*$|>\s)/m;
function timelineText(text) {
  // 老数据：换行被存成了字面的 \n（同 src/store.js 的 unescapeNewlines）
  if (!text.includes('\n') && (text.match(/\\n/g) || []).length >= 2) text = text.replace(/\\n/g, '\n');
  if (!MD_HINT.test(text) && !/\*\*[^*]+\*\*|`[^`\n]+`/.test(text)) return el('div', { class: 'text' }, text);
  const box = el('div', { class: 'text md' });
  box.innerHTML = renderMarkdown(text); // renderMarkdown 先转义了 HTML
  return box;
}
export function closeDrawer() {
  view.task = null;
  saveView();
  renderDrawer();
}
// 设为优先 / 取消优先：只影响同角色 worker 领任务的先后
let priorityError = null;
let holdError = null;
// 暂停 / 恢复领取：kind 是 tasks 或 jobs
export async function holdAction(kind, id, on) {
  try {
    const res = await fetch(`/api/${kind}/hold`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, on, by: 'user' }) });
    const out = await res.json();
    holdError = out.ok ? null : out.message;
  } catch { holdError = '无法连接 ateam 服务。'; }
  await poll();
  render();
  renderDrawer(false);
}
// 用户在卡片详情里直接回复：卡在等答复就当答复交给 worker，在做就当补充说明；leader 都会收到通知
const replyDrafts = new Map(); // 卡号 → 没发出去的草稿，重画抽屉时不丢
let replyState = { id: null, sending: false, error: '', sent: '' };
function replyBox(t) {
  if (t.status !== 'asking' && t.status !== 'working' && t.status !== 'submitted') return null;
  const asking = t.status === 'asking';
  const review = t.status === 'submitted';
  const mine = replyState.id === t.id ? replyState : { error: '', sent: '', sending: false };
  const area = el('textarea', {
    class: 'reply-input', rows: '3', 'data-id': t.id,
    placeholder: asking ? '回复上方提问，worker 收到后将继续工作…' : review ? '填写对 review 的要求，例如需要修改之处…' : `填写给 ${t.assignee ? agentLabel(t.assignee) : 'worker'} 的补充说明…`,
  });
  area.value = replyDrafts.get(t.id) || '';
  const send = async () => {
    const text = area.value.trim();
    if (!text || replyState.sending) return;
    area.blur(); // 输入框有焦点时抽屉不重画，先放开，才看得到「发送中」和结果
    replyState = { id: t.id, sending: true, error: '', sent: '' };
    renderDrawer(false);
    const out = await post('/api/reply', { id: t.id, text });
    if (out.ok) { replyDrafts.delete(t.id); replyState = { id: t.id, sending: false, error: '', sent: asking ? '已作为答复发送给 worker，并同步通知 leader。' : review ? '已发送给 leader，将在 review 时据此核对；如被打回，worker 也会收到。' : '已发送，并同步通知 leader。worker 通常在当前操作结束后收到（提交前必定可见），是否已读见时间线标签。' }; }
    else replyState = { id: t.id, sending: false, error: out.message || '发送失败。', sent: '' };
    await poll();
    render();
    renderDrawer(false);
  };
  area.addEventListener('input', () => { replyDrafts.set(t.id, area.value); if (replyState.id === t.id && replyState.sent) replyState.sent = ''; });
  area.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } });
  const foot = mine.error ? el('span', { class: 'hint err' }, mine.error)
    : mine.sent ? el('span', { class: 'hint' }, mine.sent)
    : el('span', { class: 'hint' }, asking ? '将同时发送给 worker 和 leader，leader 不会重复答复 · ' : review ? 'leader 将在 review 时查看；如被打回，worker 也会收到 · ' : 'worker 通常在当前操作结束后收到，并同步通知 leader；是否已读见时间线标签 · ', el('kbd', null, '⌘↩'), ' 发送');
  return el('div', { class: `reply-box${asking ? ' asking' : ''}` },
    el('h4', null, asking ? `回复 ${t.assignee ? agentLabel(t.assignee) : 'worker'} 的提问` : '补充说明'),
    el('div', { class: 'composer', onclick: () => area.focus() }, area,
      el('div', { class: 'reply-foot' }, foot,
        el('button', { class: 'btn primary sm', disabled: mine.sending, onclick: (e) => { e.stopPropagation(); send(); } }, mine.sending ? '发送中…' : '发送'))));
}
export function focusReply(id) {
  view.task = id; saveView(); renderDrawer(true);
  const area = document.querySelector(`#drawer .reply-input[data-id="${id}"]`);
  if (area) { area.scrollIntoView({ block: 'center' }); area.focus(); }
}
function holdBox(t) {
  const job = data.state.jobs.find((j) => j.id === t.jobId);
  const on = !!t.onHold;
  let hint;
  if (job?.onHold) hint = `需求 ${job.id} 已暂停领取，该任务暂不派发。可在需求页的提示中点击「恢复领取」。`;
  else if (on) hint = `已暂停${t.onHold.reason ? `（${t.onHold.reason}）` : ''}：任务保留在待领取，worker 不会领取。恢复后按派发顺序派发。`;
  else hint = '如暂不希望 worker 领取该任务（例如等待确认），可暂停领取。依赖该任务的任务也将一并等待。';
  return [
    el('h4', null, '暂停领取'),
    el('p', { class: 'hint' }, hint),
    job?.onHold ? null : el('div', { class: 'prompt' },
      el('button', { class: `btn${on ? ' primary' : ''}`, onclick: (e) => { e.stopPropagation(); holdAction('tasks', t.id, !on); } }, on ? '恢复领取' : '暂停领取'),
      holdError ? el('span', { class: 'hint' }, holdError) : null),
  ];
}
const CRITIQUE_STATUS = {
  open: '待 leader 回复', proposed: 'leader 已同意，待确认', disputed: 'leader 不同意，待决定',
  redo: '已决定，待 leader 执行', resolved: '已处理', closed: '决定不修改', overruled: '维持原样',
};
export const awaitingUser = (c) => c.status === 'proposed' || c.status === 'disputed';
export function critiqueTag(t) {
  const list = t.critiques || [];
  if (list.some(awaitingUser)) return el('span', { class: 'tag warn' }, '审卡：待决定');
  const open = list.filter((c) => c.status === 'open' || c.status === 'redo').length;
  return open ? el('span', { class: 'tag critique' }, `审卡意见 ${open}`) : null;
}
// 一条审卡意见的完整内容：意见、依据、leader 的回复、你的决定、改了什么
export function critiqueItem(c) {
  const md = (text) => { const d = el('div', { class: 'md' }); d.innerHTML = renderMarkdown(text); return d; }; // renderMarkdown 先转义了 HTML
  const replyLabel = c.replyKind === 'agree' ? 'leader 同意，拟修改如下：' : c.replyKind === 'dispute' ? 'leader 不同意，理由：' : 'leader：';
  return el('div', { class: 'critique-item' },
    el('div', { class: 'hint' }, `#${c.id} ${c.by}，${fmtTime(c.ts)}${c.because ? `，重新审：${c.because}` : ''}　`, el('b', null, CRITIQUE_STATUS[c.status] || c.status)),
    el('div', { class: 'ci-label' }, '审卡意见'), md(c.text),
    c.basis ? [el('div', { class: 'ci-label' }, '依据'), md(c.basis)] : null,
    c.reply ? [el('div', { class: 'ci-label' }, replyLabel), md(c.reply)] : null,
    c.replyBasis ? [el('div', { class: 'ci-label' }, 'leader 的依据'), md(c.replyBasis)] : null,
    c.ruling ? [el('div', { class: 'ci-label' }, '决定'), md(c.ruling)] : null,
    c.doneText ? [el('div', { class: 'ci-label' }, 'leader 已改'), md(c.doneText)] : null);
}
function critiqueBox(t) {
  const list = t.critiques || [];
  if (!list.length) return null;
  const waiting = list.some(awaitingUser);
  return [
    el('h4', null, `审卡意见（${list.length}）`),
    list.map(critiqueItem),
    waiting ? el('div', { class: 'prompt' },
      el('button', { class: 'btn primary', onclick: (e) => { e.stopPropagation(); openDecide(t.id); } }, '去处理')) : null,
  ];
}
// 指派：用户在看板上把任务交给某个 worker（比如难的任务交给 Claude 的窗口）。只有它能领，它优先领。
let assignError = null;
export let assignOpen = null; // 展开着「指派给」列表的任务编号
export function closeAssign() { assignOpen = null; renderDrawer(false); }
export function assignBox(t) {
  const role = t.role.trim().toLowerCase();
  const online = data.state.agents.filter((a) => a.status === 'online' && a.role.trim().toLowerCase() === role);
  const current = t.assignTo && data.state.agents.find((a) => a.id === t.assignTo);
  const choose = async (to) => {
    assignOpen = null;
    if (to === (t.assignTo || '')) { renderDrawer(false); return; }
    try {
      const res = await fetch('/api/tasks/assign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: t.id, to }) });
      const out = await res.json();
      assignError = out.ok ? null : out.message;
    } catch { assignError = '无法连接 ateam 服务。'; }
    await poll();
    renderDrawer(false);
  };
  const options = [
    { id: '', av: avatar(null), name: '不指派', sub: `${t.role} 角色均可领取` },
    ...online.map((a) => ({ id: a.id, av: avatar(a.id, a.role), name: agentLabel(a.id), sub: a.currentTask ? `正在处理 ${a.currentTask}` : '空闲' })),
    ...(current && current.status !== 'online' ? [{ id: current.id, av: avatar(current.id, current.role), name: agentLabel(current.id), sub: '不在线' }] : []),
  ];
  const selected = options.find((o) => o.id === (t.assignTo || '')) || options[0];
  const open = assignOpen === t.id;
  const picker = el('div', { class: 'assign-picker' },
    el('button', {
      class: 'assign-btn', 'aria-haspopup': 'listbox', 'aria-expanded': open ? 'true' : 'false',
      onclick: (e) => { e.stopPropagation(); assignOpen = open ? null : t.id; renderDrawer(false); },
    }, selected.av, selected.id ? selected.name : '不指派（同角色均可领取）', icon('chev-down', 'chev')),
    open ? el('div', { class: 'assign-menu', role: 'listbox' }, options.map((o, i) => [
      i === 1 ? el('div', { class: 'sep' }) : null,
      el('button', {
        role: 'option', 'aria-selected': o === selected ? 'true' : 'false',
        onclick: (e) => { e.stopPropagation(); choose(o.id); },
      }, o.av, el('span', { class: 'name' }, o.name, el('span', { class: 'sub' }, o.sub)), o === selected ? icon('tick', 'ok') : null),
    ])) : null);
  let hint;
  if (!t.assignTo) hint = `如需交由特定 worker 处理（例如将复杂任务交给 Claude 窗口），可在此选择。指派后仅该 worker 可领取，且优先领取。仅可选择 ${t.role} 角色的在线 worker。`;
  else if (!current || current.status !== 'online') hint = `${t.assignTo} 当前不在线，该任务将持续等待。如其无法恢复，请改派其他 worker 或选择「不指派」。`;
  else if (current.currentTask) hint = `${agentLabel(t.assignTo)} 正在处理 ${current.currentTask}，完成后将领取此任务${t.dependsOn.length ? '（依赖通过后）' : ''}。`;
  else hint = `${agentLabel(t.assignTo)} 下次领取任务时将领取此任务${t.dependsOn.length ? '（依赖通过后）' : ''}。`;
  return [
    el('h4', null, '指派给'),
    picker,
    el('p', { class: 'hint' }, hint),
    assignError ? el('p', { class: 'hint' }, assignError) : null,
  ];
}
function priorityBox(t) {
  const on = !!t.priority;
  return [
    el('h4', null, '派发顺序'),
    el('p', { class: 'hint' }, on
      ? `已设为优先：${t.role} 角色的 worker 将优先领取此任务${t.dependsOn.length ? '（依赖通过后）' : ''}。`
      : `如需尽快处理，可设为优先：${t.role} 角色的 worker 将优先领取此任务，无需排队。正在处理其他任务的 worker 不受影响。`),
    el('div', { class: 'prompt' },
      el('button', {
        class: on ? 'btn' : 'btn primary',
        onclick: async (e) => {
          e.stopPropagation();
          try {
            const res = await fetch('/api/tasks/priority', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: t.id, top: !on }) });
            const out = await res.json();
            priorityError = out.ok ? null : out.message;
          } catch { priorityError = '无法连接 ateam 服务。'; }
          await poll();
          renderDrawer(false);
        },
      }, on ? '取消优先' : '设为优先'),
      priorityError ? el('span', { class: 'hint' }, priorityError) : null),
  ];
}
// 收回任务：两步确认，避免误点
let reclaimArm = null;   // 已点过一次「收回任务」的任务编号
let reclaimError = null;
export function reclaimBox(t) {
  const armed = reclaimArm === t.id;
  return [
    el('h4', null, '原窗口已关闭？'),
    el('p', { class: 'hint' }, isDemoTask(t)
      ? (armed ? `确认收回？${agentLabel(t.assignee)} 将被标记为离线，本次演播记为中断，演播卡回到待演播。` : `如 ${agentLabel(t.assignee)} 的窗口已关闭或 token 已用尽，可立即收回，演播卡回到待演播并恢复派发。`)
      : armed
      ? `确认收回？${agentLabel(t.assignee)} 将被标记为离线，任务退回待领取，由同角色 worker 接手，已有改动保留。`
      : `如 ${agentLabel(t.assignee)} 的窗口已关闭或 token 已用尽，无需等待超时，可立即收回并交由新 worker 接手。如窗口仅停止响应，使用唤醒提示词即可。`),
    el('div', { class: 'prompt' },
      el('button', {
        class: armed ? 'btn primary' : 'btn',
        onclick: async (e) => {
          e.stopPropagation();
          if (!armed) { reclaimArm = t.id; reclaimError = null; renderDrawer(false); return; }
          reclaimArm = null;
          try {
            const res = await fetch('/api/reclaim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: t.id, text: '用户在看板上收回' }) });
            const out = await res.json();
            reclaimError = out.ok ? null : out.message;
          } catch { reclaimError = '无法连接 ateam 服务。'; }
          await poll();
          renderDrawer(false);
        },
      }, armed ? '确认收回' : '收回任务'),
      armed ? el('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); reclaimArm = null; renderDrawer(false); } }, '取消') : null,
      reclaimError ? el('span', { class: 'hint' }, reclaimError) : null),
  ];
}
