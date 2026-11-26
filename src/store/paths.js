// 路径重叠：卡和卡、和同事的卡改同一批文件时的判断

import { state } from './core.js';
import { isDemo } from './demo.js';

function normPath(p) {
  // Windows 上可能写成 web\\src：统一成 /
  const s = String(p).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return s === '.' ? '' : s;
}

// 两组路径有没有交集：相同，或一个是另一个的上级目录（空串 = 整个项目）
export function pathsOverlap(a, b) {
  for (const x of a.map(normPath)) {
    for (const y of b.map(normPath)) {
      if (x === '' || y === '' || x === y || y.startsWith(`${x}/`) || x.startsWith(`${y}/`)) return true;
    }
  }
  return false;
}

// 沿依赖链往上找：ids 依赖的所有任务（含间接依赖）
function ancestors(ids) {
  const seen = new Set();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const t = state.tasks.find((x) => x.id === id);
    if (t) stack.push(...t.dependsOn);
  }
  return seen;
}

// 多人协作（sync.js）：同事看板里没结束的卡，服务每分钟拉一次后交进来，只在内存里。
// { peer, id, title, status, paths, assignee, fresh, unpushed }；fresh：同事最近 2 小时内同步过，他手上的卡才拦派卡。
// unpushed：已通过、但提交还没推到远程（代码在他电脑上，本机拿不到），和他正在改的卡一样挡着
export let peerTasks = [];
export function setPeerTasks(list) { peerTasks = Array.isArray(list) ? list : []; }
export const peerId = (p) => `${p.peer}·${p.id}`;

// 和 task 改同一批文件、又可能同时进行的任务：还没通过/作废，且两者之间没有依赖先后（直接或间接）。
// 同事看板里没结束、路径重叠的卡也列上（标 peer）。只用来提醒 leader，不拦着。
export function overlapsFor(task) {
  const before = ancestors(task.dependsOn);
  const peers = peerTasks.filter((p) => pathsOverlap(task.paths, p.paths))
    .map((p) => ({ id: peerId(p), title: p.title, status: p.status, assignee: p.assignee ? `${p.peer}·${p.assignee}` : null, paths: p.paths, onHold: false, jobOnHold: false, peer: p.peer, stale: !p.fresh, unpushed: !!p.unpushed }));
  return [...state.tasks
    .filter((t) => t.id !== task.id && !isDemo(t) && !['approved', 'cancelled'].includes(t.status)
      && !before.has(t.id) && !ancestors(t.dependsOn).has(task.id)
      && pathsOverlap(task.paths, t.paths))
    .map((t) => ({ id: t.id, title: t.title, status: t.status, assignee: t.assignee, paths: t.paths, onHold: !!t.onHold, jobOnHold: !!state.jobs.find((j) => j.id === t.jobId)?.onHold })), ...peers];
}
