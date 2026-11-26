// 帮助面板：给 worker 的提示词、安装引导、启动 worker、缺人提示

import { data } from './state.js';
import { agentLabel, ago, avatar, criticProgress, el, fill, icon, roleStyle } from './util.js';
import {
  dismissAgents, dismissArm, dismissButtons, isLastOfRole, isStale, leaderCard, messageBox, pendingCancel,
  reconnectPrompt, renderOfflinePanel, resetMsgState, stopPrompt, wakePrompt
} from './workers.js';
import { clearSettingsMsg, settingsPage, testTemplateEditor, testTpl } from './settings.js';
import { pushPage, resetPush } from './push.js';
import { loadRules, rulesEditor } from './rules.js';
import { installGuide, resetInstallInfo } from './install.js';
import { spawnButton, spawnMessage, STANDARD_ROLES } from './spawn.js';
import { jumpToTask } from './menu.js';
import { render } from './app.js';

let copied = null; // 刚复制的提示词，用来显示「已复制」
let dismissAllArm = false; // 「全部下线」两步确认
let msgArm = null; // 正在给哪个 worker 写消息

// 面板状态：open、focus（展开哪个 worker）、tab（哪一页）、mode。别的文件用 openHelper / closeHelper 开关
export let helper = { open: false, focus: null };
export function openHelper(opts = {}) { helper = { open: true, focus: null, ...opts }; renderHelper(); }
export function closeHelper() { helper = { open: false, focus: null }; renderHelper(); }
export const openGuide = (tab) => el('button', { class: 'btn primary', onclick: (e) => { e.stopPropagation(); openHelper({ tab }); } }, tab === 'lead' ? '查看 leader 提示词' : '打开帮助');

