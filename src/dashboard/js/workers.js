// 页头 worker 一排（拖动排序、收窄）、leader 状态、worker 卡片上的留言和停用

import { prefs } from './prefs.js';
import { data } from './state.js';
import {
  agentLabel, ago, avatar, avText, criticProgress, el, fill, fmtTime, icon, idHasRole, post, roleStyle
} from './util.js';
import { closeHelper, openHelper, promptBlock, renderHelper } from './helper.js';
import { poll } from './app.js';

// 顶部 worker 一排可以拖动排序：顺序只存在这个浏览器里（编号列表），没排过的新 worker 按默认顺序接在后面
let workerOrder = [];
try { workerOrder = JSON.parse(prefs.get('ateam.workerOrder') || '[]'); } catch {}
let workerDrag = null; // 正在拖的编号；拖动中轮询不重画这一排，免得拖到一半被换掉
function sortByWorkerOrder(list) {
  const rank = (a) => { const i = workerOrder.indexOf(a.id); return i < 0 ? Infinity : i; };
  return list.map((a, i) => [a, i]).sort(([a, i], [b, j]) => (rank(a) - rank(b)) || (i - j)).map(([a]) => a);
}
// 按住拖动：标签跟着指针走，经过别的标签时对方滑开让位（FLIP 动画），松手后落到空出来的位置。
// 移动超过 4 像素才算拖动，否则照常是点击；拖动后的那次点击吞掉，不打开面板
function dragChip(chip, id) {
  chip.dataset.id = id;
  chip.addEventListener('pointerdown', (down) => {
    if (down.button !== 0) return;
    const box = chip.parentElement;
    const startX = down.clientX;
    const grab = startX - chip.getBoundingClientRect().left; // 按在标签上的位置
    let moved = false;
    const slots = () => [...box.querySelectorAll('.worker[data-id]')];
    // 布局位置（不含拖动的位移），用来算拖到哪了、标签该偏多少
    const baseLeft = (n) => n.getBoundingClientRect().left - (Number(n.dataset.dx) || 0);
    const move = (e) => {
      if (!moved) {
        if (Math.abs(e.clientX - startX) < 4) return;
        moved = true;
        workerDrag = id;
        chip.setPointerCapture(down.pointerId);
        chip.classList.add('dragging');
      }
      e.preventDefault();
      const others = slots().filter((n) => n !== chip);
      // 指针越过谁的中线，就排到谁后面
      const x = e.clientX - grab + chip.offsetWidth / 2;
      const before = others.find((n) => x < baseLeft(n) + n.offsetWidth / 2) ?? null;
      const want = before ?? (others.at(-1)?.nextSibling ?? null);
      if (chip.nextSibling !== want && chip !== want) {
        // FLIP：记下别的标签原来的位置，挪完 DOM 后从原位置滑到新位置
        const was = new Map(others.map((n) => [n, n.getBoundingClientRect().left]));
        box.insertBefore(chip, want);
        for (const n of others) {
          const d = was.get(n) - n.getBoundingClientRect().left;
          if (!d) continue;
          n.style.transition = 'none';
          n.style.transform = `translateX(${d}px)`;
          requestAnimationFrame(() => { n.style.transition = 'transform .18s ease'; n.style.transform = ''; });
        }
      }
      const dx = e.clientX - grab - baseLeft(chip);
      chip.dataset.dx = dx;
      chip.style.transform = `translateX(${dx}px)`;
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      if (!moved) return;
      // 吞掉拖动结束时的那次点击
      addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); }, { capture: true, once: true });
      chip.style.transition = 'transform .16s ease';
      chip.style.transform = '';
      delete chip.dataset.dx;
      const ids = slots().map((n) => n.dataset.id);
      // 已离线的编号也留着：它们用原编号重连时回到原来的位置
      workerOrder = [...ids, ...workerOrder.filter((x) => !ids.includes(x))].slice(0, 200);
      try { prefs.set('ateam.workerOrder', JSON.stringify(workerOrder)); } catch {}
      setTimeout(() => { chip.classList.remove('dragging'); chip.style.transition = ''; workerDrag = null; renderWorkers(); }, 170);
    };
    addEventListener('pointermove', move, { passive: false });
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  });
}
export function renderWorkers() {
  if (workerDrag) return;
  const box = document.getElementById('workers');
  const agents = data.state.agents;
  // 掉线的 worker 不再占位：只显示在线的，掉线的折叠成一个灰色计数，鼠标悬停可看编号
  const online = agents.filter((a) => a.status === 'online');
  const offline = agents.filter((a) => a.status !== 'online' && !a.hidden);
  const leader = data.leader || {};
  const leaderChip = el('button', {
    type: 'button',
    class: `worker leader-chip ${leader.online && !leader.away ? 'online' : 'offline-lead'}`,
    title: leader.online && !leader.away
      ? (leader.watching ? 'leader 在线，正在监听事件。点击查看 leader 提示词' : `leader ${ago(leader.lastSeenAt)}有操作，但未在监听事件。点击查看提示词`)
      : leader.away
        ? `无 leader 模式（${fmtTime(leader.away.since)} 起，${leader.away.by === 'user' ? '手动设置' : '检测到 leader 离线'}）：等待答复、待 review 的任务暂时搁置，worker 转做无依赖的任务；leader 恢复后自动退出。点击查看加入提示词`
        : 'leader 未连接：未在监听事件，且近 3 分钟无操作。点击查看加入提示词',
    onclick: (e) => { e.stopPropagation(); openHelper({ tab: 'lead' }); },
  }, el('span', { class: 'av' }, 'L'), el('b', null, 'leader'), el('span', { class: `task${leader.online && leader.watching && !leader.away ? ' idle' : ''}` }, leader.away ? '无 leader 模式' : leader.online ? (leader.watching ? '在线' : '在线，未监听') : '未连接'));
  // 审卡 worker 和 leader 一样常驻，紧挨着 leader 放
  const isCriticAgent = (a) => a.role.trim().toLowerCase() === 'critic';
  const chips = [leaderChip, ...sortByWorkerOrder([...online.filter(isCriticAgent), ...online.filter((a) => !isCriticAgent(a))]).map((a) => {
    const chip = el('button', {
      type: 'button',
      class: 'worker online',
      style: roleStyle(a.role),
      title: `${agentLabel(a.id)}，心跳 ${ago(a.lastSeenAt)}。点击查看提示词，拖动可调整顺序`,
      onclick: (e) => { e.stopPropagation(); openHelper({ focus: a.id }); },
    },
    el('span', { class: 'av' }, avText(a.name || a.id)),
    // 新编号本身带角色（frontend-2），就不再单独写角色，只按角色上色；老编号（fr-cbb7）照旧显示角色
    el('b', { class: 'role-text', style: roleStyle(a.role) }, a.name || a.id),
    a.name ? el('span', { class: 'task wid' }, a.id) : null,
    idHasRole(a) ? null : el('span', { class: 'role-text', style: roleStyle(a.role) }, a.role),
    el('span', { class: `task${!isCriticAgent(a) && !a.currentTask && !a.leaveAsked ? ' idle' : ''}` }, isCriticAgent(a) ? criticProgress(a) : a.currentTask ? (a.dismiss ? `${a.currentTask}，完成后下线` : a.currentTask) : (a.leaveAsked ? '空闲，已申请下线' : '空闲')),
  );
    dragChip(chip, a.id);
    return chip;
  })];
  if (offline.length) {
    chips.push(el('button', {
      type: 'button', class: 'worker offline', title: '点击查看或移除已离线的 worker',
      onclick: (e) => { e.stopPropagation(); openHelper({ mode: 'offline' }); },
    }, `${offline.length} 个已离线`));
  }
  if (chips.length === 1) chips.push(el('span', { class: 'hint' }, '暂无 worker 加入，可在右侧「帮助」中添加 worker'));
  box.replaceChildren(...chips);
  fitWorkers();
  renderHelper();
}
// 顶部 worker 一排：先按完整样子（名字 + 任务）排，放不下才收成只有头像和任务号
function fitWorkers() {
  const box = document.getElementById('workers');
  if (!box) return;
  const over = () => box.scrollWidth > box.clientWidth + 1;
  box.classList.remove('tight', 'compact');
  if (!over()) return;
  box.classList.add('tight');
  if (over()) box.classList.add('compact');
}
addEventListener('resize', () => fitWorkers());
// 在线 worker 超过 3 分钟没有任何动静（挂着 wait 的 worker 最多 90 秒就会刷新一次心跳）→ 多半停住了
const STALE_MS = 3 * 60 * 1000;
export function isStale(a) {
  return a.status === 'online' && Date.now() - a.lastSeenAt > STALE_MS;
}
const msgDrafts = new Map(); // worker 编号 → 没发出去的草稿
let msgState = { id: null, sending: false, error: '', sent: '' };
export function resetMsgState() { msgState = { id: null, sending: false, error: '', sent: '' }; }
export let dismissArm = null; // 单个 worker 下线的两步确认（手上有任务，或是本角色最后一个时）
// 本角色唯一在线的 worker（已安排「做完再下线」的不算）：每个角色至少留一个，下线前要用户确认
export function isLastOfRole(a) {
  if (a.dismiss) return false;
  const role = a.role.trim().toLowerCase();
  return data.state.agents.filter((x) => x.status === 'online' && !x.dismiss && x.role.trim().toLowerCase() === role).length === 1;
}
// leader 的状态卡（「帮助 → leader」最上面）：和 worker 卡一样，右边是下线 / 恢复。
// 下线 = 进入无 leader 模式：token 用完、暂时回不来时用
async function setLeaderAway(on) {
  try {
    await fetch('/api/leader/away', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on }) });
  } catch {}
  await poll();
  renderHelper(true);
}
export function leaderCard() {
  const leader = data.leader || {};
  const away = leader.away;
  const state = away ? `无 leader 模式 · ${fmtTime(away.since)} 起${away.by === 'user' ? '，手动设置' : '，检测到离线'}`
    : leader.online ? (leader.watching ? '在线，正在监听' : `在线，未监听 · ${ago(leader.lastSeenAt)}有操作`) : '未连接';
  return el('div', { class: 'wcard' },
    el('div', { class: 'wcard-head' },
      el('span', { class: 'av' }, 'L'),
      el('span', { class: 'grow' }, el('span', { class: 'who-line' }, el('b', null, 'leader'), el('span', { class: 'hint' }, state))),
      el('button', { class: 'btn ghost sm', title: away ? '退出无 leader 模式，搁置的任务交由 leader 处理' : '进入无 leader 模式', onclick: (e) => { e.stopPropagation(); setLeaderAway(!away); } }, away ? '恢复' : '下线')),
    el('p', { class: 'hint' }, away
      ? `等待答复、待 review 的任务已搁置，worker 优先处理无依赖且不涉及相同文件的任务。${away.by === 'user' ? 'leader 执行任意命令（后台监听除外）' : 'leader 重新开始监听或执行命令'}后自动恢复。`
      : 'leader 因 token 用尽等原因暂时无法响应时，可点击「下线」进入无 leader 模式：worker 搁置等待答复、待 review 的任务，转做无依赖且不涉及相同文件的任务。leader 执行任意命令后自动恢复，依次处理答复与 review，任务交回原 worker。也可在「设置」中开启离线时自动进入。'),
    leader.online || away ? promptBlock(leadWakePrompt(), renderHelper) : el('p', { class: 'hint' }, 'leader 未连接：请使用 ① 中的提示词重新启动。'));
}
function leadWakePrompt() {
  return '继续。你是 ateam leader。先运行 ateam status，按「待你处理」继续（先答复，再 review）；如果后台的 ateam watch --follow 监听停了，用 Monitor 重新启动它。中途不要停下来等我。';
}
// worker 在 since 之后最近领的一张卡（老数据没记 parkedFor 时，从历史里找它转做了哪张）
export function lastClaimSince(agentId, since) {
  let best = null;
  for (const x of data.state.tasks) {
    for (const h of x.history) if (h.type === 'claimed' && h.actor === agentId && h.ts >= since && (!best || h.ts > best.ts)) best = { id: x.id, ts: h.ts };
  }
  return best?.id ?? null;
}
export function messageBox(a) {
  const mine = msgState.id === a.id ? msgState : { sending: false, error: '', sent: '' };
  const area = el('textarea', { class: 'reply-input msg-input', rows: '3', placeholder: `填写给 ${agentLabel(a.id)} 的消息…` });
  area.value = msgDrafts.get(a.id) || '';
  const send = async () => {
    const text = area.value.trim();
    if (!text || msgState.sending) return;
    area.blur(); // 输入框有焦点时面板不重画，先放开，才看得到「发送中」和结果
    msgState = { id: a.id, sending: true, error: '', sent: '' };
    renderHelper(true);
    const out = await post('/api/message', { to: a.id, text, by: 'user' });
    if (out.ok) { msgDrafts.delete(a.id); msgState = { id: a.id, sending: false, error: '', sent: out.taskId ? `已作为 ${out.taskId} 的补充说明发送，并同步通知 leader。` : '已发送，并同步通知 leader。' }; }
    else msgState = { id: a.id, sending: false, error: out.message || '发送失败。', sent: '' };
    await poll();
    renderHelper(true);
  };
  area.addEventListener('input', () => { msgDrafts.set(a.id, area.value); });
  area.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } });
  const foot = mine.error ? el('span', { class: 'hint err' }, mine.error)
    : mine.sent ? el('span', { class: 'hint' }, mine.sent)
    : el('span', { class: 'hint' }, '将同时通知 leader · ⌘↩ 发送');
  return el('div', { class: 'reply-box' },
    el('div', { class: 'composer', onclick: () => area.focus() }, area,
      el('div', { class: 'reply-foot' }, foot,
        el('button', { class: 'btn primary sm', disabled: mine.sending, onclick: (e) => { e.stopPropagation(); send(); } }, mine.sending ? '发送中…' : '发送'))));
}
export function dismissButtons(a) {
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  // 设置里关了「每个角色至少保留一个 worker」时，最后一个也和别的一样直接下线，不再确认
  const last = (data.config?.keepOnePerRole ?? true) && isLastOfRole(a);
  const lastTip = last ? `该 worker 是 ${a.role} 角色唯一在线的 worker，下线后该角色的新任务将无人领取` : '';
  // 已安排做完再下线：可以撤销，或改成立即下线
  if (a.dismiss) {
    return [
      el('button', { class: 'btn ghost sm', title: '撤销「完成后下线」，该 worker 将继续领取新任务', onclick: stop(() => keepAgents([a.id])) }, '撤销'),
      el('button', { class: 'btn ghost sm', title: '立即下线；进行中的任务退回待领取', onclick: stop(() => dismissAgents({ ids: [a.id], userApproved: true })) }, '立即下线'),
    ];
  }
  const critic = a.role.trim().toLowerCase() === 'critic';
  if (dismissArm !== a.id) {
    return el('button', {
      class: 'btn ghost sm',
      onclick: stop(() => {
        // 手上有任务（可以选做完再下线）、审卡 worker（可以选审完再下线），或是本角色最后一个 worker：先确认
        if (a.currentTask || last || critic) { dismissArm = a.id; renderHelper(); return; }
        dismissAgents({ ids: [a.id] });
      }),
    }, '下线');
  }
  const cancel = el('button', { class: 'btn sm', onclick: stop(() => { dismissArm = null; renderHelper(); }) }, '取消');
  if (critic) {
    return [
      cancel,
      el('button', {
        class: 'btn sm', title: '审核完所有待审任务（含审核期间新增的）后下线',
        onclick: stop(() => { dismissArm = null; dismissAgents({ ids: [a.id], userApproved: true, afterTask: true }); }),
      }, '审核完成后下线'),
      el('button', {
        class: 'btn warn sm', title: '立即停止，未审核的任务保留至下次审卡 worker 上线',
        onclick: stop(() => { dismissArm = null; dismissAgents({ ids: [a.id], userApproved: true }); }),
      }, '立即下线'),
    ];
  }
  if (!a.currentTask) {
    return [cancel, el('button', {
      class: 'btn warn sm', title: lastTip,
      onclick: stop(() => { dismissArm = null; dismissAgents({ ids: [a.id], userApproved: true }); }),
    }, '确认下线')];
  }
  return [
    cancel,
    el('button', {
      class: 'btn sm', title: `完成 ${a.currentTask}（通过或作废）后下线，期间不再领取新任务。${lastTip}`,
      onclick: stop(() => { dismissArm = null; dismissAgents({ ids: [a.id], userApproved: true, afterTask: true }); }),
    }, `完成 ${a.currentTask} 后下线`),
    el('button', {
      class: 'btn warn sm', title: `立即停止；${a.currentTask} 若仍在进行中，将退回待领取。${lastTip}`,
      onclick: stop(() => { dismissArm = null; dismissAgents({ ids: [a.id], userApproved: true }); }),
    }, '立即下线'),
  ];
}
// 手上的任务被作废、但 worker 还没收到通知（它正在干活，要等下一次调用 ateam 命令才知道）。
// 用户可以在 agent 窗口里点停止，把这句话发过去，让它马上停手。
export function pendingCancel(a) {
  if (a.status !== 'online' || !a.cancelNotice?.wasWorking) return null;
  return data.state.tasks.find((t) => t.id === a.cancelNotice.taskId) || null;
}
export function stopPrompt(a, t) {
  return `停下。你手上的任务 ${t.id} 已被作废，立即停手，不要提交。把你为它做的改动还原掉，只动你自己改过的文件：改过的已有文件逐个 git checkout -- <文件路径>，你新建的文件逐个删掉；不要用 git clean、git stash，也不要对整个目录 checkout，同一目录里可能有别人正在改的文件。然后运行 ateam wait --as ${a.id} 回到主循环，中途不要停下来汇报。`;
}
export function wakePrompt(a) {
  const doing = a.currentTask ? `继续做 ${a.currentTask}，做完提交后` : '';
  return `继续。你是 ateam worker ${a.id}（角色 ${a.role}）。${doing}运行 ateam wait --as ${a.id} 回到主循环，中途不要停下来汇报。如果提示租约已失效，就重新 ateam join --role ${a.role} --id ${a.id}${a.name ? ` --name ${a.name}` : ''}。`;
}
export async function dismissAgents(body) {
  try {
    await fetch('/api/dismiss', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {}
  await poll();
  renderHelper();
}
async function keepAgents(ids) {
  try {
    await fetch('/api/agents/keep', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
  } catch {}
  await poll();
  renderHelper();
}
async function hideAgents(ids) {
  try {
    await fetch('/api/agents/hide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
  } catch {}
  await poll();
}
let reconnectOpen = null; // 展开了重连提示词的掉线 worker 编号
// 掉线的 worker 窗口还在时，发给它的那句话：旧编号已失效，重新加入后接着主循环
export function reconnectPrompt(a) {
  const name = a.name ? ` --name ${a.name}` : '';
  return `继续。你是 ateam worker ${a.id}（角色 ${a.role}），已经掉线。请按 ateam-worker skill 运行 ateam join --role ${a.role} --id ${a.id}${name} 重新加入（沿用原编号），然后进入 ateam wait 主循环；如果领到「⚠ 接手任务」，先看历史和 git status，在已有改动上继续。中途不要停下来汇报。`;
}
export function renderOfflinePanel(panel) {
  const offline = data.state.agents.filter((a) => a.status !== 'online' && !a.hidden)
    .sort((x, y) => y.lastSeenAt - x.lastSeenAt);
  const close = () => { closeHelper(); };
  if (!offline.length) { close(); return; }
  fill(panel,
    el('div', { class: 'panel-top', style: 'padding-bottom: 12px' },
      el('div', { class: 'helper-head' },
        el('b', null, `已离线的 worker（${offline.length}）`),
        el('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); hideAgents(offline.map((a) => a.id)); } }, '全部移除'),
        el('button', { class: 'btn ghost icon', title: '关闭', 'aria-label': '关闭', onclick: (e) => { e.stopPropagation(); close(); } }, icon('close')))),
    el('div', { class: 'panel-body' },
    el('p', { class: 'tab-hint' }, '窗口仍在：点击「重连」，将提示词发送至该 worker 的 agent 窗口，worker 将以原编号重新加入并继续工作。窗口已关闭：点击「移除」，仅从列表中隐藏，任务时间线中的记录保留。'),
    offline.map((a) => el('div', { class: 'wcard' },
      el('div', { class: 'wcard-head' },
        avatar(a.id, a.role),
        el('span', { class: 'grow' },
          el('span', { class: 'who-line' }, el('b', null, agentLabel(a.id)), el('span', { class: 'hint' }, `最后心跳 ${ago(a.lastSeenAt)}`)),
          el('span', { class: 'tag role', style: roleStyle(a.role) }, a.role)),
        el('button', {
          class: reconnectOpen === a.id ? 'btn primary sm' : 'btn sm',
          onclick: (e) => { e.stopPropagation(); reconnectOpen = reconnectOpen === a.id ? null : a.id; renderHelper(); },
        }, '重连'),
        el('button', { class: 'btn ghost sm', onclick: (e) => { e.stopPropagation(); hideAgents([a.id]); } }, '移除')),
      reconnectOpen === a.id ? promptBlock(reconnectPrompt(a), renderHelper) : null))));
  panel.hidden = false;
}
