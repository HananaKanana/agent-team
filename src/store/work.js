// 干活中：进度、提问、提交检查和提交

import { isDevRole } from '../dev-guide.js';
import { AteamError } from '../errors.js';
import { changed, now } from './core.js';
import { config } from './settings.js';
import { addHistory, emit, getTask, requireText, trackLeaderRead } from './common.js';
import { cancelMessage, takeCancelNotice, touch } from './workers.js';
import { takeNote } from './notes.js';
import { isDemo } from './demo.js';

// worker 当前持有的任务，且必须处于 working
function workingTaskOf(agentId) {
  const agent = touch(agentId);
  if (!agent.currentTask) {
    if (agent.cancelNotice) {
      const notice = takeCancelNotice(agent);
      throw new AteamError('BAD_STATE', cancelMessage(notice.task, notice.wasWorking, agent.id, notice.sentByHook));
    }
    throw new AteamError('BAD_STATE', `你当前没有进行中的任务。请运行 ateam wait --as ${agent.id} 领取任务。`);
  }
  const task = getTask(agent.currentTask);
  if (isDemo(task)) {
    throw new AteamError('BAD_STATE', task.status === 'wrapping'
      ? `演播卡 ${task.id} 在收尾：按收尾说明清理、写操作记录后用 ateam demo save --as ${agent.id} "<记了哪些操作>" 提交。`
      : `演播中不能提问、报进度或提交。遇到问题自己处理，处理不了就跳过这一步记下来；每步用 ateam demo step --as ${agent.id} <n>/<总数> "<说明>" 报告，跑完用 ateam demo end --as ${agent.id} "<结果>"。`);
  }
  if (task.status === 'asking') {
    throw new AteamError('BAD_STATE', `任务 ${task.id} 正在等待 leader 答复。请运行 ateam wait --as ${agent.id} 等待答复。`);
  }
  if (task.status !== 'working') {
    throw new AteamError('BAD_STATE', `任务 ${task.id} 当前状态是 ${task.status}，不能执行此操作。请运行 ateam wait --as ${agent.id} 等待下一步。`);
  }
  return { agent, task };
}
// expectMin：接下来要跑一个很长的命令（导入数据、全量构建……），预计多少分钟不会调用 ateam。
// 这段时间算作有动静，不提醒、不收回；最多 180 分钟。
export function progress(agentId, text, expectMin) {
  text = requireText(text, '进度笔记');
  const { agent, task } = workingTaskOf(agentId);
  const min = Number(expectMin);
  if (expectMin != null && expectMin !== '' && (!Number.isFinite(min) || min <= 0)) {
    throw new AteamError('INVALID', '--expect 必须是正数（分钟）。');
  }
  if (min > 0) {
    const capped = Math.min(min, 180);
    agent.busyUntil = now() + capped * 60 * 1000;
    addHistory(task, 'progress', agent.id, `${text}（预计 ${capped} 分钟不调用 ateam）`);
  } else {
    addHistory(task, 'progress', agent.id, text);
  }
  const note = takeNote(task);
  changed();
  return note ? { ...task, note } : task;
}
// forUser：要用户本人决定的问题（技术选型、要不要引入新框架这类）。leader 不能自己答，
// 只能把用户的原话转过来（--user-approved），或者用户在看板上直接答复
export function ask(agentId, text, forUser = false) {
  text = requireText(text, '问题');
  const { agent, task } = workingTaskOf(agentId);
  task.status = 'asking';
  if (forUser) task.userQuestion = true;
  else delete task.userQuestion;
  addHistory(task, 'asked', agent.id, forUser ? `【需要用户决定】${text}` : text);
  trackLeaderRead(task);
  emit('question', {
    taskId: task.id, agentId: agent.id, forUser: forUser || undefined,
    text: forUser ? `【需要用户决定，不要自己答】${text}\n\n把问题原样转给用户（给出候选和 worker 的推荐），用户答复后 ateam answer ${task.id} "<用户的决定>" --user-approved；用户也可以在看板上直接答复。` : text,
  });
  changed();
  return task;
}
// 提交检查：这张卡要跑哪些命令（只有开发卡、设置里配了命令才跑）
export function submitCheckPlan(agentId) {
  const { task } = workingTaskOf(agentId);
  const commands = config().submitChecks.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (task.kind === 'demo' || !isDevRole(task.role) || !commands.length) return { task, commands: [] };
  return { task, commands, timeoutMin: config().submitCheckMin };
}
// 提交检查没通过：记在时间线上，leader 和用户都能看到 worker 卡在哪
export function recordCheckFail(agentId, command, detail) {
  const { agent, task } = workingTaskOf(agentId);
  addHistory(task, 'check', agent.id, `提交检查未通过：${requireText(command, '命令')}${detail ? `（${String(detail).slice(0, 200)}）` : ''}`);
  changed();
  return task;
}
export function taskForSubmit(agentId) {
  const { task } = workingTaskOf(agentId);
  // leader 的补充说明还没看到：先给它看，按说明检查完再提交
  const note = takeNote(task);
  if (note) {
    throw new AteamError('BAD_STATE', `提交前先看对 ${task.id} 的补充说明（标着「用户直接说」的是用户本人说的）：\n\n${note}\n\n按说明检查、需要的话修改后，再运行 ateam submit。`);
  }
  return task;
}
// 提交了一部分、但路径里还有改动没进提交（submit 报错让 worker 重交）：已经提交的先记到卡上，免得丢
export function addCommits(agentId, commits) {
  const { agent, task } = workingTaskOf(agentId);
  task.commits.push(...commits);
  addHistory(task, 'progress', agent.id, `提交了 ${commits.join('、')}，但任务路径里还有改动没进提交，等重新提交`);
  changed();
  return task;
}
// commit：一个提交号、多个提交号（多仓库时每个仓库一个，如 api@a1b2c3d），或 null（无代码改动）
export function recordSubmit(agentId, summary, commit, checks = null) {
  summary = requireText(summary, '提交总结');
  const { agent, task } = workingTaskOf(agentId);
  if (checks?.length) addHistory(task, 'check', agent.id, `提交检查通过：${checks.join('；')}`);
  const list = [].concat(commit ?? []).filter(Boolean);
  task.commits.push(...list);
  commit = list.length ? list.join('、') : null;
  task.status = 'submitted';
  addHistory(task, 'submitted', agent.id, summary, commit);
  emit('submitted', {
    taskId: task.id, agentId: agent.id,
    text: commit ? `${task.id} 已提交 ${commit}：${summary}` : `${task.id} 已提交（无代码改动）：${summary}`,
  });
  changed();
  return task;
}