export function renderHelper(force = false) {
  const panel = document.getElementById('helper');
  if (!helper.open || !data) { panel.hidden = true; panel.replaceChildren(); return; }
  // 正在编辑规则：轮询刷新不重画面板，免得输入框被替换、打字丢失
  if (!force && helper.tab === 'rules' && panel.querySelector('.rules-page')) return;
  if (!force && (helper.tab === 'settings' || helper.tab === 'push') && (document.activeElement?.classList?.contains('setting-num') || document.activeElement?.classList?.contains('setting-text')) && panel.contains(document.activeElement)) return;
  if (!force && document.activeElement?.classList?.contains('msg-input') && panel.contains(document.activeElement)) return;
  // 正在编辑测试报告模板：同项目规则，轮询不重画
  if (!force && helper.tab === 'tests' && panel.querySelector('.tpl-page')) return;
  if (helper.mode === 'offline') { renderOfflinePanel(panel); return; }
  const { agents, tasks } = data.state;
  const online = agents.filter((a) => a.status === 'online');
  const offline = agents.filter((a) => a.status !== 'online' && !a.hidden)
    .sort((x, y) => y.lastSeenAt - x.lastSeenAt);
  // 角色：标准四个角色 + 还没完成的任务用到的角色 + 所有（未移除的）worker 用过的角色
  const roles = new Map(STANDARD_ROLES.map((r) => [r.key, r.key]));
  for (const t of tasks) if (t.status !== 'approved' && t.status !== 'cancelled') roles.set(t.role.trim().toLowerCase(), t.role);
  for (const a of agents) if (!a.hidden) roles.set(a.role.trim().toLowerCase(), a.role);
  const ordered = online.slice().sort((x, y) => (y.id === helper.focus) - (x.id === helper.focus) || isStale(y) - isStale(x));
  const closeBtn = el('button', { class: 'btn ghost icon', title: '关闭', 'aria-label': '关闭', onclick: (e) => { e.stopPropagation(); helper = { open: false, focus: null }; dismissAllArm = false; renderHelper(); } }, icon('close'));
  const dismissAll = online.length ? [
    dismissAllArm ? el('button', { class: 'btn ghost sm', onclick: (e) => { e.stopPropagation(); dismissAllArm = false; renderHelper(); } }, '取消') : null,
    el('button', {
      class: dismissAllArm ? 'btn warn sm' : 'btn sm',
      title: '所有 worker 立即下线；进行中的任务退回待领取',
      onclick: (e) => {
        e.stopPropagation();
        if (!dismissAllArm) { dismissAllArm = true; renderHelper(); return; }
        dismissAllArm = false;
        dismissAgents({ all: true, userApproved: true });
      },
    }, dismissAllArm ? '确认全部下线' : '全部下线'),
  ] : null;
  const tab = ['lead', 'install', 'rules', 'tests', 'settings', 'push'].includes(helper.tab) ? helper.tab : 'worker';
  const tabBtn = (key, label) => el('button', {
    type: 'button', role: 'tab', class: `tab${tab === key ? ' on' : ''}`, 'aria-selected': tab === key ? 'true' : 'false',
    onclick: (e) => {
      e.stopPropagation();
      helper = { ...helper, tab: key };
      dismissAllArm = false;
      if (key === 'rules') loadRules();
      if (key === 'tests' && !testTpl.loading) testTpl.loaded = false; // 每次切进来重新读，别处改过也能看到
      if (key === 'install') resetInstallInfo(); // 每次切进「安装」页重新读一遍本机情况
      if (key === 'push') resetPush(); // 每次切进「推送」重新读配置
      clearSettingsMsg();
      renderHelper(true);
    },
  }, label);
  const scroll = panel.hidden ? 0 : panel.scrollTop;
  fill(panel,
    el('div', { class: 'panel-top' },
      el('div', { class: 'helper-head' }, el('b', null, '帮助'), closeBtn),
      el('div', { class: 'tabs', role: 'tablist' }, tabBtn('worker', 'worker'), tabBtn('lead', 'leader'), tabBtn('install', '安装'), tabBtn('rules', '项目规则'), tabBtn('tests', '测试用例'), tabBtn('push', '推送'), tabBtn('settings', '设置'))),
    el('div', { class: 'panel-body' },
    tab === 'rules' || tab === 'settings' || tab === 'tests' || tab === 'install' || tab === 'push' ? null : el('p', { class: 'tab-hint' }, data.root ? `请将 agent 窗口的工作目录设为 ${data.root}，再发送对应的提示词。` : '请将各段提示词发送至对应的 agent 窗口。'),
    tab === 'push' ? pushPage() : tab === 'settings' ? settingsPage() : tab === 'tests' ? testTemplateEditor() : tab === 'rules' ? rulesEditor() : tab === 'install' ? installGuide() : tab === 'worker' ? [
    el('div', { class: 'helper-sec' }, el('h4', null, '① 添加 worker')),
    el('p', { class: 'hint' }, '新建 agent 窗口（可使用其他账号），工作目录选择项目目录，发送对应角色的提示词。如需命名，在第一行末尾添加「，名字 账号B」。'),
    [...roles.values()].map((role) => {
      const key = role.trim().toLowerCase();
      const std = STANDARD_ROLES.find((r) => r.key === key);
      const waiting = tasks.filter((t) => t.status === 'pending' && t.role.trim().toLowerCase() === key).length;
      const working = online.filter((a) => a.role.trim().toLowerCase() === key).length;
      return el('div', { class: 'wcard' },
        el('div', { class: 'wcard-head' },
          el('span', { class: 'tag role', style: roleStyle(role) }, role),
          std ? el('b', null, std.label) : null,
          el('span', { class: 'hint grow' }, std ? std.what : ''),
          el('span', { class: `role-count${waiting && !working ? ' short' : ''}`, title: waiting && !working ? '有待领取的任务，但没有在线 worker' : '' }, `在线 ${working} · 待领取 ${waiting}`),
          spawnButton(role)),
        promptBlock(workerPrompt(role), renderHelper),
        spawnMessage(role));
    }),
    el('div', { class: 'helper-sec' }, el('h4', null, `② 在线 worker（${online.length}）`), dismissAll),
    el('p', { class: 'hint' }, dismissAllArm
      ? '确认后所有 worker 立即下线；进行中的任务退回待领取，已有改动保留。'
      : 'worker 停止响应时，复制其唤醒提示词并发送至该 worker 的 agent 窗口。'),
    ordered.length ? ordered.map((a) => el('div', { class: `wcard${a.id === helper.focus ? ' focus' : ''}` },
      el('div', { class: 'wcard-head' },
        avatar(a.id, a.role),
        el('span', { class: 'grow' },
          el('span', { class: 'who-line' },
            el('b', null, agentLabel(a.id)),
            el('span', { class: 'hint' },
              a.role.trim().toLowerCase() === 'critic' ? criticProgress(a)
                : a.currentTask && data.state.tasks.some((t) => t.id === a.currentTask)
                  // 卡号可点：关掉面板，切到那张卡所在的需求并打开详情
                  ? ['正在处理 ', el('a', { href: '#', class: 'task-jump', title: `跳转到 ${a.currentTask} 并打开卡片详情`, onclick: (e) => { e.preventDefault(); e.stopPropagation(); closeHelper(); jumpToTask(a.currentTask); } }, a.currentTask)]
                  : (a.currentTask ? `正在处理 ${a.currentTask}` : '空闲'),
              ` · 心跳 ${ago(a.lastSeenAt)}`)),
          el('span', { class: 'tag role', style: roleStyle(a.role) }, a.role),
          isStale(a) ? el('span', { class: 'pill' }, '无响应') : null,
          a.leaveAsked ? el('span', { class: 'pill', title: '空闲超时，已向 leader 申请下线' }, '申请下线') : null,
          a.rotate && !a.dismiss ? el('span', { class: 'pill', title: `上下文约 ${a.rotate} 万 token，超过「设置 → 换新会话的上下文阈值」：当前任务通过后下线，由新的 worker 接着处理` }, '完成后换新会话') : null,
          a.dismiss ? el('span', { class: 'pill', title: a.role.trim().toLowerCase() === 'critic' ? '审核完待审任务后下线' : '完成当前任务后下线，不再领取新任务' }, a.role.trim().toLowerCase() === 'critic' ? '审完后下线' : '完成后下线') : null,
          pendingCancel(a) ? el('span', { class: 'pill', title: '该 worker 仍在处理已作废的任务' }, `${pendingCancel(a).id} 已作废，尚未通知到`) : null),
        dismissArm === a.id ? null : el('span', { class: 'wcard-acts' },
          el('button', { class: 'btn ghost sm', title: '直接向该 worker 发送消息', onclick: (e) => { e.stopPropagation(); msgArm = msgArm === a.id ? null : a.id; resetMsgState(); renderHelper(true); document.querySelector('#helper .msg-input')?.focus(); } }, '发消息'),
          dismissButtons(a))),
      msgArm === a.id ? messageBox(a) : null,
      // 点了「下线」要选怎么下线：单独一条确认栏，按钮不挤在名字那一行里折行
      // 确认时叫醒话先收起来，卡片里只留这一件事
      dismissArm === a.id ? el('div', { class: 'wcard-confirm' },
        el('p', { class: 'q' }, `选择 ${agentLabel(a.id)} 的下线方式`),
        isLastOfRole(a) ? el('p', { class: 'warn-note' }, `该 worker 是 ${a.role} 角色唯一在线的 worker，下线后该角色的新任务将无人领取`) : null,
        el('div', { class: 'wcard-acts' }, dismissButtons(a)))
      : pendingCancel(a) ? [
        el('p', { class: 'hint' }, `${pendingCancel(a).id} 已作废，但该 worker 正在工作，需在下次调用 ateam 命令时才会收到通知。如需立即停止，请在其 agent 窗口中点击停止，并发送以下提示词。`),
        promptBlock(stopPrompt(a, pendingCancel(a)), renderHelper),
      ] : promptBlock(wakePrompt(a), renderHelper))) : el('p', { class: 'hint' }, '暂无在线 worker。'),
    offline.length ? [
      el('div', { class: 'helper-sec' }, el('h4', null, `③ 已离线 worker（${offline.length}）`)),
      el('p', { class: 'hint' }, 'agent 窗口仍在但已离线时：将重连提示词发送至该窗口，worker 将以原编号重新加入并继续工作，无需修改窗口标题。'),
      offline.map((a) => el('div', { class: 'wcard' },
        el('div', { class: 'wcard-head' },
          avatar(a.id, a.role),
          el('span', { class: 'grow' },
            el('span', { class: 'who-line' }, el('b', null, agentLabel(a.id)), el('span', { class: 'hint' }, `最后心跳 ${ago(a.lastSeenAt)}`)),
            el('span', { class: 'tag role', style: roleStyle(a.role) }, a.role))),
        promptBlock(reconnectPrompt(a), renderHelper))),
    ] : null,
    el('div', { class: 'helper-sec' }, el('h4', null, '④ 结束工作')),
    el('p', { class: 'hint' }, '所有需求完成后，在 ② 中点击「全部下线」，worker 将立即停止；也可在 leader 对话中发出「让大家收工」。'),
    ] : [
    el('div', { class: 'helper-sec' }, el('h4', null, '① 启动 leader')),
    el('p', { class: 'hint' }, '在项目目录中新建 Claude Code 会话，发送以下提示词。每个项目只需一个 leader。'),
    el('div', { class: 'wcard' },
      el('div', { class: 'wcard-head' }, el('b', null, '加入'), el('span', { class: 'hint' }, '新建会话或上下文已满需重开会话时，均使用此提示词')),
      promptBlock(leadPrompt(), renderHelper)),
    el('p', { class: 'hint' }, '加入后，直接在对话中向 leader 描述需求（例如「需求是……」）。leader 将拆分任务、派发给 worker，并告知需要启动的 worker 角色与数量。'),
    el('div', { class: 'helper-sec' }, el('h4', null, `② 在线 leader（${data.leader?.online && !data.leader?.away ? 1 : 0}）`)),
    el('p', { class: 'hint' }, 'leader 停止响应或后台监听中断时，复制唤醒提示词并发送至 leader 会话。token 用尽暂时无法恢复时，请点击「下线」。'),
    leaderCard(),
    ]),
  );
  panel.hidden = false;
  panel.scrollTop = scroll;
}
// leader 的加入提示词：不带需求，先就位；新开会话和会话重开都用这一句
function leadPrompt() {
  return `使用 ateam-lead skill，作为 leader 加入这个项目的团队。
先运行 ateam status 了解现状，再用 Monitor 后台启动 ateam watch --follow 监听。
如果「待你处理」里有事，先接着处理；没有的话，简单告诉我现状（有哪些 worker 在线、有没有没做完的需求），然后等我说需求。不要自己找活干。`;
}
export function workerPrompt(role) {
  return `使用 ateam-worker skill，角色 ${role}`;
}
export function promptBox(role) {
  return promptBlock(workerPrompt(role), render);
}
// 一段可复制的提示词；rerender 用来刷新「已复制」状态
export function promptBlock(text, rerender) {
  const done = copied === text;
  return el('div', { class: 'pblock' },
    el('code', null, text),
    el('button', {
      class: `btn sm${done ? ' done' : ''}`,
      onclick: async (e) => {
        e.stopPropagation();
        try { await navigator.clipboard.writeText(text); copied = text; } catch { copied = null; }
        rerender();
        setTimeout(() => { if (copied === text) { copied = null; rerender(); } }, 2000);
      },
    }, done ? '已复制' : '复制'));
}
