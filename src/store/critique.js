// 审卡：审卡 worker 的意见、分歧处理、看板卡片列表

import { AteamError } from '../errors.js';
import { changed, now, state } from './core.js';
import { addHistory, emit, getTask, requireText } from './common.js';
import { touch } from './workers.js';
import { sameRole } from './dispatch.js';

// 审卡 worker（角色 critic）专门挑任务卡的毛病：描述含糊或矛盾、验收标准没法核对、路径不对、依赖错了……
// 它在线就能看全部的卡（ateam cards），wait 拿到的是还没审过的卡；审过的标记一下就不再出现，
// leader 改过（rev 变了）的卡会重新出现。发现新卡和旧卡冲突，可以重新审旧卡，历史里记下因为哪张卡。
// 有问题就记一条意见（critique），leader 必须处理：改了就 done；不同意就 dispute，交给用户在看板上裁决。
// 审卡不影响派发。

const CRITIC_ROLE = 'critic';
export const isCritic = (agent) => sameRole(agent.role, CRITIC_ROLE);
// 先审还没开工的（改起来最省事），再审进行中的，最后审已完成的
const CRITIQUE_RANK = { pending: 0, held: 0, working: 1, asking: 1, submitted: 2, approved: 3 };

// 能审的卡：没作废，所属需求还没验收
function critiquable(t) {
  if (!(t.status in CRITIQUE_RANK)) return false;
  const st = state.jobs.find((j) => j.id === t.jobId)?.status;
  return st !== 'accepted' && st !== 'cancelled';
}

function reviewed(t) {
  return (t.critiquedRev ?? -1) === (t.rev ?? 0);
}

export function critiqueQueue() {
  return state.tasks
    .filter((t) => critiquable(t) && !reviewed(t))
    .sort((a, b) => (CRITIQUE_RANK[a.status] - CRITIQUE_RANK[b.status]) || (Number(a.id.slice(1)) - Number(b.id.slice(1))));
}

export function critiqueView(t) {
  return { ...t, reviewed: reviewed(t), edited: (t.rev ?? 0) > 0 && t.critiquedRev != null && !reviewed(t) };
}

// 全部能审的卡（审卡 worker 和 leader 都能看）。jobId 只看一个需求，todo 只看还没审的
export function cards({ jobId = '', todo = false } = {}) {
  return state.tasks
    .filter((t) => critiquable(t) && (!jobId || t.jobId === jobId) && (!todo || !reviewed(t)))
    .map(critiqueView);
}

// 审卡 worker 给出结论。ids：一张或多张卡；verdict：ok 没问题 / issue 有问题（text 写问题和修改建议）。
// because：重新审已经审过的卡时必须写明原因（比如和哪张新卡冲突），历史里留痕。
export function submitCritique(agentId, ids, verdict, text = '', because = '', basis = '') {
  const agent = touch(agentId);
  if (!isCritic(agent)) throw new AteamError('BAD_STATE', '只有审卡角色（critic）的 worker 能提交审卡结论。');
  const list = (Array.isArray(ids) ? ids : [ids]).map((id) => String(id).trim()).filter(Boolean);
  if (!list.length) throw new AteamError('INVALID', '请写上要审的卡的编号，例如 T5（可以多个）。');
  if (verdict !== 'ok' && verdict !== 'issue') throw new AteamError('INVALID', '审卡结论只能是 ok 或 issue。');
  if (verdict === 'issue') {
    text = requireText(text, '审卡意见');
    basis = requireText(basis, '依据（--basis：用户原话的哪一句、设计文档哪一段、代码哪个文件第几行、命令的实际输出）');
  }
  because = String(because ?? '').trim();
  const tasks = list.map(getTask);
  for (const t of tasks) {
    if (!critiquable(t)) throw new AteamError('BAD_STATE', `任务 ${t.id} 已作废或所属需求已验收，不用再审。`);
    if (reviewed(t) && !because) {
      throw new AteamError('INVALID', `${t.id} 已经审过了。要重新审（比如它和新卡冲突），加上 --because "<原因，比如和 T12 冲突>"，会记进历史。`);
    }
  }
  agent.lastCritiqued = tasks.map((t) => t.id);
  for (const t of tasks) {
    const again = reviewed(t);
    t.critiquedRev = t.rev ?? 0;
    const prefix = again ? `重新审卡（${because}）` : '审卡';
    if (verdict === 'issue') {
      t.critiques ??= [];
      t.critiques.push({ id: t.critiques.length + 1, by: agent.id, ts: now(), status: 'open', text, basis, taskStatus: t.status, ...(again ? { because } : {}) });
      addHistory(t, 'critique', agent.id, `${prefix}：${text}（依据：${basis}）`);
      emit('critique', { taskId: t.id, agentId: agent.id, text: `${prefix}意见（${t.id}，${t.status}）：${text}` });
    } else {
      addHistory(t, 'critique', agent.id, `${prefix}通过${String(text ?? '').trim() ? `：${String(text).trim()}` : ''}`);
    }
  }
  changed();
  return tasks;
}

