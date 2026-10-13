// macOS 系统通知：出现需要用户处理的事（需求待验收、某个角色缺 worker、有活干时 leader 没连上），
// 弹一条系统通知，用户不在看板前也能知道。和看板上「需要你处理」是同一套判断。
// 用 osascript 实现，不需要安装任何东西；其它系统上什么都不做。
import { execFile } from 'node:child_process';
import { basename } from 'node:path';

const CHECK_MS = 15 * 1000;
// 一件事要持续这么久才通知：worker 掉线后马上重连、leader 短暂断开监听，都不打扰
const SETTLE_MS = 60 * 1000;

function sameRole(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// 返回 Map<key, 文字>。key 用来去重：同一件事只通知一次，事情消失后再出现会再通知
export function attentionItems(state, leaderOnline) {
  const items = new Map();
  for (const j of state.jobs) {
    if (j.status === 'awaiting_acceptance') items.set(`accept:${j.id}`, `${j.id} ${j.title} 待你验收`);
  }
  const approved = new Set(state.tasks.filter((t) => t.status === 'approved').map((t) => t.id));
  const online = state.agents.filter((a) => a.status === 'online');
  for (const t of state.tasks) {
    if (t.status !== 'pending' || !t.dependsOn.every((d) => approved.has(d))) continue;
    if (online.some((a) => sameRole(a.role, t.role))) continue;
    const key = `needs:${t.role.trim().toLowerCase()}`;
    if (!items.has(key)) items.set(key, `${t.role} 的任务没人做，需要开一个 ${t.role} worker`);
  }
  const busy = state.jobs.some((j) => j.status === 'planning' || j.status === 'active');
  if (busy && !leaderOnline) items.set('leader', 'leader 没有连接，需求还没做完');
  return items;
}

function osaNotify(title, message) {
  // 文字通过参数传给脚本，不拼进脚本里，避免引号转义问题
  execFile('osascript', [
    '-e', 'on run argv',
    '-e', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"',
    '-e', 'end run',
    title, message,
  ], () => {});
}

export function startNotifier({ root, port, getState, leaderOnline, send = osaNotify, now = Date.now }) {
  if (process.platform !== 'darwin' && send === osaNotify) return { stop() {}, check() {} };
  const title = `ateam · ${basename(root)}`;
  const firstSeen = new Map(); // key -> 第一次出现的时间
  const notified = new Set();

  function check() {
    const items = attentionItems(getState(), leaderOnline());
    for (const key of [...firstSeen.keys()]) {
      if (!items.has(key)) { firstSeen.delete(key); notified.delete(key); }
    }
    const fresh = [];
    for (const [key, text] of items) {
      if (!firstSeen.has(key)) firstSeen.set(key, now());
      if (notified.has(key) || now() - firstSeen.get(key) < SETTLE_MS) continue;
      notified.add(key);
      fresh.push(text);
    }
    if (fresh.length === 0) return;
    const message = fresh.length === 1
      ? `${fresh[0]}。看板：http://127.0.0.1:${port}`
      : `${fresh.length} 件事需要你处理：${fresh.join('；')}`;
    send(title, message);
  }

  const timer = setInterval(check, CHECK_MS);
  timer.unref();
  return { stop: () => clearInterval(timer), check };
}
