// 纯逻辑状态机：需求、任务、worker、事件。不碰网络和磁盘，时钟可注入。
// 各部分在 src/store/ 下按职责分文件；这里设置共用的上下文（src/store/core.js），组装成对外的 store。
// 一个进程只有一个 store：各部分共用 core.js 里的状态
import * as core from './store/core.js';
import { initStore } from './store/core.js';
import { config, setSettings } from './store/settings.js';
import { compactState, getJob, getTask, leaderOpenedTask } from './store/common.js';
import { overlapsFor, setPeerTasks } from './store/paths.js';
import {
  acceptJobs, addTask, assignTask, cancel, cancelJob, createJob, editJob, editTask, holdJob, holdTask,
  report, setPriority
} from './store/jobs.js';
import { dismiss, hideAgents, join, keepAgents, keepWaiting, touch } from './store/workers.js';
import { clashes, dispatchOrder, nextFor, waitingInfo } from './store/dispatch.js';
import {
  addCommits, ask, progress, recordCheckFail, recordSubmit, submitCheckPlan, taskForSubmit
} from './store/work.js';
import { answer, approve, reject, release } from './store/review.js';
import { ackNote, messageAgent, noteForHookSession, noteTask, userReply } from './store/notes.js';
import {
  agentIdOfHookSession, assignEgoProfile, bindHookSession, boundSessions, browserGuard, tabLost
} from './store/hooks.js';
import { checkIdle, checkStaffing, setLeaderAway, staffingNeeds } from './store/no-leader.js';
import { cards, critiqueQueue, handleCritique, ruleCritique, submitCritique } from './store/critique.js';
import { agentSegments, digestSent, markDigest, markRotate, setTaskTokens } from './store/usage.js';
import { noteActivity, reclaim, sweep } from './store/lease.js';
import {
  addDemo, demoBlockers, demoEnd, demoFrozen, demoStep, demoTaskForSave, expireDemoRequests, markOpsCleared,
  pauseDemo, recordDemoSave, releaseDemo, resumeDemo, startDemo, stopDemo
} from './store/demo.js';
import { pendingActions, takeEvents } from './store/query.js';

export { emptyState } from './store/core.js';
export { QUIET_EVENTS } from './store/common.js';

// leaseMs：多久没动静算「可能停了」。手上有进行中任务的 worker 只标记、提醒用户，任务不动，
// 用户确认窗口没了（看板上点「换人接手」，或 leader 问过用户后 ateam reclaim）才转手；
// 空闲（手上没有进行中任务）的 worker 到时直接判掉线，没有任务要转手。
export function createStore({ state, now, leaseMs, idleMs, onChange, onRotate } = {}) {
  initStore({ state, now, leaseMs, idleMs, onChange, onRotate });
  compactState();

  return {
    get state() { return core.state; },
    get leaseMs() { return config().leaseMin * 60000; },
    config,
    createJob, editJob, addTask, editTask,
    join, touch,
    nextFor, waitingInfo, progress, ask, submitCheckPlan, recordCheckFail, taskForSubmit, addCommits, recordSubmit,
    pauseDemo, resumeDemo, holdTask, holdJob, acceptJobs, setPriority, assignTask, submitCritique, handleCritique, ruleCritique, noteTask, noteForHookSession, ackNote, assignEgoProfile, browserGuard, tabLost, bindHookSession, agentIdOfHookSession, agentSegments, digestSent, markDigest, boundSessions, setTaskTokens, markRotate, messageAgent, leaderOpenedTask, userReply, critiqueQueue, cards, dispatchOrder, approve, reject, answer, release, cancel, cancelJob, reclaim, hideAgents, dismiss, keepAgents, setSettings, staffingNeeds, checkStaffing, keepWaiting, checkIdle, report, sweep, noteActivity,
    getJob, getTask, pendingActions, takeEvents, overlapsFor, setPeerTasks,
    setLeaderAway, clashes, addDemo, demoBlockers, markOpsCleared, startDemo, stopDemo, releaseDemo, demoFrozen, demoStep, demoEnd, demoTaskForSave, recordDemoSave, expireDemoRequests,
  };

}
