// 推送到手机：事件推送和定时小结

import { basename } from 'node:path';
import { buildDigest, dueAt } from '../digest.js';
import { anyPushOn, eventOn, readDigest, readPrefs, sendPush } from '../push.js';
import { lanLink, root, store } from './context.js';
import { attention } from './attention.js';
import { usageReport } from './usage.js';

// ---------- 推送到手机（push.js）----------
// 与菜单栏通知同一规则：待处理清单里新出现、持续 1 分钟的事推一次；服务启动时已有的不推；事情消失后再出现会再推
const PUSH_SETTLE_MS = 60 * 1000;
const pushFirstSeen = new Map();
const pushDone = new Set();
let pushBaselined = false;

export async function checkPush() {
  // 自检问题、服务需要重启是本机的事，不推到手机（自检结果在启动后才出来，会被当成新事项每次重启都推）
  const items = attention().filter((i) => i.key !== 'stale' && !i.key.startsWith('doctor:'));
  const keys = new Set(items.map((i) => i.key));
  if (!pushBaselined) {
    pushBaselined = true;
    for (const k of keys) pushDone.add(k);
    return;
  }
  for (const k of [...pushFirstSeen.keys()]) if (!keys.has(k)) pushFirstSeen.delete(k);
  for (const k of [...pushDone]) if (!keys.has(k)) pushDone.delete(k);
  const now = Date.now();
  const due = [];
  for (const item of items) {
    if (pushDone.has(item.key)) continue;
    if (!pushFirstSeen.has(item.key)) pushFirstSeen.set(item.key, now);
    if (now - pushFirstSeen.get(item.key) < PUSH_SETTLE_MS) continue;
    pushDone.add(item.key);
    due.push(item);
  }
  await checkDigest();
  if (!anyPushOn()) return;
  const { format, ...prefs } = readPrefs();
  const send = due.filter((i) => eventOn(prefs, i.key));
  if (!send.length) return;
  const name = basename(root);
  const head = format.prefix ? `${format.prefix} · ${name}` : name;
  const link = (hash) => (format.link ? lanLink(hash) : '');
  // 合并：几件事一条；不合并：一件事一条
  const messages = send.length === 1 || !format.merge
    ? send.map((i) => ({ title: `${head}：${i.text}`, lines: [], link: link(i.hash) }))
    : [{ title: `${head}：${send.length} 项待处理`, lines: format.brief ? [] : send.map((i) => `· ${i.text}`), link: link() }];
  for (const m of messages) {
    const results = await sendPush(m);
    for (const r of results) if (!r.ok) console.error(`推送到${r.channel}失败：${r.error}`);
  }
}

export async function digestMessage(kind) {
  const { format } = readPrefs();
  let usage = null;
  try { usage = await usageReport(); } catch {}
  const d = buildDigest({ kind, state: store.state, usage, items: attention(), name: basename(root), sections: readDigest().sections, brief: format.brief, prefix: format.prefix });
  return d && { ...d, link: format.link ? lanLink() : '' };
}
async function checkDigest() {
  if (!anyPushOn()) return;
  const cfg = readDigest();
  for (const kind of ['daily', 'weekly']) {
    const at = dueAt(kind, cfg, store.digestSent(kind));
    if (!at) continue;
    store.markDigest(kind, Date.now()); // 先记下，发送失败也不反复重试
    const m = await digestMessage(kind);
    if (!m) continue; // 这一期什么都没发生：不发
    const results = await sendPush(m);
    for (const r of results) if (!r.ok) console.error(`小结推送到${r.channel}失败：${r.error}`);
  }
}