function openCritiques(task, statuses = ['open']) {
  return (task.critiques ?? []).filter((c) => statuses.includes(c.status));
}

// 审卡意见的流程（有分歧就交给用户，leader 不能自己拍板改卡）：
//   open      审卡提出，等 leader 回复
//   proposed  leader 同意，写了打算怎么改，等用户确认
//   disputed  leader 不同意，写了理由，等用户裁决
//   redo      用户定了怎么改（instruction），等 leader 照做
//   resolved  leader 改完了
//   closed    用户决定不改
// leader 回复：agree（同意，附改法）/ dispute（不同意，附理由）；用户定了以后 done（改完了）
export function handleCritique(taskId, action, text, basis = '') {
  const task = getTask(taskId);
  if (action === 'agree' || action === 'dispute') {
    text = requireText(text, action === 'agree' ? '打算怎么改' : '不同意的理由');
    basis = requireText(basis, '依据（--basis：需求说明或设计文档的哪一段、代码哪个文件第几行、命令的实际输出）');
    const open = openCritiques(task, ['open']);
    if (!open.length) throw new AteamError('BAD_STATE', `任务 ${task.id} 没有等你回复的审卡意见。`);
    for (const c of open) {
      c.reply = text;
      c.replyBasis = basis;
      c.replyKind = action;
      c.status = action === 'agree' ? 'proposed' : 'disputed';
      c.repliedAt = now();
    }
    addHistory(task, 'critique', 'lead', `${action === 'agree' ? `同意审卡意见，打算：${text}` : `不同意审卡意见：${text}`}（依据：${basis}；等用户决定）`);
  } else if (action === 'done') {
    text = requireText(text, '处理说明（改了什么）');
    const redo = openCritiques(task, ['redo']);
    if (!redo.length) {
      const waiting = openCritiques(task, ['open', 'proposed', 'disputed']);
      throw new AteamError('BAD_STATE', waiting.length
        ? `任务 ${task.id} 的审卡意见还没有用户的决定，不能自己改。先回复（ateam critique agree/dispute），等用户在看板上决定。`
        : `任务 ${task.id} 没有待处理的审卡意见。`);
    }
    for (const c of redo) { c.status = 'resolved'; c.doneText = text; c.doneAt = now(); }
    addHistory(task, 'critique', 'lead', `按用户的决定处理审卡意见：${text}`);
  } else {
    throw new AteamError('INVALID', '只能是 agree、dispute 或 done。');
  }
  changed();
  return task;
}

// 用户决定：critic 按审卡意见改；leader 按 leader 的方案（leader 同意时）或维持原样（leader 不同意时）；
// none 都不改；custom 按用户自己写的意见改（text）
export function ruleCritique(taskId, side, text = '') {
  const task = getTask(taskId);
  const waiting = openCritiques(task, ['proposed', 'disputed']);
  if (!waiting.length) throw new AteamError('BAD_STATE', `任务 ${task.id} 没有等你决定的审卡意见。`);
  let instruction = null;
  let label;
  if (side === 'critic') {
    instruction = `按审卡意见改：${waiting.map((c) => c.text).join('；')}`;
    label = '按审卡意见改';
  } else if (side === 'leader') {
    const agreed = waiting.filter((c) => c.replyKind === 'agree');
    if (agreed.length) {
      instruction = `按你的方案改：${agreed.map((c) => c.reply).join('；')}`;
      label = '按 leader 的方案改';
    } else {
      label = '维持原样（同意 leader）';
    }
  } else if (side === 'none') {
    label = '都不改';
  } else if (side === 'custom') {
    text = requireText(text, '你的意见');
    instruction = `按用户的意见改：${text}`;
    label = `按用户自己的意见改：${text}`;
  } else {
    throw new AteamError('INVALID', '决定只能是 critic、leader、none 或 custom。');
  }
  for (const c of waiting) {
    c.ruling = label;
    c.ruledAt = now();
    c.status = instruction ? 'redo' : 'closed';
    if (instruction) c.instruction = instruction;
  }
  addHistory(task, 'critique', 'user', `用户决定：${label}`);
  if (instruction) emit('critique_ruling', { taskId: task.id, text: `用户决定 ${task.id}：${instruction}` });
  changed();
  return task;
}

