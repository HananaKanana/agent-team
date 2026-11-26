// 启动 worker：标准角色、各平台的启动按钮和结果；缺人提示（有任务没人做）

import { data, view } from './state.js';
import { el, icon, post } from './util.js';
import { renderHelper } from './helper.js';
import { renderDrawer } from './drawer.js';

// 标准角色：看板上总是列出来，leader skill 里也按这几个拆任务
export const STANDARD_ROLES = [
  { key: 'product', label: '产品', what: '编写产品文档，不涉及代码' },
  { key: 'architect', label: '架构', what: '编写架构设计文档，不涉及代码' },
  { key: 'frontend', label: '前端', what: '页面和交互' },
  { key: 'backend', label: '后端', what: '接口和数据' },
  { key: 'test', label: '测试', what: '按验收标准测试并编写报告' },
  { key: 'critic', label: '审卡', what: '审核任务卡质量，不涉及代码' },
];
// 「在 DeepSeek Harness 中启动」：由 ateam 通过 DSH 插件新开会话并发出上面的提示词
export let spawnState = { role: null, busy: false, msg: '', error: false };
let spawnTimer = 0;
// 「worker」页和任务详情里都有「启动」，状态共用一份，两边一起重画
function rerenderSpawn() {
  renderHelper(true);
  if (view.task) renderDrawer();
}
export const platformLabel = () => ((data.config?.spawnPlatform ?? 'dsh') === 'workbuddy' ? 'WorkBuddy' : 'DeepSeek Harness');
// taskId：从任务详情里点的。worker 加入后很快就领走这张卡，「分配 worker」一节随之消失，提示要换个地方留着
export function spawnButton(role, taskId = null) {
  const mine = spawnState.role === role ? spawnState : { busy: false };
  const start = async (e) => {
    e.stopPropagation();
    if (spawnState.busy) return;
    clearTimeout(spawnTimer);
    spawnState = { role, taskId, busy: true, msg: '', error: false };
    rerenderSpawn();
    const out = await post('/api/spawn', { role, by: 'user' });
    spawnState = out.ok
      ? { role, taskId, busy: false, msg: (out.sent ? `已在 ${platformLabel()} 中新建会话，worker 加入后将显示在下方「在线 worker」中。` : (out.note || '已填入提示词，请在对应窗口中按回车发送。')) + (out.over ? `当前在线 worker 将达 ${out.count} 个，已超过设定的上限（${out.max} 个）。` : ''), error: false }
      : { role, taskId, busy: false, msg: out.message || '启动失败。', error: true };
    rerenderSpawn();
    // 提示过一会儿自动消失：成功的 10 秒，出错的 30 秒（留时间看清原因）
    spawnTimer = setTimeout(() => { spawnState = { role: null, busy: false, msg: '', error: false }; rerenderSpawn(); }, spawnState.error ? 30000 : 10000);
  };
  return el('button', { class: 'btn ghost sm spawn-btn', disabled: mine.busy, title: `在 ${platformLabel()} 中新建会话并自动发送下方提示词（平台可在「设置」中切换）`, onclick: start },
    icon('play'), mine.busy ? '启动中…' : '启动');
}
export function spawnMessage(role) {
  if (spawnState.role !== role || !spawnState.msg) return null;
  return el('p', { class: `spawn-msg${spawnState.error ? ' err' : ''}` }, spawnState.msg);
}
// 待领取、依赖已满足、但没有同角色在线 worker 的任务 → 需要有人开新窗口接手
export function rolesNeedingWorkers() {
  const { tasks, agents } = data.state;
  const approved = new Set(tasks.filter((t) => t.status === 'approved').map((t) => t.id));
  const onlineRoles = new Set(agents.filter((a) => a.status === 'online').map((a) => a.role.trim().toLowerCase()));
  // 暂停领取的卡（单张或整个需求）不派发，不算缺人
  const heldJobs = new Set(data.state.jobs.filter((j) => j.onHold).map((j) => j.id));
  const byRole = new Map();
  for (const t of tasks) {
    if (t.status !== 'pending' || t.onHold || heldJobs.has(t.jobId) || !t.dependsOn.every((d) => approved.has(d))) continue;
    if (onlineRoles.has(t.role.trim().toLowerCase())) continue;
    if (!byRole.has(t.role)) byRole.set(t.role, []);
    byRole.get(t.role).push(t);
  }
  return byRole;
}
// 「有任务没人做」：并进了页头的「需要你处理」（缺人那几项可以就地展开提示词），这里不再单独弹气泡
export function renderNeeds() {
  const box = document.getElementById('needs');
  box.hidden = true;
  box.replaceChildren();
}
