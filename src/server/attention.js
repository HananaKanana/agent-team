// 「需要你处理」：看板和菜单栏共用的待处理事项

import { staleWhy, store } from './context.js';
import { leaderOnline } from './live.js';
import { doctor } from './agents.js';
import { syncCfg, syncState } from './sync.js';

// act：菜单栏通知上可以直接点的操作（验收、启动 worker、收回任务、重启服务），没有就只能打开看板
export function attention() {
  const st = store.state;
  const taskOf = (id) => st.tasks.find((t) => t.id === id);
  const items = [];
  for (const j of st.jobs.slice().reverse()) {
    if (j.status === 'awaiting_acceptance') items.push({ key: `accept:${j.id}`, text: `${j.id} 待验收：${j.title}`, hash: j.id, act: { type: 'accept', job: j.id } });
  }
  if (!store.demoFrozen()) {
    for (const n of store.staffingNeeds().needs) {
      const t = taskOf(n.tasks[0]);
      items.push({ key: `needs:${n.role.toLowerCase()}`, text: `${n.role} 缺少 worker（${n.tasks.join('、')}）`, hash: t ? `${t.jobId}/${t.id}` : '', act: { type: 'spawn', role: n.role } });
    }
  }
  if (staleWhy()) items.push({ key: 'stale', text: staleWhy() === 'code' ? '服务需要重启' : '已切换运行模式，服务需要重启', hash: '', act: { type: 'restart' } });
  for (const t of st.tasks) {
    if ((t.critiques || []).some((c) => c.status === 'proposed' || c.status === 'disputed')) items.push({ key: `dispute:${t.id}`, text: `${t.id} 审卡分歧待决定`, hash: `${t.jobId}/${t.id}` });
  }
  for (const t of st.tasks) {
    if (!t.assignTo || (t.status !== 'pending' && t.status !== 'held')) continue;
    const a = st.agents.find((x) => x.id === t.assignTo);
    if (!a || a.status !== 'online') items.push({ key: `assign:${t.id}`, text: `${t.id} 指派的 ${t.assignTo} 不在线`, hash: `${t.jobId}/${t.id}` });
  }
  for (const a of st.agents) {
    if (a.status !== 'online') continue;
    const cancelled = a.cancelNotice?.wasWorking ? taskOf(a.cancelNotice.taskId) : null;
    if (cancelled) items.push({ key: `cancel:${a.id}:${cancelled.id}`, text: `${a.id} 仍在处理已作废的 ${cancelled.id}`, hash: `${cancelled.jobId}/${cancelled.id}` });
    const t = a.stale && a.currentTask ? taskOf(a.currentTask) : null;
    if (t) items.push({ key: `quiet:${a.id}`, text: `${a.id} 无响应（${t.id}）`, hash: `${t.jobId}/${t.id}`, act: { type: 'reclaim', task: t.id, agent: a.id } });
  }
  for (const c of (doctor ?? []).filter((x) => !x.ok)) items.push({ key: `doctor:${c.key}`, text: `自检：${c.title}有问题`, hash: '' });
  for (const it of codeAttention()) items.push(it);
  const busy = st.jobs.some((j) => !j.demo && (j.status === 'planning' || j.status === 'active'));
  if (busy && (st.noLeader || !leaderOnline())) items.push({ key: 'leader', text: st.noLeader ? '无 leader 模式' : 'leader 未连接', hash: '' });
  return items;
}

// 多人协作时代码分支的提醒（看板 attentionItems 里有同一套）：
// 有提交超过 30 分钟没推送（同事拿不到）、落后远程超过 10 分钟没拉取、自动推送 / 拉取失败
function codeAttention() {
  const c = syncCfg.enabled ? syncState.code : null;
  if (!c || c.detached || c.noUpstream) return [];
  const out = [];
  const now = Date.now();
  if (c.error) out.push({ key: 'code:error', text: c.error, hash: '' });
  if (c.ahead > 0 && c.aheadSince && now - c.aheadSince >= 30 * 60 * 1000) out.push({ key: 'code:ahead', text: `本地 ${c.branch} 有 ${c.ahead} 个提交未推送`, hash: '' });
  if (c.behind > 0 && c.behindSince && now - c.behindSince >= 10 * 60 * 1000) out.push({ key: 'code:behind', text: `本地 ${c.branch} 落后远程 ${c.behind} 个提交`, hash: '' });
  return out;
}
