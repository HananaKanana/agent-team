// store 各模块共用的上下文：状态、时钟、变更和换会话回调。createStore() 设置；一个进程只有一个 store
export function emptyState() {
  return { seq: { job: 0, task: 0, event: 0 }, jobs: [], tasks: [], agents: [], events: [] };
}
export let state = null;
export let now = Date.now;
// 启动参数（--lease / --idle）是默认值；用户在看板「设置」里改过的以设置为准
export let defaultLeaseMs = 15 * 60 * 1000;
export let defaultIdleMs = 3 * 60 * 1000;
let onChange = () => {};
export let onRotate = () => {};
export const changed = () => onChange();
export function initStore(opts) {
  state = opts.state ?? emptyState();
  if (opts.now) now = opts.now;
  if (opts.leaseMs) defaultLeaseMs = opts.leaseMs;
  if (opts.idleMs) defaultIdleMs = opts.idleMs;
  if (opts.onChange) onChange = opts.onChange;
  if (opts.onRotate) onRotate = opts.onRotate;
}
