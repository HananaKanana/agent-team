// 工具后 hook：会话绑定、浏览器守卫、ego-browser profile 分配

import { isTestRole } from '../format.js';
import { changed, now, state } from './core.js';
import { addHistory, findAgent, getTask } from './common.js';
import { touch } from './workers.js';
import { isDemo } from './demo.js';

const KEEP_HOOK_SESSIONS = 300; // 编号 → 会话的历史，统计卡的 token 用量时用
// hook 只知道会话，不知道 worker 编号，从 worker 自己跑的 ateam --as 命令里学到。
// 记在 agent 上，随 runtime.json 落盘，服务重启后不用等 worker 再调用一次 ateam
export function bindHookSession(session, agentId) {
  const agent = findAgent(agentId);
  if (!agent || agent.hookSession === session) return;
  // 同一个会话换了编号重新加入：旧编号不再认这个会话
  for (const a of state.agents) if (a.hookSession === session) delete a.hookSession;
  agent.hookSession = session;
  // 另记一份历史：编号会让给新 worker、下线一天后 hookSession 也会清掉，统计旧卡的 token 用量还要用
  const log = (state.hookSessions ??= []);
  if (!log.some((x) => x.agentId === agentId && x.session === session)) {
    log.push({ agentId, session, at: now() });
    if (log.length > KEEP_HOOK_SESSIONS) log.splice(0, log.length - KEEP_HOOK_SESSIONS);
  }
  changed();
}
// hook 记下的编号 → 会话（含历史）
export function boundSessions() {
  const out = [...(state.hookSessions ?? [])].map(({ agentId, session }) => ({ agentId, session }));
  for (const a of state.agents) if (a.hookSession && !out.some((x) => x.session === a.hookSession)) out.push({ agentId: a.id, session: a.hookSession });
  return out;
}
export function agentIdOfHookSession(session) {
  return state.agents.find((a) => a.hookSession === session)?.id ?? null;
}
// 浏览器操作前的 hook 来问：能把浏览器拉到前面的操作放不放行。只有演播卡（用户正看着）可以；
// 其他时候不许激活，新开标签页每个 worker 只放行一次（开了就一直用它）。action：activate / open
export function browserGuard(session, action) {
  const agentId = agentIdOfHookSession(session);
  const agent = agentId && findAgent(agentId);
  if (!agent || agent.status !== 'online') return {};
  const task = agent.currentTask && getTask(agent.currentTask);
  if (task && isDemo(task)) return {};
  if (!isTestRole(task?.role ?? agent.role)) {
    return { deny: `浏览器只给测试卡用，${task ? `${task.id} 是 ${task.role} 卡` : `你的角色是 ${agent.role}`}：自查只做编译、构建、跑项目已有的测试和代码审阅，不打开浏览器验证页面，也不为验证起服务做端到端。功能验证交给测试卡；提交时如实写验证到哪一步。确实需要看页面，用 ateam ask --as ${agent.id} 说明原因。` };
  }
  if (action === 'use') return {};
  if (action === 'activate') {
    return { deny: `不允许把标签页或浏览器切到前面：这会抢走用户正在用的窗口的焦点，只有演播卡可以。直接在后台标签页里操作（点击、输入、核对、截图都不需要它在前面）。确实操作不了，用 ateam ask --as ${agent.id} 请用户切过去，不要换别的办法置顶。` };
  }
  if (action === 'open' && agent.tabOpened) {
    return { deny: `你已经开过一个标签页，再开会抢走用户的焦点。先列出标签页，用你自己的那个，换页面就在它里面跳转。确实没有了（被关掉、浏览器重启过），运行 ateam tab-lost --as ${agent.id} 后再开一次。` };
  }
  if (action === 'open') {
    agent.tabOpened = true;
    changed();
  }
  return {};
}
// worker 自己的标签页没了（被关、浏览器重启）：下一次新开放行
export function tabLost(agentId) {
  const agent = touch(agentId);
  delete agent.tabOpened;
  changed();
  return agent;
}
// worker 回执经 hook 收到的补充说明：送出的那段算已读、不再重复给；之后新追加的留着，hook 会再送
// ego-browser 测试用 profile 分配（名称以 ateam 开头的 profile，服务从 ego 读出列表传进来）。
// 一个 profile 同时只给一个 worker：被别的 worker 进行中的卡（含预演、演播）占着就不给。占用直接按卡的状态算，
// 卡提交、作废、收回或 worker 下线后状态一变就自然空出来，不单独记释放。
// 优先级：这个 worker 手上别的卡正在用的 → 这张卡上次用的（打回重做、预演后演播，登录状态和空间都在）→ 这个 worker 上次用的 → 第一个空闲的。
// 都被占：返回 { shared: true }，worker 用默认 profile，可能和别人共用登录状态
const EGO_ACTIVE = ['working', 'asking', 'demoing', 'wrapping'];
export function assignEgoProfile(taskId, agentId, list) {
  if (!list?.length) return null;
  const task = getTask(taskId);
  const agent = findAgent(agentId);
  const held = new Set(state.tasks.filter((t) => t !== task && t.egoProfile && !t.egoShared && EGO_ACTIVE.includes(t.status) && t.assignee && t.assignee !== agentId).map((t) => t.egoProfile.id));
  const free = (id) => id && list.some((p) => p.id === id) && !held.has(id);
  const mine = state.tasks.find((t) => t !== task && t.egoProfile && !t.egoShared && EGO_ACTIVE.includes(t.status) && t.assignee === agentId)?.egoProfile?.id;
  const pick = [mine, task.egoProfile?.id, agent?.egoProfile].find(free) ?? list.find((p) => free(p.id))?.id;
  if (!pick) {
    if (!task.egoShared) {
      task.egoShared = true;
      addHistory(task, 'profile', agentId, `测试用的 ego profile（${list.map((p) => p.name).join('、')}）均被其他 worker 占用，本次使用默认 profile，可能与其他 worker 共用登录状态`);
      changed();
    }
    return { shared: true, names: list.map((p) => p.name) };
  }
  const profile = list.find((p) => p.id === pick);
  if (task.egoProfile?.id !== pick || task.egoShared) {
    const before = task.egoProfile && !task.egoShared ? task.egoProfile.name : null;
    task.egoProfile = { id: profile.id, name: profile.name };
    delete task.egoShared;
    addHistory(task, 'profile', agentId, before ? `测试用的 ego profile 由「${before}」改为「${profile.name}」` : `测试使用 ego profile「${profile.name}」`);
    changed();
  }
  if (agent && agent.egoProfile !== pick) { agent.egoProfile = pick; changed(); }
  return { id: profile.id, name: profile.name };
}
