// 启动 worker、缺人时的启动角色、worker 换新会话、体检、ego-browser profile 列表

import { execFile } from 'node:child_process';
import { runDoctor } from '../doctor.js';
import { WIN } from '../install.js';
import { spawnWorker } from '../spawn.js';
import { layout, root, store } from './context.js';
import { installInfo } from './install-info.js';
import { pushSoon } from './live.js';
import { usageReport } from './usage.js';

export const spawnTimes = []; // 最近启动 worker 的时间，算上还没加入的
export let doctor = null; // 自检结果：启动后在后台跑一次，看板打开「待处理」、点「修复」时重跑
export async function recheck() {
  doctor = await runDoctor({ root, install: installInfo(), multi: layout.mode === 'multi', testBrowser: store.config().testBrowser });
  pushSoon();
}
// ego-browser 测试用 profile：名称以 ateam 开头的（不含默认 profile）自动启用。ego 没有新建 profile 的接口，
// 用户在 ego lite 里新建，看板「刷新」或过 5 分钟后重新读取。只在「测试用的浏览器」选了 ego-browser 时读
const EGO_PROFILE_TTL = 5 * 60 * 1000;
export let egoProfiles = { list: [], at: 0, error: null };
let egoLoading = null;
export function refreshEgoProfiles() {
  if (egoLoading) return egoLoading;
  egoLoading = new Promise((done) => {
    const bin = installInfo().egoBin;
    if (!bin) {
      egoProfiles = { list: [], at: Date.now(), error: '未找到 ego-browser 命令，请先安装 ego lite。' };
      return done();
    }
    // ego-browser nodejs 里 console.log 的输出走 stderr，两路都找；加前缀标记，免得混进别的提示行
    const code = 'console.log("ATEAM_PROFILES " + JSON.stringify(await profiles()))';
    // Windows 上 .cmd 要经过 cmd.exe 运行（Node 不让直接 execFile），参数自己加引号
    const [file, args, extra] = WIN && /\.cmd$/i.test(bin)
      ? ['cmd.exe', ['/d', '/s', '/c', `""${bin}" nodejs -e "${code.replace(/"/g, '\\"')}""`], { windowsVerbatimArguments: true }]
      : [bin, ['nodejs', '-e', code], {}];
    execFile(file, args, { timeout: 15000, windowsHide: true, ...extra }, (err, stdout, stderr) => {
      try {
        if (err) throw err;
        const line = `${stdout}\n${stderr}`.split('\n').find((l) => l.startsWith('ATEAM_PROFILES '));
        if (!line) throw new Error('ego-browser 没有返回 profile 列表');
        const all = JSON.parse(line.slice('ATEAM_PROFILES '.length));
        const list = all.filter((p) => p && !p.isDefault && /^ateam/i.test(String(p.name ?? '')))
          .map((p) => ({ id: String(p.id), name: String(p.name) }))
          .sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }));
        egoProfiles = { list, at: Date.now(), error: null };
      } catch (e) {
        // 读失败时沿用上次读到的列表，免得 ego 临时没响应就全退回默认 profile
        egoProfiles = { list: egoProfiles.list, at: Date.now(), error: `读取 ego profile 失败：${String(e?.message ?? e).split('\n')[0].slice(0, 200)}` };
      }
      done();
    });
  }).finally(() => { egoLoading = null; pushSoon(); });
  return egoLoading;
}
export function egoProfileList() {
  if (store.config().testBrowser !== 'ego') return [];
  if (Date.now() - egoProfiles.at > EGO_PROFILE_TTL) refreshEgoProfiles().catch(() => {});
  return egoProfiles.list;
}

// 菜单栏「启动 worker」可选的角色：标准角色 + 未完成的卡和在线 worker 用到的角色；缺人的标出来（与看板「worker」页一致）
const STANDARD_ROLES = [['product', '产品'], ['architect', '架构'], ['frontend', '前端'], ['backend', '后端'], ['test', '测试'], ['critic', '审卡']];
export function spawnRoles() {
  const st = store.state;
  const roles = new Map(STANDARD_ROLES.map(([key, label]) => [key, { role: key, label }]));
  for (const t of st.tasks) if (t.status !== 'approved' && t.status !== 'cancelled') { const k = t.role.trim().toLowerCase(); if (!roles.has(k)) roles.set(k, { role: t.role, label: null }); }
  for (const a of st.agents) if (!a.hidden) { const k = a.role.trim().toLowerCase(); if (!roles.has(k)) roles.set(k, { role: a.role, label: null }); }
  const needs = new Set(store.staffingNeeds().needs.map((n) => n.role.trim().toLowerCase()));
  const online = st.agents.filter((a) => a.status === 'online');
  const platform = store.config().spawnPlatform;
  return {
    platform: platform === 'workbuddy' ? 'WorkBuddy' : 'DeepSeek Harness',
    // 缺人的排前面
    roles: [...roles].map(([k, r]) => ({ ...r, needed: needs.has(k), online: online.filter((a) => a.role.trim().toLowerCase() === k).length })).sort((a, b) => b.needed - a.needed),
  };
}

// 同一个会话连做几张卡，前面的对话一直留在上下文里，后面每次调用都要重读，越做越贵。
// 按会话记录看在线 worker 最近一次调用读入了多少（输入 + 缓存命中），超过设置就打标记：手上的卡通过后不再领新卡、下线，
// 服务马上开一个同角色的新 worker 接着领（rotateSpawn）。WorkBuddy 没有本机记录，不换
export async function checkRotate() {
  const limit = store.config().rotateCtx * 1e4;
  if (!limit) return;
  const online = store.state.agents.filter((a) => a.status === 'online' && !a.rotate && !a.dismiss && a.role.trim().toLowerCase() !== 'critic');
  if (!online.length) return;
  const r = await usageReport();
  const latest = new Map();
  for (const rec of r.collected?.records ?? []) {
    if (!rec.agentId || rec.snapshot) continue;
    const cur = latest.get(rec.agentId);
    if (!cur || rec.t > cur.t) latest.set(rec.agentId, rec);
  }
  for (const a of online) {
    const rec = latest.get(a.id);
    if (!rec || rec.t < (a.joinedAt ?? 0)) continue; // 编号让给了新会话、新会话还没调用过
    const ctx = rec.input + rec.cacheRead;
    if (ctx >= limit) store.markRotate(a.id, Math.round(ctx / 1e4));
  }
}
// 换下来的 worker 已下线：这个角色还有能领的卡就开一个新的接着做（和「启动」按钮相同，在设置选的平台里新建会话）；没有就不开，之后缺人照常提醒
export function rotateSpawn(role, oldId, ctx) {
  const st = store.state;
  const approved = new Set(st.tasks.filter((t) => t.status === 'approved').map((t) => t.id));
  const heldJobs = new Set(st.jobs.filter((j) => j.onHold).map((j) => j.id));
  const same = (x) => x.trim().toLowerCase() === role.trim().toLowerCase();
  const waiting = st.tasks.some((t) => t.status === 'pending' && same(t.role) && !t.onHold && !heldJobs.has(t.jobId) && t.dependsOn.every((d) => approved.has(d)));
  console.log(`${oldId} 上下文约 ${ctx} 万 token，已下线换新会话${waiting ? `，正在启动新的 ${role} worker` : `；${role} 暂时没有能领的卡，不启动新 worker`}`);
  if (!waiting) return;
  spawnTimes.push(Date.now());
  spawnWorker({ root, role, platform: store.config().spawnPlatform })
    .catch((err) => console.log(`启动新的 ${role} worker 失败：${err?.message ?? err}`));
}
