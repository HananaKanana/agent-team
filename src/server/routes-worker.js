// worker 用的接口：加入、hook、进度、提问、提交检查和提交

import { AteamError } from '../errors.js';
import { commitPaths, commitTitle, pendingFiles } from '../git.js';
import { root, store } from './context.js';
import { serial } from './http.js';
import { waiters, waitRenewAt } from './live.js';

const WAIT_RENEW_GAP_MS = 2000;

export const workerRoutes = {
  'POST /api/join': (b) => ({ agent: store.join(b.role, b.name, b.id), root }),
  'POST /api/hook/post-tool': (b) => {
    if (!b.session) return {};
    if (b.as) store.bindHookSession(b.session, b.as);
    return { delivery: store.noteForHookSession(b.session) };
  },
  // 这个会话的 worker 正挂着 wait 吗。长等待由命令行分段续上，两段之间的空档也算在挂着
  'POST /api/hook/waiting': (b) => {
    const agentId = store.agentIdOfHookSession(b.session);
    return { waiting: !!agentId && (waiters.has(agentId) || Date.now() - (waitRenewAt.get(agentId) ?? 0) < WAIT_RENEW_GAP_MS) };
  },
  'POST /api/hook/browser-guard': (b) => store.browserGuard(b.session, b.action),
  'POST /api/tab-lost': (b) => ({ agent: store.tabLost(b.as) }),
  'POST /api/ack': (b) => store.ackNote(b.as, b.id),
  'POST /api/progress': (b) => ({ task: store.progress(b.as, b.text, b.expect) }),
  'POST /api/ask': (b) => ({ task: store.ask(b.as, b.text, !!b.forUser) }),
  // 提交检查：CLI 先问要跑哪些命令，在 worker 那边跑（编译可能要几分钟，不能占着服务），没通过再报回来记到时间线上
  'POST /api/submit-check/plan': async (b) => {
    const plan = store.submitCheckPlan(b.as);
    if (!plan.commands.length) return { commands: [] };
    const files = await pendingFiles(root, plan.task.paths).catch(() => []);
    return { commands: plan.commands, timeoutMin: plan.timeoutMin, root, taskId: plan.task.id, paths: plan.task.paths, files };
  },
  'POST /api/submit-check/fail': (b) => ({ task: store.recordCheckFail(b.as, b.command, b.detail) }),
  'POST /api/submit': (b) => serial(async () => {
    const task = store.taskForSubmit(b.as);
    // 配了提交检查的开发卡必须经 ateam submit 跑过检查（noChanges 的不用检查）
    if (!b.noChanges && store.submitCheckPlan(b.as).commands.length && !Array.isArray(b.checks)) {
      throw new AteamError('INVALID', '这个项目配置了提交检查，请用 ateam submit 提交（它会先运行检查命令）。');
    }
    if (typeof b.summary !== 'string' || !b.summary.trim()) {
      throw new AteamError('INVALID', '提交总结不能为空。请写明做了什么、怎么验证的。');
    }
    let commits = null;
    if (!b.noChanges) {
      const result = await commitPaths(root, task.paths, commitTitle(task.id, b.summary, task.title));
      if (result.nothing && result.leftover?.length) {
        throw new AteamError('INVALID', `任务路径里有改动，但一个都没能暂存提交：\n${result.leftover.map((p) => `- ${p}`).join('\n')}\n\n不要自己 git commit，用 ateam ask 告诉 leader（这是 ateam 的问题）。`);
      }
      if (result.nothing) {
        throw new AteamError('INVALID', `指定路径（${task.paths.join('、')}）下没有改动。服务的项目目录是 ${root}，路径相对于这个目录：如果你的改动在别的目录，说明服务起错了目录，请通知用户，不要挪动改动；如确实无需改代码，请加 --no-changes。`);
      }
      commits = result.commits;
      // 提交后任务路径里还有改动（比如新文件没被暂存）：不算提交成功，列出来让 worker 重新提交
      if (result.leftover?.length) {
        store.addCommits(b.as, commits);
        throw new AteamError('INVALID', `已提交 ${commits.join('、')}，但任务路径里还有这些改动没进提交：\n${result.leftover.map((p) => `- ${p}`).join('\n')}\n\n先确认它们是这个任务的改动，再原样运行一次 ateam submit（服务会把它们补进新的提交）。不要自己 git commit。如果重交后还是这样，用 ateam ask 告诉 leader。`);
      }
    }
    return { task: store.recordSubmit(b.as, b.summary, commits, b.noChanges ? null : b.checks), commit: commits ? commits.join('、') : null };
  }),
};
