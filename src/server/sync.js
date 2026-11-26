// 多人协作：看板同步到 git 远程的 ateam/<名字> 分支、同事、代码同步状态

import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { AteamError } from '../errors.js';
import { version as ateamVersion } from '../install.js';
import { checkSyncConfig, claimName, codeStatus, commitsLanded, defaultName, explainGitError, fastForward, fetchPeers, hasSyncConfig, PEER_STALE_MS, pickRemote, pushCode, pushSelf, readPeers, readSyncConfig, saveSyncConfig, SYNC_FORMAT, SYNC_MARK, thisHost, trackedBoardFiles, writeSelf } from '../sync.js';
import { dataDir, layout, root, store, syncProject } from './context.js';
import { leaderOnline, pushSoon, wakeSoon } from './live.js';
import { usageReport } from './usage.js';
import { parseOwners, readOwners } from './owners.js';

// 看板保存后 30 秒推一次（没变化不推，10 分钟一次心跳），每分钟拉一次同事的看板，同事进行中的卡交给 store 参与派卡冲突检查
export let syncCfg = null;
export function loadSyncConfig() { syncCfg = readSyncConfig(root); }
const syncCache = new Map();
export const syncState = { pushedAt: null, fetchedAt: null, error: null, unpushed: false, peers: [], code: null };
const PEER_ONLINE_MS = 15 * 60 * 1000; // 心跳 10 分钟一次：超过 15 分钟没同步算离线
let syncBusy = false;
let syncTimer = null;
export const syncTop = (cfg = syncCfg) => (layout.mode === 'single' ? layout.top : join(root, layout.repos.includes(cfg.repo) ? cfg.repo : layout.repos[0]));
export const syncRel = () => (layout.mode === 'single' ? relative(layout.top, dataDir).split(sep).join('/') : null);
async function syncRun(fn) {
  if (syncBusy) return false;
  syncBusy = true;
  try { await fn(); return true; } finally { syncBusy = false; }
}
// 同步数据里附带的状态：服务在不在跑、leader 在不在线、各 worker 在做哪张卡（同事侧栏的在线状态用）
function syncPresence(running = true) {
  if (!running) return { running: false, at: Date.now() };
  const workers = store.state.agents.filter((a) => a.status === 'online' && a.role !== 'leader')
    .map((a) => ({ id: a.id, role: a.role, task: a.currentTask ?? null }));
  return { running: true, leader: leaderOnline(), workers };
}
// 用量摘要（「用量 → 团队」用）：最近 30 天每天合计、已通过的卡数和每卡平均、打回率。10 分钟更新一次，免得用量一变就推送
let usageBrief = null;
let usageBriefAt = 0;
async function syncUsage(selfView = false) {
  if (!selfView && !store.config().shareUsage) return null;
  if (usageBrief && Date.now() - usageBriefAt < 10 * 60 * 1000) return usageBrief;
  try {
    const r = await usageReport();
    const days = {};
    // 键是日期标签（如 11-19），各人一致；值是当天总量（卡上 + 空转 + leader + 其他）和调用次数
    for (const d of r.daily ?? []) if (d.date) days[d.date] = { total: (d.work ?? 0) + (d.idle ?? 0) + (d.leader ?? 0) + (d.other ?? 0), calls: d.calls ?? 0 };
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const doneTasks = store.state.tasks.filter((t) => t.status === 'approved' && t.kind !== 'demo'
      && ([...(t.history ?? [])].reverse().find((h) => h.type === 'approved')?.ts ?? 0) >= since);
    let cardSum = 0;
    let cardN = 0;
    for (const t of doneTasks) {
      const u = r.perTask?.get(t.id);
      if (u) { cardSum += (u.input ?? 0) + (u.cacheRead ?? 0) + (u.output ?? 0); cardN++; }
    }
    const rejected = doneTasks.filter((t) => (t.rejectCount ?? 0) > 0).length;
    usageBrief = { days, cards: doneTasks.length, perCard: cardN ? Math.round(cardSum / cardN) : null, reworkRate: doneTasks.length ? rejected / doneTasks.length : null };
    usageBriefAt = Date.now();
  } catch {}
  return usageBrief;
}
async function syncPush(running = true) {
  const top = syncTop();
  const meta = { name: syncCfg.name, format: SYNC_FORMAT, ateamVersion: ateamVersion(), host: thisHost(), project: syncProject, presence: syncPresence(running) };
  const usage = running ? await syncUsage() : null;
  if (usage) meta.usage = usage;
  const { changed } = await writeSelf({ top, dataDir, meta });
  if (!changed && !syncState.unpushed) return;
  syncState.unpushed = true;
  await pushSelf({ top, remote: syncCfg.remote, name: syncCfg.name, project: syncProject });
  syncState.unpushed = false;
  syncState.pushedAt = Date.now();
}
// 代码分支：和远程的差距；开了自动推送 / 拉取就顺手做。看板「待处理」据此提醒
const landedCache = new Map();
async function syncCode() {
  const prev = syncState.code ?? {};
  let c;
  try {
    c = await codeStatus({ top: syncTop(), remote: syncCfg.remote });
  } catch (err) {
    syncState.code = { ...prev, error: explainGitError(err) };
    return;
  }
  const cfg = store.config();
  let error = null;
  let { ahead = 0, behind = 0 } = c;
  if (!c.detached && !c.noUpstream) {
    if (cfg.autoPush && ahead > 0 && behind === 0) {
      try { await pushCode({ top: syncTop(), remote: syncCfg.remote, branch: c.branch }); ahead = 0; syncState.codePushedAt = Date.now(); } catch (err) { error = `自动推送失败：${explainGitError(err)}`; }
    }
    if (cfg.autoPull && behind > 0 && ahead === 0 && !c.dirty) {
      try { await fastForward({ top: syncTop(), upstream: c.upstream }); behind = 0; syncState.codePulledAt = Date.now(); } catch (err) { error = `自动拉取失败：${explainGitError(err)}`; }
    }
  }
  const now = Date.now();
  syncState.code = {
    ...c, ahead, behind, error, checkedAt: now,
    aheadSince: ahead > 0 ? (prev.ahead > 0 ? prev.aheadSince : now) : null,
    behindSince: behind > 0 ? (prev.behind > 0 ? prev.behindSince : now) : null,
  };
}
// 看板和「待处理」看的代码分支状态
export function codeView() {
  const c = syncState.code;
  if (!c) return null;
  return { branch: c.branch ?? null, detached: !!c.detached, noUpstream: !!c.noUpstream, ahead: c.ahead ?? 0, behind: c.behind ?? 0, dirty: !!c.dirty,
    aheadSince: c.aheadSince ?? null, behindSince: c.behindSince ?? null, error: c.error ?? null, checkedAt: c.checkedAt ?? null,
    pushedAt: syncState.codePushedAt ?? null, pulledAt: syncState.codePulledAt ?? null, autoPush: !!store.config().autoPush, autoPull: !!store.config().autoPull };
}
async function syncFetch() {
  const top = syncTop();
  await fetchPeers({ top, remote: syncCfg.remote });
  await syncCode();
  syncState.peers = await readPeers({ top, self: syncCfg.name, cache: syncCache });
  syncState.fetchedAt = Date.now();
  const now = Date.now();
  const upstream = syncState.code?.upstream ?? null;
  const recent = 3 * 24 * 60 * 60 * 1000; // 3 天前通过的卡不再看推没推（多半早推了，或者就是不推）
  const list = [];
  for (const p of syncState.peers) {
    if (!p.board) continue;
    const fresh = now - p.at < PEER_STALE_MS;
    p.unpushedIds = [];
    for (const t of p.board.tasks ?? []) {
      if (t.kind === 'demo' || t.status === 'cancelled') continue;
      let unpushed = false;
      if (t.status === 'approved') {
        const at = [...(t.history ?? [])].reverse().find((h) => h.type === 'approved')?.ts ?? 0;
        if (!upstream || !t.commits?.length || now - at > recent) continue;
        unpushed = !(await commitsLanded({ top, upstream, shas: t.commits, cache: landedCache }));
        if (!unpushed) continue;
        p.unpushedIds.push(t.id);
      }
      list.push({ peer: p.name, id: t.id, title: t.title, status: t.status, paths: t.paths ?? [], assignee: t.assignee ?? null, fresh, unpushed });
    }
  }
  store.setPeerTasks(list);
  // 同事的卡交了：被挡住的卡可能能派了，叫醒等着的 worker；看板刷新
  wakeSoon();
  pushSoon();
}
export async function syncTick() {
  if (!syncCfg.enabled || !syncCfg.name) return;
  await syncRun(async () => {
    try {
      await syncPush();
      await syncFetch();
      syncState.error = null;
    } catch (err) {
      syncState.error = err.stderr || err.killed ? explainGitError(err) : err.message;
    }
  });
}
// 服务正常停止前推最后一次「已停止」，同事那边马上显示离线（最多等 5 秒）
export async function syncFinal() {
  if (!syncCfg.enabled || !syncCfg.name) return;
  await Promise.race([syncPush(false).catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
}
export function syncSoon() {
  if (!syncCfg.enabled || syncTimer) return;
  syncTimer = setTimeout(() => { syncTimer = null; syncTick().catch(() => {}); }, 30000);
  syncTimer.unref?.();
}

// 自动开启：这台电脑没对这个项目做过选择（开启、关闭都没有），而仓库里的 .ateam/.gitignore 有迁移提交写的说明行
// （同事已经让这个项目改用看板同步，拉代码时带过来了），就用 git 用户名开启。名字被占用之类的问题不再重试，到设置里手动处理
let syncAutoError = null;
let syncAutoGaveUp = false;
export async function syncAuto() {
  if (syncCfg.enabled || syncAutoGaveUp || hasSyncConfig(root) || !syncRel()) return;
  let text = '';
  try { text = readFileSync(join(dataDir, '.gitignore'), 'utf8'); } catch { return; }
  if (!text.split(/\r?\n/).some((l) => l.trim() === SYNC_MARK)) return;
  const next = { ...syncCfg, enabled: true, remote: syncCfg.remote || 'origin' };
  next.name = await defaultName(syncTop(next));
  next.remote = await pickRemote(syncTop(next), next.remote);
  const ok = await syncRun(async () => {
    try {
      checkSyncConfig(next);
      await claimName({ top: syncTop(next), remote: next.remote, name: next.name, project: syncProject });
      syncAutoError = null;
    } catch (err) {
      // git 命令失败（网络、凭据）下一分钟再试；名字被占用、名字不合法等不再试
      syncAutoError = err.stderr || err.killed ? explainGitError(err) : err.message;
      if (!(err.stderr || err.killed)) syncAutoGaveUp = true;
      throw err;
    }
  }).catch(() => null);
  if (!ok) return;
  saveSyncConfig(root, { ...next, autoAt: Date.now() });
  syncCfg = readSyncConfig(root);
  console.log(`检测到项目已改用看板同步，已自动开启，同步名称 ${syncCfg.name}`);
  await syncTick();
  pushSoon();
}
// 看板「设置 → 多人协作」和 ateam sync 用的状态。peers 给「同事」页
export async function syncStatus() {
  const top = syncTop();
  const rel = syncRel();
  const tracked = rel ? (await trackedBoardFiles({ top, rel })).length : 0;
  const now = Date.now();
  const mine = store.state.tasks.filter((t) => t.kind !== 'demo' && !['approved', 'cancelled'].includes(t.status));
  const norm = (p) => String(p).replace(/^\.\//, '').replace(/\/+$/, '');
  const overlap = (a, b) => a.some((x) => b.some((y) => { x = norm(x); y = norm(y); return !x || !y || x === y || y.startsWith(`${x}/`) || x.startsWith(`${y}/`); }));
  const peers = syncState.peers.map((p) => {
    // 在线状态：服务停了（正常停止时推过「已停止」）/ 超过 2 小时没同步 / 超过 15 分钟没同步（心跳 10 分钟一次，多半已关机或断网）/ 有 worker 在做卡 / 空闲
    const pres = p.meta?.presence ?? null;
    const age = now - p.at;
    const state = pres && pres.running === false ? 'stopped' : age >= PEER_STALE_MS ? 'away' : age >= PEER_ONLINE_MS ? 'offline'
      : pres?.workers?.some((w) => w.task) ? 'busy' : 'idle';
    const base = { name: p.name, at: p.at, away: age >= PEER_STALE_MS, state, presence: pres && pres.running !== false ? { leader: !!pres.leader, workers: pres.workers ?? [] } : null,
      usage: p.meta?.usage ?? null, version: p.meta?.ateamVersion ?? null, newer: !!p.newer, error: p.error ?? null };
    if (!p.board) return base;
    const tasks = (p.board.tasks ?? []).filter((t) => t.kind !== 'demo');
    const jobs = (p.board.jobs ?? []).filter((j) => !j.demo && !['accepted', 'cancelled'].includes(j.status)).map((j) => {
      const mineT = tasks.filter((t) => t.jobId === j.id && t.status !== 'cancelled');
      return { id: j.id, title: j.title, status: j.status, done: mineT.filter((t) => t.status === 'approved').length, total: mineT.length };
    });
    const unpushed = new Set(p.unpushedIds ?? []);
    const open = tasks.filter((t) => !['approved', 'cancelled'].includes(t.status) || unpushed.has(t.id)).map((t) => ({
      unpushed: unpushed.has(t.id),
      id: t.id, jobId: t.jobId, title: t.title, role: t.role, status: t.status, assignee: t.assignee ?? null, paths: t.paths ?? [],
      description: t.description ?? '', acceptance: t.acceptance ?? [],
      since: [...(t.history ?? [])].reverse().find((h) => ['claimed', 'rejected', 'submitted', 'asked'].includes(h.type))?.ts ?? null,
      overlap: mine.filter((m) => overlap(m.paths ?? [], t.paths ?? [])).map((m) => m.id),
    }));
    return { ...base, jobs, tasks: open };
  });
  return {
    ...syncCfg, host: thisHost(), defaultName: syncCfg.name || await defaultName(top),
    repos: layout.mode === 'multi' ? layout.repos : null, tracked, busy: syncBusy,
    pushedAt: syncState.pushedAt, fetchedAt: syncState.fetchedAt, error: syncState.error, peers, code: syncCfg.enabled ? codeView() : null,
    // 「用量 → 团队」里自己那一行；目录归属（同事页显示各人负责的目录）
    selfUsage: syncCfg.enabled ? await syncUsage(true) : null, owners: parseOwners(readOwners()), autoError: syncCfg.enabled ? null : syncAutoError,
  };
}
// 开启 / 改名 / 改远程：先确认名字可用（远程同名分支是别的电脑的就报错），再立即同步一次
export async function syncConfigure(b) {
  const patch = {};
  if (b.remote !== undefined) patch.remote = String(b.remote).trim() || 'origin';
  if (b.repo !== undefined) patch.repo = String(b.repo);
  if (b.name !== undefined) patch.name = String(b.name).trim();
  if (b.enabled === false) {
    saveSyncConfig(root, { ...patch, enabled: false });
    syncCfg = readSyncConfig(root);
    syncState.peers = [];
    store.setPeerTasks([]);
    pushSoon();
    return syncStatus();
  }
  const next = { ...syncCfg, ...patch, enabled: b.enabled === true ? true : syncCfg.enabled };
  if (next.enabled) {
    if (!next.name) next.name = await defaultName(syncTop(next));
    next.remote = await pickRemote(syncTop(next), next.remote);
    try { checkSyncConfig(next); } catch (err) { throw new AteamError('INVALID', err.message); }
    const ok = await syncRun(async () => {
      try {
        await claimName({ top: syncTop(next), remote: next.remote, name: next.name, project: syncProject });
      } catch (err) {
        throw new AteamError('INVALID', err instanceof AteamError || !err.stderr ? err.message : explainGitError(err));
      }
    });
    if (!ok) throw new AteamError('INVALID', '正在同步，请稍后再试。');
  }
  saveSyncConfig(root, next);
  syncCfg = readSyncConfig(root);
  if (syncCfg.enabled) await syncTick();
  pushSoon();
  return syncStatus();
}
