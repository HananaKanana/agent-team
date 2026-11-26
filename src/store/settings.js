// 设置：看板「设置」页的配置项、默认值、校验和保存（存在 state.settings）

import { VIEWPORT_RE } from '../demo.js';
import { AteamError } from '../errors.js';
import { changed, defaultIdleMs, defaultLeaseMs, state } from './core.js';
import { emit } from './common.js';

// 用户在看板「设置」页改的配置，存在 state.settings 里，重启不丢。没改过的用默认值。
const SETTINGS = {
  criticAutoLeave: { type: 'bool', def: () => false },
  keepOnePerRole: { type: 'bool', def: () => true },
  leaseMin: { type: 'num', min: 1, max: 240, def: () => defaultLeaseMs / 60000 },
  idleMin: { type: 'num', min: 1, max: 240, def: () => defaultIdleMs / 60000 },
  rejectLimit: { type: 'int', min: 1, max: 10, def: () => 3 },
  // 无 leader 模式：autoNoLeader 关着时只有用户在看板上宣布 leader 下线才进入；开着时 leader 掉线（有事没处理、超过 leaderAwayMin 没操作）也自动进入
  autoNoLeader: { type: 'bool', def: () => false },
  leaderAwayMin: { type: 'int', min: 1, max: 120, def: () => 10 },
  // 演播视口：预演按它录，演播沿用这张卡预演时记下的尺寸
  demoViewport: { type: 'size', def: () => '1600x800' },
  // 自动启动 worker：leader 能不能自己 ateam spawn（看板上的按钮不受限），以及在哪个平台里开
  leaderSpawn: { type: 'bool', def: () => false },
  spawnPlatform: { type: 'choice', options: ['dsh', 'workbuddy'], def: () => 'dsh' },
  // leader 自动启动的上限：同时在线的 worker 到这个数就不让 leader 再开（用户自己开不受限）。0 表示不限
  maxWorkers: { type: 'int', min: 0, max: 50, def: () => 5 },
  // test worker 测试和预演用哪个浏览器：platform = 平台自带（DSH 用 dsh-cdp，WorkBuddy 用自带 Chrome 插件），ego = ego-browser。
  // 演播照「## 操作记录」里录的工具走，不看这个
  testBrowser: { type: 'choice', options: ['platform', 'ego'], def: () => 'platform' },
  // worker 换新会话：上下文（最近一次调用读入的 token，单位万）超过这个数，做完手上的卡后下线，由服务开一个同角色的新 worker 接着领卡。0 表示不换
  rotateCtx: { type: 'int', min: 0, max: 100, def: () => 15 },
  // 多人协作：本地分支领先远程时自动推送 / 落后时自动快进拉取（只在没有未提交改动时）。会动大家共用的分支，默认关
  autoPush: { type: 'bool', def: () => false },
  autoPull: { type: 'bool', def: () => false },
  // 同步看板时附带用量摘要（每天合计、每卡平均、打回率），同事的「用量 → 团队」能看到
  shareUsage: { type: 'bool', def: () => true },
  // 提交检查：开发卡 ateam submit 时在 worker 那边依次运行的命令（一行一条），有一条退出码非 0 就不提交。空 = 不检查
  submitChecks: { type: 'text', def: () => '' },
  submitCheckMin: { type: 'int', min: 1, max: 120, def: () => 15 },
};

export function config() {
  const out = {};
  for (const [key, spec] of Object.entries(SETTINGS)) out[key] = state.settings?.[key] ?? spec.def();
  // Windows 上只支持 ego-browser（dsh-cdp 的启动脚本、窗口控制只有 Mac 版）。看板同步来的设置也按这台电脑算
  if (process.platform === 'win32') out.testBrowser = 'ego';
  return out;
}

export function setSettings(patch = {}) {
  const before = config().leaderSpawn;
  state.settings ??= {};
  for (const [key, value] of Object.entries(patch)) {
    const spec = SETTINGS[key];
    if (!spec) continue;
    if (value === null) { delete state.settings[key]; continue; }
    if (spec.type === 'bool') { state.settings[key] = !!value; continue; }
    if (spec.type === 'text') {
      if (typeof value !== 'string' || value.length > 4000) throw new AteamError('INVALID', `${key} 必须是不超过 4000 字的文本。`);
      state.settings[key] = value.split(/\r?\n/).map((l) => l.trimEnd()).join('\n').trim();
      continue;
    }
    if (spec.type === 'choice') {
      if (!spec.options.includes(value)) throw new AteamError('INVALID', `${key} 只能是 ${spec.options.join('、')} 之一。`);
      state.settings[key] = value;
      continue;
    }
    if (spec.type === 'size') {
      const m = String(value).trim().toLowerCase().match(VIEWPORT_RE);
      if (!m || [m[1], m[2]].some((v) => Number(v) < 320 || Number(v) > 7680)) throw new AteamError('INVALID', `${key} 要写成 宽x高，比如 1600x800（宽高在 320 到 7680 之间）。`);
      state.settings[key] = `${Number(m[1])}x${Number(m[2])}`;
      continue;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < spec.min || n > spec.max || (spec.type === 'int' && !Number.isInteger(n))) {
      throw new AteamError('INVALID', `${key} 必须是 ${spec.min} 到 ${spec.max} 之间的${spec.type === 'int' ? '整数' : '数'}。`);
    }
    state.settings[key] = n;
  }
  // leader 能不能自己启动 worker 变了：告诉 leader，它才知道该自己开还是请用户开
  if (config().leaderSpawn !== before) {
    emit('leader_spawn', { on: config().leaderSpawn, text: config().leaderSpawn ? '用户允许你自动启动 worker 了' : '用户收回了自动启动 worker 的权限' });
  }
  changed();
  return config();
}
