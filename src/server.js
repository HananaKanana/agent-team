// HTTP 路由、长轮询挂起和唤醒、租约定时扫描、落盘、托管看板。
import { execFile, spawn } from 'node:child_process';
import http from 'node:http';
import { homedir, networkInterfaces } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, readdirSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnWorker } from './spawn.js';
import { readFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AteamError } from './errors.js';
import { createStore } from './store.js';
import { addRule, leadRules, needsTidy, rulesFor, sectionCounts, unreceived } from './rules.js';
import { runDoctor } from './doctor.js';
import { APP_DIR, devRepo, installed, mode as runMode, modeLabel, modeMismatch, rememberProject, version as ateamVersion, WIN, WRAPPER } from './install.js';
import { check as checkRelease, install as installRelease } from './update.js';
import { anyPushOn, EVENT_TYPES, eventOn, maskedPush, pushEnabled, readDigest, readPrefs, saveDigest, savePrefs, savePush, sendPush, setPushEnabled } from './push.js';
import { buildDigest, dueAt, DIGEST_SECTIONS } from './digest.js';
import { loadState, saveState } from './persist.js';
import { collect as collectUsage, totalOf } from './usage.js';
import { buildReport } from './usage-report.js';
import { checkSyncConfig, claimName, hasSyncConfig, pickRemote, codeStatus, commitsLanded, pushCode, fastForward, SYNC_MARK, defaultName, explainGitError, fetchPeers, PEER_STALE_MS, pushSelf, readPeers, readSyncConfig, saveSyncConfig, SYNC_FORMAT, thisHost, trackedBoardFiles, untrackBoardFiles, writeSelf } from './sync.js';
import { commitPaths, commitStats, detectRepos, ensureGitignore, headContent, latestChangeTime } from './git.js';
import { DEFAULT_TEST_TEMPLATE } from './format.js';
import { saveViewPref, viewPrefs } from './view-prefs.js';
import { checkOps, clearOps, opsSection, parseOps, parseSteps, stepCount, withoutOps } from './demo.js';

const DASHBOARD = join(dirname(fileURLToPath(import.meta.url)), 'dashboard.html');
const PROMPTER_JXA = join(dirname(fileURLToPath(import.meta.url)), 'prompter.jxa');
// agent-team 自己的安装目录，看板「安装」页用它拼出安装命令
const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 1024 * 1024;
const DEFAULT_HOLD_SEC = 90;
const MAX_HOLD_SEC = 110;
const WAIT_RENEW_GAP_MS = 2000;
const LEADER_FRESH_MS = 3 * 60 * 1000;
const MAX_RULES = 20 * 1024;
// 新领到、接手、继续的任务附上项目规则；打回意见和答复只是补充消息，不重复附
const RULES_KINDS = new Set(['task', 'handoff', 'resume', 'own', 'demo', 'demo_stopped', 'demo_wrap']);
// 输出里带「## 浏览器」一节的派发：ego-browser 时都要分配（或沿用）测试用 profile，前后说明的空间名才一致
const EGO_KINDS = new Set([...RULES_KINDS, 'rejected', 'back', 'answer']);

// 服务端代码指纹：src/*.js 和 bin/ateam.js 的内容哈希。启动时记一份，之后比对，
// 代码被更新（git pull、改了代码）而服务没重启时，看板和 status 提示重启。
// 只在文件修改时间变了时才重新读内容，看板每 3 秒查一次也不费事。
const CODE_FILES = () => [
  ...readdirSync(join(TOOL_DIR, 'src')).filter((f) => f.endsWith('.js')).map((f) => join(TOOL_DIR, 'src', f)),
  join(TOOL_DIR, 'bin', 'ateam.js'),
];
let codeCache = { key: '', hash: '' };
function codeHash() {
  try {
    const files = CODE_FILES().sort();
    const key = files.map((f) => `${f}:${statSync(f).mtimeMs}`).join('|');
    if (key !== codeCache.key) {
      const h = createHash('sha1');
      for (const f of files) h.update(f).update(readFileSync(f));
      codeCache = { key, hash: h.digest('hex') };
    }
    return codeCache.hash;
  } catch {
    return codeCache.hash;
  }
}

function holdMs(timeout) {
  const sec = Number(timeout);
  if (!Number.isFinite(sec) || sec <= 0) return DEFAULT_HOLD_SEC * 1000;
  return Math.min(sec, MAX_HOLD_SEC) * 1000;
}

function send(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

// 带 ETag 返回：内容没变时只回 304，看板每 3 秒轮询不用每次传整份状态
function sendCached(req, res, body) {
  const data = JSON.stringify(body);
  const etag = `"${createHash('sha1').update(data).digest('base64url')}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), etag });
  res.end(data);
}

function sendError(res, err) {
  if (err instanceof AteamError) send(res, 400, { ok: false, code: err.code, message: err.message });
  else send(res, 500, { ok: false, code: 'INTERNAL', message: err?.message ?? String(err) });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new AteamError('INVALID', '请求体超过 1MB。请缩短内容后重试。'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        const body = JSON.parse(text);
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch {
        reject(new AteamError('INVALID', '请求体不是合法的 JSON 对象。'));
      }
    });
    req.on('error', reject);
  });
}

// 本机 DeepSeek Harness 的安装情况，给「安装」页拼命令用。
// skill 目录：已经放着 ateam-worker 的那个优先，其次是存在的，都没有就用 ~/.agents/skills。
// profile：$DSH_HOME/profiles 下的目录（DSH_HOME 默认 ~/.dsh）
function installInfo() {
  const home = homedir();
  const dshHome = process.env.DSH_HOME || join(home, '.dsh');
  const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
  const profilesDir = join(dshHome, 'profiles');
  // 真正的 profile 目录里有 cordis.yml（跳过 node_modules 之类）；当前会话用的（DSH_PROFILE）排最前
  const profiles = (isDir(profilesDir) ? readdirSync(profilesDir).filter((n) => existsSync(join(profilesDir, n, 'cordis.yml'))).sort() : [])
    .sort((a, b) => (b === process.env.DSH_PROFILE) - (a === process.env.DSH_PROFILE));
  const skillCandidates = [join(home, '.agents', 'skills'), join(dshHome, 'skills'), ...profiles.map((p) => join(profilesDir, p, 'skills'))];
  const has = (dir, name) => { try { lstatSync(join(dir, name)); return true; } catch { return false; } };
  const skillsDir = skillCandidates.find((d) => has(d, 'ateam-worker')) || skillCandidates.find(isDir) || skillCandidates[0];
  // browser-cdp-setup：linked = 软链到本仓库；copied = 有但不是软链（要先删掉再链）
  let browserSkill = 'missing';
  try {
    const st = lstatSync(join(skillsDir, 'browser-cdp-setup'));
    browserSkill = st.isSymbolicLink() && resolve(skillsDir, readlinkSync(join(skillsDir, 'browser-cdp-setup'))) === join(TOOL_DIR, 'skills', 'browser-cdp-setup') ? 'linked' : 'copied';
  } catch {}
  // 每个 profile 的 cordis.patch.yml 里有没有配 dsh-cdp 的 dataDir
  const cdpConfigured = Object.fromEntries(profiles.map((p) => {
    let text = '';
    try { text = readFileSync(join(profilesDir, p, 'cordis.patch.yml'), 'utf8'); } catch {}
    // 只在 dsh-cdp 这一条的范围内找 dataDir，不跨到后面别的条目
    return [p, /^- id:\s*['"]?dsh-cdp['"]?[ \t]*\n(?:(?:[ \t].*)?\n)*?[ \t]+dataDir:/m.test(text)];
  }));
  const hookInstalled = profiles.some((p) => {
    try { return readFileSync(join(profilesDir, p, 'cordis.patch.yml'), 'utf8').includes('ateam-hooks-3.json'); } catch { return false; }
  });
  // WorkBuddy：用户级 settings.json 里有 ateam 的 hook 命令
  const workbuddyFile = [join(home, '.workbuddy', 'settings.json'), join(home, '.codebuddy', 'settings.json')].find((f) => existsSync(f));
  let workbuddyHook = null;
  if (workbuddyFile) { try { workbuddyHook = readFileSync(workbuddyFile, 'utf8').includes('hook pre-browser'); } catch {} }
  // ego-browser：命令装在 ~/.local/bin（服务的 PATH 里不一定有），skill 由 ego lite 安装时自己链接到各平台的 skill 目录
  const egoNames = WIN ? ['ego-browser.exe', 'ego-browser.cmd'] : ['ego-browser'];
  const egoBin = [join(home, '.local', 'bin'), ...String(process.env.PATH ?? '').split(delimiter).filter(Boolean)].flatMap((d) => egoNames.map((n) => join(d, n))).find((f) => existsSync(f)) ?? null;
  const egoSkill = Object.fromEntries([['DeepSeek Harness', skillsDir], ['WorkBuddy', join(home, '.workbuddy', 'skills')]].map(([k, d]) => [k, existsSync(join(d, 'ego-browser', 'SKILL.md'))]));
  return { home, dshHome, profilesDir, profiles, skillsDir, browserSkill, cdpConfigured, hookInstalled, workbuddyHook, egoBin, egoSkill, toolDir: TOOL_DIR };
}

// 局域网访问（--lan）：监听所有网卡，别的电脑打开看板只能看、不能改；所有改动只认本机
function lanAddresses() {
  // 去重；198.18.0.0/15 是代理软件（Clash、Surge 等）虚拟网卡常用的地址，别的电脑连不上，不列
  const ips = Object.values(networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  return [...new Set(ips)].filter((ip) => !/^198\.1[89]\./.test(ip));
}

// argv：启动参数（重启时原样带上，端口固定为当前端口）
export async function startServer({ root, port = 7700, autoPort = false, leaseMin = 15, idleMin = 3, lan = false, argv = [] } = {}) {
  const layout = await detectRepos(root);
  const startHash = codeHash();
  // 服务需要重启的原因：切换了运行模式（dev / installed，启动脚本会改用另一份代码），或代码改过（code）；都没有为 null
  const staleWhy = () => modeMismatch() ?? (codeHash() !== startHash ? 'code' : null);
  // 单仓库：把 .ateam/ 加进项目的 .gitignore。多仓库：项目目录本身不是仓库，不用加
  if (layout.mode === 'single') ensureGitignore(root);

  const dataDir = join(root, '.ateam');
  const leaseMs = leaseMin * 60 * 1000;
  const waiters = new Map(); // agentId -> { res, timer }
  const waitRenewAt = new Map(); // agentId -> 上一段 wait 超时结束的时间
  const watchers = new Set(); // { res, timer }
  let leaderSeenAt = null; // leader 最近一次用命令行操作的时间（只在内存里，重启后等 leader 下次操作）
  // leader 在线：挂着 watch 监听，或 3 分钟内用命令行操作过
  const leaderOnline = () => watchers.size > 0 || (leaderSeenAt !== null && Date.now() - leaderSeenAt < LEADER_FRESH_MS);
  let waking = false;
  let wakeScheduled = false;

  // 项目规则：.ateam/rules.md，每个任务都要遵守的约定（不写测试、提交前跑编译……）。
  // 每次派任务时现读，用户或 leader 改了马上生效。
  const rulesFile = join(dataDir, 'rules.md');
  function readRules() {
    try { return readFileSync(rulesFile, 'utf8'); } catch { return ''; }
  }
  function writeRules(text) {
    if (typeof text !== 'string') throw new AteamError('INVALID', '规则内容必须是文本。');
    if (Buffer.byteLength(text) > MAX_RULES) throw new AteamError('INVALID', '项目规则超过 20KB。规则是每个任务都要读的，请精简到最重要的几条。');
    mkdirSync(dataDir, { recursive: true });
    const tmp = `${rulesFile}.tmp`;
    writeFileSync(tmp, text.trim() ? `${text.trim()}\n` : '');
    renameSync(tmp, rulesFile);
    return readRules();
  }
  // leader 用命令行改规则要用户同意；看板保存（用户本人）带 userApproved
  function approvedRules(text, userApproved, preview) {
    if (typeof text !== 'string') throw new AteamError('INVALID', '规则内容必须是文本。');
    if (!userApproved) throw new AteamError('NEEDS_USER', `${preview}请给用户看，用户同意后加 --user-approved 重新运行。`);
    return writeRules(text);
  }
  function countsChange(before, after) {
    const a = new Map(sectionCounts(before).map((c) => [c.section, c.count]));
    const b = new Map(sectionCounts(after).map((c) => [c.section, c.count]));
    const names = [...new Set([...a.keys(), ...b.keys()])];
    const diff = names.filter((n) => (a.get(n) ?? 0) !== (b.get(n) ?? 0)).map((n) => `${n} ${a.get(n) ?? 0} → ${b.get(n) ?? 0}`);
    return diff.length ? `改动前后各段条数：${diff.join('，')}。` : '各段条数没有变化，内容有改动。';
  }
  // 会领卡的角色。审卡 worker（critic）不收项目规则，不算在内：写了 ## critic 段会被提示没人收到
  const knownRoles = () => [...new Set([...store.state.tasks, ...store.state.agents].map((x) => x.role).filter(Boolean).map((r) => r.trim().toLowerCase()))].filter((r) => r !== 'critic').sort();
  // 预演开始时清空的操作记录：预演没跑完（走不通、叫停、结束收尾）卡回到待演播时，从 git 还原成上一版
  async function restoreOps(task) {
    const head = await headContent(root, task.script);
    if (head !== null) writeFileSync(join(root, task.script), head);
    store.markOpsCleared(task.id, false);
  }
  const settleOps = () => serial(async () => {
    for (const t of store.state.tasks) {
      if (t.kind === 'demo' && t.opsCleared && t.status === 'ready') await restoreOps(t);
    }
  });

  // 新领到、接手、继续的任务附上：所属需求的说明（这次需求的设计文档、计划在哪等，只对这个需求的任务有效）
  // 和项目规则（长期有效的约定）
  // 测试报告模板：.ateam/test-template.md，用户在看板「帮助 → 测试用例」里编辑（比如按客户的格式）。
  // 没有这个文件（没改过、或重置了）就用 ateam 自带的
  const testTemplateFile = join(dataDir, 'test-template.md');
  const MAX_TEST_TEMPLATE = 30 * 1024;
  function readTestTemplate() {
    try { return readFileSync(testTemplateFile, 'utf8'); } catch { return ''; }
  }
  function writeTestTemplate(text) {
    if (typeof text !== 'string') throw new AteamError('INVALID', '模板内容必须是文本。');
    if (Buffer.byteLength(text) > MAX_TEST_TEMPLATE) throw new AteamError('INVALID', '测试报告模板超过 30KB，请精简。');
    if (!text.trim() || text.trim() === DEFAULT_TEST_TEMPLATE.trim()) {
      // 清空或和自带的一样：删掉文件，回到自带模板（以后自带模板更新也能跟上）
      try { unlinkSync(testTemplateFile); } catch {}
      return '';
    }
    mkdirSync(dataDir, { recursive: true });
    const tmp = `${testTemplateFile}.tmp`;
    writeFileSync(tmp, `${text.trimEnd()}\n`);
    renameSync(tmp, testTemplateFile);
    return readTestTemplate();
  }
  // 测试卡：项目改过模板就附上全文（custom 为 true），没改过用 format.js 里自带的
  function testTemplateFor(task, full) {
    if (task.kind === 'demo' || !/^(test|qa|测试)$/i.test(String(task.role ?? '').trim())) return null;
    const text = readTestTemplate();
    if (!text.trim()) return null;
    return full ? { custom: true, text } : { custom: true };
  }

  function withRules(result, agentId) {
    if (!result) return result;
    // 测试卡、演播卡的输出里要写明这次用哪个浏览器（看板设置「测试用的浏览器」）
    const t = result.task;
    if (t && (t.kind === 'demo' || /^(test|qa|测试)$/i.test(String(t.role ?? '').trim()))) {
      result = { ...result, browser: store.config().testBrowser };
      // ego-browser：派卡、开始预演 / 演播时分一个测试用 profile 给这个 worker 独占（没有 ateam 开头的 profile 时不分，输出和以前一样）
      if (result.browser === 'ego' && agentId && EGO_KINDS.has(result.kind)) {
        const egoProfile = store.assignEgoProfile(t.id, agentId, egoProfileList());
        if (egoProfile) result.egoProfile = egoProfile;
      }
    }
    if (!RULES_KINDS.has(result.kind)) {
      const tpl = result.task && testTemplateFor(result.task, false);
      return tpl ? { ...result, testTemplate: tpl } : result;
    }
    const out = { ...result };
    const tpl = testTemplateFor(result.task, true);
    if (tpl) out.testTemplate = tpl;
    const rules = rulesFor(readRules(), result.task.role).trim();
    if (rules) out.rules = rules;
    const job = store.state.jobs.find((j) => j.id === result.task.jobId);
    if (job?.description?.trim()) out.job = { id: job.id, title: job.title, description: job.description.trim() };
    // 演播卡：附上脚本全文，worker 不用自己去找文件
    if (result.task.kind === 'demo') {
      try {
        const text = readFileSync(join(root, result.task.script), 'utf8');
        out.script = { path: result.task.script, text, steps: stepCount(text), hasOps: !!opsSection(text).replace(/<!--[\s\S]*?-->/g, '').trim() };
      } catch (err) {
        out.script = { path: result.task.script, text: '', steps: 0, hasOps: false, error: `读不到脚本文件：${err.message}` };
      }
      const runs = result.task.runs ?? [];
      out.script.mode = runs[runs.length - 1]?.mode ?? 'show';
      out.script.only = runs[runs.length - 1]?.steps ?? null;
      // 目标视口：预演用开始时选的尺寸；演播沿用这张卡预演时记下的尺寸。legacy：旧的按坐标录的记录，要整段重写
      const ops = parseOps(out.script.text);
      // 预演一开始就清空操作记录，worker 从头写；上一版留在 git 里，预演没跑完时还原（见 settleOps）
      if (out.script.mode === 'rehearsal' && result.kind === 'demo' && !result.task.opsCleared && !out.script.error) {
        out.script.text = clearOps(out.script.text);
        writeFileSync(join(root, result.task.script), out.script.text);
        store.markOpsCleared(result.task.id, true);
        out.script.hasOps = false;
        out.script.cleared = true;
        out.script.oldViewport = ops.viewport;
      }
      const fallback = store.config().demoViewport;
      out.script.viewport = out.script.mode === 'rehearsal' ? (runs[runs.length - 1]?.viewport ?? fallback) : (ops.viewport ?? fallback);
      out.script.legacy = ops.legacy;
    }
    return out;
  }

  // 无 leader 模式。自动进入（设置里打开时）：leader 超过设置的分钟数既没挂着 watch、也没用命令行
  // （服务刚启动从启动时算起）。token 用完后后台的 watch --follow 还会挂到 Monitor 到期（最多半小时），这段算容错。
  // 退出：自动进入的，leader 重新挂上 watch 或执行命令就退出；用户手动宣布下线的，只认 leader 执行 watch 以外的命令
  // （token 用完的 leader 后台 watch 还在重连，不能让它把用户的宣布顶掉）。状态存在 store 里，重启后保留到 leader 真回来
  const serverStart = Date.now();
  let leaderActedAt = null;
  let lastWatchEnd = 0;
  function checkLeader() {
    const t = Date.now();
    const away = store.state.noLeader;
    if (away) {
      const acted = leaderActedAt !== null && leaderActedAt >= away.since;
      if (acted || (away.by !== 'user' && watchers.size > 0)) store.setLeaderAway(false);
      return;
    }
    if (!store.config().autoNoLeader || watchers.size > 0) return;
    if (t - Math.max(serverStart, leaderSeenAt ?? 0, lastWatchEnd) > store.config().leaderAwayMin * 60000) store.setLeaderAway(true);
  }

  const spawnTimes = []; // 最近启动 worker 的时间，算上还没加入的
  const SPAWN_JOIN_MS = 2 * 60 * 1000;
  let doctor = null; // 自检结果：启动后在后台跑一次，看板打开「待处理」、点「修复」时重跑
  async function recheck() {
    doctor = await runDoctor({ root, install: installInfo(), multi: layout.mode === 'multi', testBrowser: store.config().testBrowser });
    pushSoon();
  }
  // ego-browser 测试用 profile：名称以 ateam 开头的（不含默认 profile）自动启用。ego 没有新建 profile 的接口，
  // 用户在 ego lite 里新建，看板「刷新」或过 5 分钟后重新读取。只在「测试用的浏览器」选了 ego-browser 时读
  const EGO_PROFILE_TTL = 5 * 60 * 1000;
  let egoProfiles = { list: [], at: 0, error: null };
  let egoLoading = null;
  function refreshEgoProfiles() {
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
  function egoProfileList() {
    if (store.config().testBrowser !== 'ego') return [];
    if (Date.now() - egoProfiles.at > EGO_PROFILE_TTL) refreshEgoProfiles().catch(() => {});
    return egoProfiles.list;
  }

  // ---------- 升级（只有安装版查，见 update.js）----------
  const UPDATE_EVERY = 6 * 60 * 60 * 1000;
  const updateInfo = { current: ateamVersion(), latest: null, newer: false, releases: [], checkedAt: 0, error: null };
  let updateJob = null; // 正在下载安装的版本：{ version, received, total, status: downloading|opened|failed, error }
  async function checkUpdate() {
    if (runMode() !== 'installed') return;
    Object.assign(updateInfo, await checkRelease());
    pushSoon();
  }
  function updateSummary() {
    const { releases, ...rest } = updateInfo;
    const m = runMode();
    return { ...rest, mode: m, modeLabel: modeLabel(m), devRepo: m === 'dev' ? devRepo() : null, job: updateJob };
  }
  function startUpdate(wanted) {
    if (runMode() !== 'installed') throw new AteamError('INVALID', runMode() === 'dev' ? '当前是开发模式，代码来自源码仓库，不通过安装包更新。' : '当前不是安装版，请下载安装包安装。');
    if (updateJob?.status === 'downloading') throw new AteamError('BAD_STATE', `正在下载 ${updateJob.version}，请稍候。`);
    updateJob = { version: wanted ?? updateInfo.latest, received: 0, total: 0, status: 'downloading', error: null };
    let last = 0;
    installRelease(wanted, ({ received, total }) => {
      Object.assign(updateJob, { received, total });
      if (Date.now() - last > 500) { last = Date.now(); pushSoon(); }
    }).then((r) => { Object.assign(updateJob, { version: r.version, status: 'opened' }); pushSoon(); },
      (err) => { Object.assign(updateJob, { status: 'failed', error: err.message }); pushSoon(); });
    pushSoon();
    return { started: true };
  }

  // ---------- 停止 / 重启（菜单栏程序和看板「重启」按钮用，只限本机）----------
  let stopping = false;
  function stopServer(restart) {
    if (stopping) return;
    stopping = true;
    saveState(dataDir, store.state);
    // 停止（不是重启）时先告诉同事「已停止」，最多等 5 秒
    (restart ? Promise.resolve() : syncFinal()).finally(() => { server.close(() => {
      if (restart) {
        // 原来的启动参数，端口固定为当前端口；输出写到 .ateam/serve.log，在后台运行
        const args = [];
        for (let i = 0; i < argv.length; i++) {
          if (argv[i] === '--port') { i++; continue; }
          if (String(argv[i]).startsWith('--port=')) continue;
          args.push(argv[i]);
        }
        // 装了安装包：用 /usr/local/bin/ateam 启动（它按开发模式 / 安装版选代码，切换模式后重启也跟着走）。
        // 否则用当前程序的真实路径：argv[1] 可能是 npm link 的软链，装安装包时会被删掉
        const logFile = join(dataDir, 'serve.log');
        let script = process.argv[1];
        try { script = realpathSync(script); } catch {}
        // Windows：ateam.cmd 不能直接 spawn（要经过 cmd），也不需要：按启动脚本的规则（开发模式用仓库、否则用安装目录）选好代码，用同一个 node 跑
        if (WIN && installed()) script = join(devRepo() ?? APP_DIR, 'bin', 'ateam.js');
        const [cmd, ...pre] = !WIN && existsSync(WRAPPER) ? [WRAPPER] : [process.execPath, script];
        const all = [...pre, ...args, '--port', String(port)];
        let child;
        if (WIN) {
          // 托盘经「cmd /c ... >> serve.log」启动的服务：那个 cmd 一直占着 serve.log，直到本进程退出，这里打开会 EBUSY。
          // 所以也经 cmd 启动新服务，先等两秒（本进程和旧 cmd 退出、放开文件）再打开日志
          const quoted = [cmd, ...all].map((a) => `"${a}"`).join(' ');
          child = spawn('cmd.exe', ['/d', '/s', '/c', `"ping -n 3 127.0.0.1 >nul & ${quoted} >> "${logFile}" 2>&1"`],
            { cwd: root, detached: true, stdio: 'ignore', env: process.env, windowsHide: true, windowsVerbatimArguments: true });
        } else {
          // 打不开日志也照样重启，输出丢掉而已，不能让服务就此停掉
          let log = 'ignore';
          try { log = openSync(logFile, 'a'); } catch {}
          child = spawn(cmd, all, { cwd: root, detached: true, stdio: ['ignore', log, log], env: process.env });
        }
        child.unref();
        console.log(`\nateam 服务已在后台重启（进程 ${child.pid}），输出写到 ${join(dataDir, 'serve.log')}。`);
      } else {
        console.log('\nateam 服务已停止。');
      }
      process.exit(0);
    });
    server.closeAllConnections?.();
    });
  }

  // 菜单栏「启动 worker」可选的角色：标准角色 + 未完成的卡和在线 worker 用到的角色；缺人的标出来（与看板「worker」页一致）
  const STANDARD_ROLES = [['product', '产品'], ['frontend', '前端'], ['backend', '后端'], ['test', '测试'], ['critic', '审卡']];
  function spawnRoles() {
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

  // 待你处理的事，与看板「待处理」（dashboard.html 的 attentionItems）同一套规则。hash 是看板地址的 #需求/卡号，菜单栏点了直达
  let lanUrls = [];
  // act：菜单栏通知上可以直接点的操作（验收、启动 worker、收回任务、重启服务），没有就只能打开看板
  function attention() {
    const st = store.state;
    const taskOf = (id) => st.tasks.find((t) => t.id === id);
    const items = [];
    for (const j of st.jobs.slice().reverse()) {
      if (j.status === 'awaiting_acceptance') items.push({ key: `accept:${j.id}`, text: `${j.id} 待验收：${j.title}`, hash: j.id, act: { type: 'accept', job: j.id } });
    }
    if (!store.demoFrozen()) {
      for (const n of store.staffingNeeds().needs) {
        const t = taskOf(n.tasks[0]);
        items.push({ key: `needs:${n.role.toLowerCase()}`, text: `${n.role} 缺少 worker（${n.tasks.join('、')}）`, hash: t ? `${t.jobId}/${t.id}` : '', act: { type: 'spawn', role: n.role } });
      }
    }
    if (staleWhy()) items.push({ key: 'stale', text: staleWhy() === 'code' ? '服务需要重启' : '已切换运行模式，服务需要重启', hash: '', act: { type: 'restart' } });
    for (const t of st.tasks) {
      if ((t.critiques || []).some((c) => c.status === 'proposed' || c.status === 'disputed')) items.push({ key: `dispute:${t.id}`, text: `${t.id} 审卡分歧待决定`, hash: `${t.jobId}/${t.id}` });
    }
    for (const t of st.tasks) {
      if (!t.assignTo || (t.status !== 'pending' && t.status !== 'held')) continue;
      const a = st.agents.find((x) => x.id === t.assignTo);
      if (!a || a.status !== 'online') items.push({ key: `assign:${t.id}`, text: `${t.id} 指派的 ${t.assignTo} 不在线`, hash: `${t.jobId}/${t.id}` });
    }
    for (const a of st.agents) {
      if (a.status !== 'online') continue;
      const cancelled = a.cancelNotice?.wasWorking ? taskOf(a.cancelNotice.taskId) : null;
      if (cancelled) items.push({ key: `cancel:${a.id}:${cancelled.id}`, text: `${a.id} 仍在处理已作废的 ${cancelled.id}`, hash: `${cancelled.jobId}/${cancelled.id}` });
      const t = a.stale && a.currentTask ? taskOf(a.currentTask) : null;
      if (t) items.push({ key: `quiet:${a.id}`, text: `${a.id} 无响应（${t.id}）`, hash: `${t.jobId}/${t.id}`, act: { type: 'reclaim', task: t.id, agent: a.id } });
    }
    for (const c of (doctor ?? []).filter((x) => !x.ok)) items.push({ key: `doctor:${c.key}`, text: `自检：${c.title}有问题`, hash: '' });
    for (const it of codeAttention()) items.push(it);
    const busy = st.jobs.some((j) => !j.demo && (j.status === 'planning' || j.status === 'active'));
    if (busy && (st.noLeader || !leaderOnline())) items.push({ key: 'leader', text: st.noLeader ? '无 leader 模式' : 'leader 未连接', hash: '' });
    return items;
  }

  // 多人协作时代码分支的提醒（看板 attentionItems 里有同一套）：
  // 有提交超过 30 分钟没推送（同事拿不到）、落后远程超过 10 分钟没拉取、自动推送 / 拉取失败
  function codeAttention() {
    const c = syncCfg.enabled ? syncState.code : null;
    if (!c || c.detached || c.noUpstream) return [];
    const out = [];
    const now = Date.now();
    if (c.error) out.push({ key: 'code:error', text: c.error, hash: '' });
    if (c.ahead > 0 && c.aheadSince && now - c.aheadSince >= 30 * 60 * 1000) out.push({ key: 'code:ahead', text: `本地 ${c.branch} 有 ${c.ahead} 个提交未推送`, hash: '' });
    if (c.behind > 0 && c.behindSince && now - c.behindSince >= 10 * 60 * 1000) out.push({ key: 'code:behind', text: `本地 ${c.branch} 落后远程 ${c.behind} 个提交`, hash: '' });
    return out;
  }

  // ---------- 推送到手机（push.js）----------
  // 与菜单栏通知同一规则：待处理清单里新出现、持续 1 分钟的事推一次；服务启动时已有的不推；事情消失后再出现会再推
  const PUSH_SETTLE_MS = 60 * 1000;
  const pushFirstSeen = new Map();
  const pushDone = new Set();
  let pushBaselined = false;
  const lanLink = (hash = '') => (lanUrls[0] ? `${lanUrls[0]}/${hash ? `#${hash}` : ''}` : '');
  // ---------- token 用量（DeepSeek Harness 的会话记录，见 usage.js、usage-report.js）----------
  // 明细要解压会话记录，30 秒内复用上一次的结果（解压结果按文件缓存，会话没变就不再解）
  let usageCache = null;
  let usageRunning = null;
  // 按天存档：.ateam/usage-daily.json。过去的日子算好后封存，会话记录（DeepSeek Harness 手动删除、Claude Code 默认 30 天清理）被删也不丢
  const historyFile = join(dataDir, 'usage-daily.json');
  let usageHistory = { days: {} };
  try { const h = JSON.parse(readFileSync(historyFile, 'utf8')); if (h?.days && typeof h.days === 'object') usageHistory = h; } catch {}
  function sealDays(seal) {
    if (!seal || !Object.keys(seal).length) return;
    usageHistory = { days: { ...usageHistory.days, ...seal } };
    try { writeFileSync(historyFile, `${JSON.stringify(usageHistory)}\n`); } catch {}
  }
  async function usageReport(fresh = false) {
    if (!fresh && usageCache && Date.now() - usageCache.generatedAt < 30000) return usageCache;
    // 同时来的几个请求共用一次计算
    usageRunning ??= (async () => {
      try {
        const collected = await collectUsage({ root, segments: store.agentSegments(), bound: store.boundSessions() });
        usageCache = buildReport({ state: store.state, collected, history: usageHistory });
        sealDays(usageCache.seal);
        usageCache.collected = collected; // 只看某个需求时用同一份明细重算
        return usageCache;
      } finally { usageRunning = null; }
    })();
    return usageRunning;
  }
  // 卡详情的「Token」：已通过的卡用记在卡上的数，其他卡现算（进行中的卡随 worker 干活增长）。
  // 返回 { input, cacheRead, output, calls, live, heavy }；没人做过 { none }；本机没有会话记录 { unavailable }
  async function tokensOf(task) {
    const r = await usageReport();
    const heavy = r.heavyOf(task.id);
    const done = task.status === 'approved' || task.status === 'cancelled';
    // perTask 已经取了现算和卡上快照中较大的那个
    const u = r.perTask.get(task.id);
    if (u) return { input: u.input, cacheRead: u.cacheRead, output: u.output, calls: u.calls, live: !done, heavy };
    const segs = [...store.agentSegments()].filter(([, list]) => list.some((x) => x.task === task.id));
    if (!segs.length) return { none: true };
    // 做这张卡的 worker 有会话记录（只是这张卡还没调用过模型）记 0；都没有（WorkBuddy 等）算没有数据
    if (segs.some(([agentId]) => r.agentsSeen.has(agentId))) return { input: 0, cacheRead: 0, output: 0, calls: 0, live: !done, heavy: null };
    return { unavailable: true };
  }
  // 卡的快照：提交、交接、下线放下、通过、作废时把当时的用量记到卡上（取和已记的较大值，只增不减），
  // 之后 worker 下线、编号让给别人、会话记录被删，都不影响查看。只记 7 天内有这些动作的卡：更早的卡会话多半已不在，
  // 不往已归档的需求文件里写空值（它们提交在项目的 git 里）
  const SNAPSHOT_WINDOW = 7 * 24 * 60 * 60 * 1000;
  const SNAP_MARKS = new Set(['submitted', 'handoff', 'parked', 'approved', 'cancelled']);
  const snapMark = (t) => [...t.history].reverse().find((h) => SNAP_MARKS.has(h.type))?.ts ?? 0;
  const snapTried = new Map(); // 卡 → 已经看过的那个时间点：没有用量的卡（WorkBuddy 等）不每分钟重算一遍
  async function snapshotTokens() {
    const due = () => store.state.tasks.filter((t) => {
      const m = snapMark(t);
      return m && Date.now() - m < SNAPSHOT_WINDOW && m > (t.tokens ? (t.tokens.at ?? Infinity) : 0) && snapTried.get(t.id) !== m;
    });
    if (!due().length) return;
    const r = await usageReport(true);
    for (const t of due()) {
      const m = snapMark(t);
      snapTried.set(t.id, m);
      const u = r.perTask.get(t.id);
      if (u && totalOf(u)) store.setTaskTokens(t.id, { input: u.input, cacheRead: u.cacheRead, output: u.output, calls: u.calls, at: m });
    }
  }

  // ---------- worker 换新会话 ----------
  // 同一个会话连做几张卡，前面的对话一直留在上下文里，后面每次调用都要重读，越做越贵。
  // 按会话记录看在线 worker 最近一次调用读入了多少（输入 + 缓存命中），超过设置就打标记：手上的卡通过后不再领新卡、下线，
  // 服务马上开一个同角色的新 worker 接着领（rotateSpawn）。WorkBuddy 没有本机记录，不换
  async function checkRotate() {
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
  function rotateSpawn(role, oldId, ctx) {
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

  // ---------- 多人协作：看板同步到 git 远程的 ateam/<名字> 分支（sync.js）----------
  // 看板保存后 30 秒推一次（没变化不推，10 分钟一次心跳），每分钟拉一次同事的看板，同事进行中的卡交给 store 参与派卡冲突检查
  let syncCfg = readSyncConfig(root);
  const syncProject = (() => { try { return realpathSync(root); } catch { return root; } })(); // 认「是不是同一份看板」用：电脑名 + 项目目录
  const syncCache = new Map();
  const syncState = { pushedAt: null, fetchedAt: null, error: null, unpushed: false, peers: [], code: null };
  const PEER_ONLINE_MS = 15 * 60 * 1000; // 心跳 10 分钟一次：超过 15 分钟没同步算离线
  let syncBusy = false;
  let syncTimer = null;
  const syncTop = (cfg = syncCfg) => (layout.mode === 'single' ? layout.top : join(root, layout.repos.includes(cfg.repo) ? cfg.repo : layout.repos[0]));
  const syncRel = () => (layout.mode === 'single' ? relative(layout.top, dataDir).split(sep).join('/') : null);
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
  function codeView() {
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
    if (!waking && !wakeScheduled) { wakeScheduled = true; setImmediate(wake); }
    pushSoon();
  }
  async function syncTick() {
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
  async function syncFinal() {
    if (!syncCfg.enabled || !syncCfg.name) return;
    await Promise.race([syncPush(false).catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  }
  function syncSoon() {
    if (!syncCfg.enabled || syncTimer) return;
    syncTimer = setTimeout(() => { syncTimer = null; syncTick().catch(() => {}); }, 30000);
    syncTimer.unref?.();
  }
  // 目录归属：.ateam/owners.md，一行一条「路径 名字…」（名字是同步名称），# 开头是注释。随代码提交，大家共用。
  // 建卡、改卡时路径落在别人负责的目录里就提醒 leader（只提醒，不拦）
  const ownersFile = join(dataDir, 'owners.md');
  function readOwners() {
    try { return readFileSync(ownersFile, 'utf8'); } catch { return ''; }
  }
  function parseOwners(text) {
    const out = [];
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) continue;
      const [path, ...rest] = line.split(/\s+/);
      const names = rest.join(' ').split(/[\s,，、]+/).map((n) => n.replace(/^@/, '').trim()).filter(Boolean);
      if (path && names.length) out.push({ path: path.replace(/^\.\//, '') || '.', names });
    }
    return out;
  }
  const normP = (p) => { const x = String(p).trim().replace(/^\.\//, '').replace(/\/+$/, ''); return x === '.' ? '' : x; };
  const crosses = (a, b) => { a = normP(a); b = normP(b); return !a || !b || a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`); };
  // 卡的路径落在别人负责的目录里：[{ path: 归属目录, names }]（自己负责的、和自己同时负责的不算）
  function ownersFor(paths) {
    const me = syncCfg.name;
    return parseOwners(readOwners()).filter((o) => !(me && o.names.includes(me)) && (paths ?? []).some((p) => crosses(p, o.path)));
  }

  // 自动开启：这台电脑没对这个项目做过选择（开启、关闭都没有），而仓库里的 .ateam/.gitignore 有迁移提交写的说明行
  // （同事已经让这个项目改用看板同步，拉代码时带过来了），就用 git 用户名开启。名字被占用之类的问题不再重试，到设置里手动处理
  let syncAutoError = null;
  let syncAutoGaveUp = false;
  async function syncAuto() {
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
  async function syncStatus() {
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
  async function syncConfigure(b) {
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

  async function checkPush() {
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

  // ---------- 定时小结（digest.js），设置在 push.json，与推送共用渠道 ----------
  async function digestMessage(kind) {
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

  const store = createStore({ state: loadState(dataDir) ?? undefined, leaseMs, idleMs: idleMin * 60 * 1000, onChange, onRotate: rotateSpawn });
  // 启动时按当前版本的文件布局写一遍（新加的拆分方式马上生效，不用等第一次状态变化；内容没变的文件不会重写）
  saveState(dataDir, store.state);

  // 每次状态变化：落盘，并在下一轮事件循环唤醒挂起的请求。
  // 唤醒过程本身（nextFor 的 touch、takeEvents）也会触发 onChange，用 waking 标记避免循环。
  // 看板的推送连接（SSE）。浏览器会暂停后台标签页的定时器，看板的 3 秒轮询在后台可能不跑，
  // 标签页标题上的提醒就不更新；网络推送来的消息在后台照样会处理，收到后看板立即刷新一次。
  const streams = new Set();
  function pushAll(msg) {
    for (const res of streams) res.write(`data: ${msg}\n\n`);
  }
  // leader 在线与否、心跳时间这类随时间变化的状态没有对应的 onChange，定时推一下
  const streamTimer = setInterval(() => pushAll('tick'), 15000);
  streamTimer.unref();

  // 状态变化很频繁（每次心跳都算），合并成最多每秒推一次
  let pushTimer = null;
  function pushSoon() {
    if (pushTimer || streams.size === 0) return;
    pushTimer = setTimeout(() => { pushTimer = null; pushAll('change'); }, 1000);
  }

  function onChange() {
    saveState(dataDir, store.state);
    pushSoon();
    syncSoon();
    if (waking || wakeScheduled) return;
    wakeScheduled = true;
    setImmediate(wake);
  }

  function wake() {
    wakeScheduled = false;
    waking = true;
    try {
      for (const [agentId, waiter] of [...waiters]) {
        try {
          const result = store.nextFor(agentId);
          if (result) finishWaiter(agentId, waiter, 200, { ok: true, result: withRules(result, agentId) });
        } catch (err) {
          finishWaiter(agentId, waiter, err instanceof AteamError ? 400 : 500,
            { ok: false, code: err.code ?? 'INTERNAL', message: err.message });
        }
      }
      if (watchers.size > 0) {
        const events = store.takeEvents();
        if (events.length > 0) {
          for (const watcher of [...watchers]) finishWatcher(watcher, { ok: true, events });
        }
      }
    } finally {
      waking = false;
    }
  }

  function finishWaiter(agentId, waiter, status, body) {
    clearTimeout(waiter.timer);
    if (waiters.get(agentId) === waiter) waiters.delete(agentId);
    send(waiter.res, status, body);
  }

  function finishWatcher(watcher, body) {
    clearTimeout(watcher.timer);
    watchers.delete(watcher);
    lastWatchEnd = Date.now();
    send(watcher.res, 200, body);
  }

  // git 操作串行执行，两个 worker 的提交排队，不会交错
  let gitQueue = Promise.resolve();
  function serial(fn) {
    const run = gitQueue.then(fn, fn);
    gitQueue = run.catch(() => {});
    return run;
  }

  function requireId(body) {
    if (typeof body.id !== 'string' || !body.id.trim()) throw new AteamError('INVALID', '缺少任务编号（例如 T3）。');
    return body.id.trim();
  }

  // 提词悬浮窗进程（osascript）；服务退出时一起关掉
  let prompterProc = null;
  process.on('exit', () => prompterProc?.kill());
  // Ctrl+C、kill：和「停止」按钮一样正常停止（保存状态，开着看板同步时告诉同事已停止）
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => stopServer(false));

  // 普通路由：返回 JSON 对象（自动加 ok:true）
  const routes = {
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
    'POST /api/ask': (b) => ({ task: store.ask(b.as, b.text) }),
    'POST /api/submit': (b) => serial(async () => {
      const task = store.taskForSubmit(b.as);
      if (typeof b.summary !== 'string' || !b.summary.trim()) {
        throw new AteamError('INVALID', '提交总结不能为空。请写明做了什么、怎么验证的。');
      }
      let commits = null;
      if (!b.noChanges) {
        const result = await commitPaths(root, task.paths, `[${task.id}] ${b.summary.trim()}`);
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
      return { task: store.recordSubmit(b.as, b.summary, commits), commit: commits ? commits.join('、') : null };
    }),
    'POST /api/jobs': (b) => ({ job: store.createJob({ title: b.title, description: b.description, origin: b.origin, demo: !!b.demo }) }),
    'POST /api/demo/add': (b) => {
      if (typeof b.script !== 'string' || !b.script.trim()) throw new AteamError('INVALID', '缺少脚本路径（--script），比如 docs/demo/protocol-adapter.md。');
      const script = relative(root, resolve(root, b.script.trim())).split(sep).join('/');
      if (!script || script.startsWith('..')) throw new AteamError('INVALID', `脚本路径 ${b.script} 不在项目目录（${root}）里。`);
      if (!existsSync(join(root, script))) throw new AteamError('INVALID', `脚本文件 ${script} 不存在，请先按演播脚本格式写好并提交，再建演播卡。`);
      return { task: store.addDemo({ jobId: b.jobId, title: b.title, script, role: b.role }) };
    },
    // steps：演播只演这几步。总步数从脚本读，读不到就交给 store 拒绝
    'POST /api/demo/start': async (b) => {
      if (WIN) throw new AteamError('INVALID', 'Windows 版暂不支持预演和演播，请在 Mac 上运行 ateam 演播这张卡。');
      const id = requireId(b);
      await settleOps();
      let total = null;
      let text = null;
      try { text = readFileSync(join(root, store.getTask(id).script), 'utf8'); } catch {}
      if (b.steps != null && text != null) total = stepCount(text);
      // 旧的按坐标录的操作记录不能直接演播，要先按新格式重新预演
      if ((b.mode ?? 'show') === 'show' && text != null && parseOps(text).legacy) {
        throw new AteamError('BAD_STATE', `${id} 的操作记录是旧格式（按坐标录的），请先重新预演一次。`);
      }
      return { task: store.startDemo(id, b.mode ?? 'show', b.steps ?? null, total, b.viewport ?? null) };
    },
    'GET /api/task-tokens': async (_b, url) => ({ tokens: await tokensOf(store.getTask(url.searchParams.get('id') ?? '')) }),
    'GET /api/usage': async (_b, url) => {
      const all = await usageReport(url.searchParams.get('fresh') === '1');
      const jobId = url.searchParams.get('job');
      if (jobId) store.getJob(jobId); // 没有这个需求时报错
      const r = jobId ? buildReport({ state: store.state, collected: all.collected, jobId, history: usageHistory }) : all;
      const { perTask, heavyOf, agentsSeen, collected, seal, ...report } = r;
      return { usage: report };
    },
    'GET /api/demo/ops': async (_b, url) => {
      await settleOps();
      const task = store.getTask(url.searchParams.get('id') ?? '');
      if (task.kind !== 'demo') throw new AteamError('INVALID', `任务 ${task.id} 不是演播卡。`);
      // ops：worker 写的操作记录；steps：脚本的步骤列表（编号、做什么、讲解），看板右栏的步骤大纲用
      try {
        const text = readFileSync(join(root, task.script), 'utf8');
        const parsed = parseOps(text);
        // recorded：动作块和预期都录好了的步骤号，看板标「已录」；legacy：旧的按坐标录的记录
        return { ops: opsSection(text), steps: parseSteps(text), viewport: parsed.viewport, legacy: parsed.legacy, recorded: [...parsed.steps].filter(([, v]) => !v.problem).map(([n]) => n) };
      } catch (err) {
        return { ops: '', steps: [], error: `读不到脚本文件 ${task.script}：${err.message}` };
      }
    },
    'POST /api/demo/stop': async (b) => { const task = store.stopDemo(requireId(b)); await settleOps(); return { task }; },
    'POST /api/demo/release': async (b) => { const task = store.releaseDemo(requireId(b)); await settleOps(); return { task }; },
    // 提词悬浮窗（只有 macOS）：服务替看板起一个系统窗口，没有浏览器边框、浮在最上层。
    // 同一时间只留一个；再点就关掉旧的重开（跳到最前）。其他系统返回错误，看板改用普通弹窗
    'POST /api/prompter/open': () => {
      if (process.platform !== 'darwin') throw new AteamError('INVALID', '提词悬浮窗只支持 macOS');
      prompterProc?.kill();
      const proc = spawn('osascript', ['-l', 'JavaScript', PROMPTER_JXA, `http://127.0.0.1:${server.address().port}/?prompter&native`], { stdio: 'ignore' });
      proc.on('exit', () => { if (prompterProc === proc) prompterProc = null; });
      proc.on('error', () => { if (prompterProc === proc) prompterProc = null; });
      prompterProc = proc;
      return {};
    },
    'POST /api/prompter/close': () => { prompterProc?.kill(); prompterProc = null; return {}; },
    // 用户在看板上宣布 leader 下线（进入无 leader 模式）或恢复
    'POST /api/leader/away': (b) => ({ away: store.setLeaderAway(!!b.on, 'user') }),
    'POST /api/demo/pause': (b) => ({ task: store.pauseDemo(requireId(b)) }),
    'POST /api/demo/resume': (b) => ({ task: store.resumeDemo(requireId(b)) }),
    'POST /api/demo/end': (b) => {
      // 预演跑完：每一步都要录好动作块，才算预演完成
      const held = store.state.agents.find((a) => a.id === b.as)?.currentTask;
      const task = held && store.state.tasks.find((t) => t.id === held && t.kind === 'demo');
      const run = task?.runs?.[task.runs.length - 1];
      if (task && run?.mode === 'rehearsal' && !b.stuck && task.status === 'demoing' && !task.stopRequested) {
        let text = '';
        try { text = readFileSync(join(root, task.script), 'utf8'); } catch {}
        const problems = checkOps(text, { all: true });
        const vp = parseOps(text).viewport;
        if (run.viewport && vp && vp !== run.viewport) problems.unshift(`开头的视口写的是 ${vp}，这次预演选的是 ${run.viewport}：要在 ${run.viewport} 下走通，并把这一行改成「视口：${run.viewport}」`);
        if (problems.length) throw new AteamError('INVALID', `预演还不能算跑完，「## 操作记录」没录全：\n${problems.map((p) => `- ${p}`).join('\n')}\n\n把这些补上（开头「视口：宽x高」；每步「### N.」条目、\`\`\`actions 动作块和「预期：」行），再运行 ateam demo end。实在走不通的步骤用 --stuck 结束。`);
      }
      return { task: store.demoEnd(b.as, b.result, !!b.stuck) };
    },
    'POST /api/demo/save': (b) => serial(async () => {
      const task = store.demoTaskForSave(b.as);
      if (typeof b.summary !== 'string' || !b.summary.trim()) throw new AteamError('INVALID', '总结不能为空。写明这次记了或改了哪些操作；操作记录没有改动就加 --no-changes。');
      let current;
      try { current = readFileSync(join(root, task.script), 'utf8'); } catch {
        throw new AteamError('INVALID', `读不到脚本文件 ${task.script}。不要删除或移动它；恢复后再 demo save。`);
      }
      const head = await headContent(root, task.script);
      if (head === null) throw new AteamError('INVALID', `脚本文件 ${task.script} 还没有提交过，请通知用户让 leader 先提交脚本。`);
      const run = task.runs?.[task.runs.length - 1];
      // 预演没跑完：这次写的不提交，操作记录还原成上一版
      if (run?.mode === 'rehearsal' && run.outcome !== 'done') {
        writeFileSync(join(root, task.script), head);
        if (task.opsCleared) store.markOpsCleared(task.id, false);
        return { task: store.recordDemoSave(b.as, b.summary, null), commit: null, restored: true };
      }
      if (b.noChanges) {
        // 写了操作记录却加 --no-changes，记录会丢：拒绝
        if (current !== head) throw new AteamError('INVALID', `脚本 ${task.script} 有没提交的改动，不能加 --no-changes。去掉 --no-changes 重新运行，服务会提交它。`);
        if (task.opsCleared) store.markOpsCleared(task.id, false);
        return { task: store.recordDemoSave(b.as, b.summary, null), commit: null };
      }
      // 预演跑完的收尾：每步都要有合法动作块；其他情况只检查已写的动作块格式
      const problems = checkOps(current, { all: run?.mode === 'rehearsal' && run?.outcome === 'done' });
      if (problems.length) throw new AteamError('INVALID', `「## 操作记录」有问题，先改好再 demo save：\n${problems.map((p) => `- ${p}`).join('\n')}`);
      if (withoutOps(current) !== withoutOps(head)) {
        throw new AteamError('INVALID', `只能改脚本的「## 操作记录」段，其他段有改动。请把其他段恢复原样（git diff ${task.script} 查看）后再 demo save。`);
      }
      const result = await commitPaths(root, [task.script], `[${task.id}] 操作记录：${b.summary.trim()}`);
      if (result.nothing) throw new AteamError('INVALID', `脚本 ${task.script} 没有改动。操作记录没有改动就加 --no-changes。`);
      if (task.opsCleared) store.markOpsCleared(task.id, false);
      return { task: store.recordDemoSave(b.as, b.summary, result.commits), commit: result.commits.join('、') };
    }),
    'POST /api/jobs/edit': (b) => {
      const { jobId, ...patch } = b;
      return { job: store.editJob(jobId, patch) };
    },
    'POST /api/jobs/accept': (b) => ({ jobs: store.acceptJobs(b.ids) }),
    'POST /api/jobs/cancel': (b) => store.cancelJob(requireId(b), b.text ?? '', !!b.userApproved),
    'POST /api/tasks': (b) => {
      const task = store.addTask({
        jobId: b.jobId, title: b.title, role: b.role, paths: b.paths,
        description: b.description, acceptance: b.acceptance, dependsOn: b.dependsOn, top: !!b.top,
      });
      return { task, overlaps: store.overlapsFor(task), owners: ownersFor(task.paths) };
    },
    'POST /api/critique': (b) => ({ tasks: store.submitCritique(b.as, b.ids, b.verdict, b.text, b.because, b.basis) }),
    'POST /api/critique/handle': (b) => ({ task: store.handleCritique(requireId(b), b.action, b.text, b.basis) }),
    'POST /api/critique/rule': (b) => ({ task: store.ruleCritique(requireId(b), b.side, b.text) }),
    // 看板上的「安装」按钮：服务跑在用户的终端里，不受 agent 沙箱限制，可以直接改平台配置
    'POST /api/hook-install': async (b) => {
      const platform = b.platform === 'workbuddy' ? 'workbuddy' : 'dsh';
      const { installHook } = await import('./hook-install.js');
      try {
        return { message: installHook({ platform }) };
      } catch (err) {
        throw new AteamError('BAD_STATE', err.message);
      }
    },
    'GET /api/staffing': () => store.staffingNeeds(),
    'GET /api/sync': async () => ({ sync: await syncStatus() }),
    // 打开同步（看板开关、ateam sync init）时，同步成功且看板文件还在仓库里被跟踪，就顺带停止跟踪：只在当前分支提交这一处改动，不推送
    'POST /api/sync': async (b) => {
      const sync = await syncConfigure(b);
      if (b.enabled !== true || !sync.enabled || sync.error || !sync.tracked || !syncRel()) return { sync };
      try {
        const untrack = await untrackBoardFiles({ top: syncTop(), rel: syncRel(), dataDir, name: syncCfg.name });
        return { sync: await syncStatus(), untrack };
      } catch (err) {
        return { sync, untrackError: `停止在仓库中跟踪看板文件失败：${err.stderr ? explainGitError(err) : err.message}` };
      }
    },
    // 迁移：看板文件不再在仓库里跟踪（本地文件保留），只提交这一处改动。要先开启同步
    'GET /api/owners': () => ({ text: readOwners(), entries: parseOwners(readOwners()) }),
    'POST /api/owners': (b) => {
      const text = String(b.text ?? '');
      const tmp = `${ownersFile}.tmp`;
      writeFileSync(tmp, text.endsWith('\n') || !text ? text : `${text}\n`);
      renameSync(tmp, ownersFile);
      return { text: readOwners(), entries: parseOwners(readOwners()) };
    },
    'POST /api/sync/untrack': async () => {
      if (!syncCfg.enabled) throw new AteamError('INVALID', '请先开启看板同步（ateam sync init），确认已推送到 ateam 分支后再停止在仓库中跟踪看板文件。');
      if (!syncRel()) throw new AteamError('INVALID', '多仓库模式下 .ateam 不在任何仓库里，不需要这一步。');
      await syncTick();
      if (syncState.error) throw new AteamError('INVALID', `看板还没成功推送到 ateam 分支：${syncState.error}`);
      const out = await untrackBoardFiles({ top: syncTop(), rel: syncRel(), dataDir, name: syncCfg.name });
      return { untrack: out, sync: await syncStatus() };
    },
    'POST /api/spawn': async (b) => {
      const cfg = store.config();
      // 看板上的按钮是用户点的，不受限；leader 的命令要用户在设置里开了才行
      if (b.by !== 'user' && !cfg.leaderSpawn) {
        throw new AteamError('NEEDS_USER', '用户没有允许 leader 自动启动 worker（看板「设置 → 自动启动 worker」）。请告诉用户需要哪个角色的 worker，由用户开窗口或在看板上点「启动」。');
      }
      // 同时在线上限：刚启动、还没加入的也算上，免得 leader 连着开几个都没被拦住
      const max = cfg.maxWorkers;
      const now = Date.now();
      while (spawnTimes.length && now - spawnTimes[0] > SPAWN_JOIN_MS) spawnTimes.shift();
      const joined = store.state.agents.filter((a) => a.joinedAt && now - a.joinedAt <= SPAWN_JOIN_MS).map((a) => a.joinedAt).sort((x, y) => x - y);
      const pending = spawnTimes.filter((t) => { const i = joined.findIndex((j) => j >= t); if (i < 0) return true; joined.splice(i, 1); return false; }).length;
      const count = store.state.agents.filter((a) => a.status === 'online').length + pending;
      const over = max > 0 && count >= max;
      if (b.by !== 'user' && over) {
        throw new AteamError('NEEDS_USER', `在线 worker 已有 ${count} 个（含刚启动、还在加入的），达到用户设定的上限 ${max} 个，不能再自动启动。等别的 worker 空闲下线后再开；确实急需的话，告诉用户可以在看板「设置 → 同时在线 worker 上限」里调高。`);
      }
      const out = await spawnWorker({ root, role: b.role, name: b.name, platform: cfg.spawnPlatform });
      spawnTimes.push(Date.now());
      return { ...out, over, count: count + 1, max };
    },
    'POST /api/message': (b) => store.messageAgent(String(b.to ?? ''), b.text, b.by === 'user' ? 'user' : 'lead'),
    'POST /api/note': (b) => ({ task: store.noteTask(requireId(b), b.text) }),
    'GET /api/cards': (_b, url) => ({ cards: store.cards({ jobId: url.searchParams.get('job') ?? '', todo: url.searchParams.get('todo') === '1' }) }),
    'POST /api/tasks/assign': (b) => ({ task: store.assignTask(requireId(b), b.to) }),
    // by：看板传 user，命令行（leader）不传
    'POST /api/tasks/hold': (b) => ({ task: store.holdTask(requireId(b), !!b.on, b.text ?? '', b.by === 'user' ? 'user' : 'lead') }),
    'POST /api/jobs/hold': (b) => ({ job: store.holdJob(requireId(b), !!b.on, b.text ?? '', b.by === 'user' ? 'user' : 'lead') }),
    'POST /api/tasks/priority': (b) => ({ task: store.setPriority(requireId(b), !!b.top) }),
    'POST /api/tasks/edit': (b) => {
      const { id, ...patch } = b;
      const task = store.editTask(requireId({ id }), patch);
      // 只在改了路径或依赖时提醒
      return { task, overlaps: patch.paths !== undefined || patch.dependsOn !== undefined ? store.overlapsFor(task) : [], owners: patch.paths !== undefined ? ownersFor(task.paths) : [] };
    },
    'POST /api/approve': (b) => ({ task: store.approve(requireId(b), b.text ?? '') }),
    'POST /api/reject': (b) => ({ task: store.reject(requireId(b), b.text) }),
    'POST /api/prefs': (b) => { saveViewPref(root, b); return {}; },
    'POST /api/answer': (b) => ({ task: store.answer(requireId(b), b.text) }),
    'POST /api/reply': (b) => ({ task: store.userReply(requireId(b), b.text) }),
    'POST /api/release': (b) => ({ task: store.release(requireId(b)) }),
    'POST /api/cancel': (b) => ({ task: store.cancel(requireId(b), b.text ?? '') }),
    'POST /api/agents/hide': (b) => ({ hidden: store.hideAgents(b.ids) }),
    'POST /api/dismiss': (b) => {
      const dismissed = store.dismiss({ ids: b.ids, role: b.role, all: !!b.all, userApproved: !!b.userApproved, afterTask: !!b.afterTask });
      // 正挂在 wait 上的 worker 立即收到「已下线」（「做完再下线」的等任务结束后由 nextFor 处理）
      for (const { id, later } of dismissed) {
        if (later) continue;
        const waiter = waiters.get(id);
        if (waiter) finishWaiter(id, waiter, 200, { ok: true, result: { kind: 'dismissed' } });
      }
      return { dismissed };
    },
    'POST /api/agents/still-there': (b) => ({ agent: store.keepWaiting(String(b.id ?? '')) }),
    'POST /api/settings': (b) => {
      const settings = store.setSettings(b);
      // 换了测试浏览器：自检要查的东西跟着变
      if ('testBrowser' in b) {
        recheck().catch(() => {});
        if (settings.testBrowser === 'ego') refreshEgoProfiles().catch(() => {});
      }
      return { settings };
    },
    // 没改过、或重置了：返回自带模板，custom 为 false
    'GET /api/test-template': () => {
      const text = readTestTemplate();
      return { text: text.trim() ? text : DEFAULT_TEST_TEMPLATE, custom: !!text.trim(), default: DEFAULT_TEST_TEMPLATE };
    },
    'POST /api/test-template': (b) => {
      const text = writeTestTemplate(b.text);
      return { text: text.trim() ? text : DEFAULT_TEST_TEMPLATE, custom: !!text.trim(), default: DEFAULT_TEST_TEMPLATE };
    },
    'POST /api/agents/keep': (b) => ({ kept: store.keepAgents(b.ids) }),
    'POST /api/reclaim': (b) => {
      const { task, agentId } = store.reclaim(requireId(b), b.text ?? '');
      // 原 worker 若正挂在 wait 上，立即告诉它租约已失效
      const waiter = agentId && waiters.get(agentId);
      if (waiter) {
        finishWaiter(agentId, waiter, 400, { ok: false, code: 'LEASE_LOST', message: `你的租约已失效，任务已被收回。请重新运行 ateam join --role ${task.role} --id ${agentId}（沿用原编号）` });
      }
      return { task, agentId };
    },
    // 「安装」页用：本机 DeepSeek Harness 的 skill 目录和 profile、各项是否已经装好。都是现场读出来的，不写死
    'GET /api/install-info': () => installInfo(),
    // 菜单栏程序用的简要状态：待你处理的事（与看板的「待处理」一致）、在线 worker 和手上的卡、局域网只读地址
    'GET /api/summary': () => {
      const st = store.state;
      const items = attention();
      return {
        root, name: basename(root), version: ateamVersion(), mode: runMode(),
        workers: st.agents.filter((a) => a.status === 'online').length,
        working: st.tasks.filter((t) => ['working', 'asking', 'demoing', 'wrapping'].includes(t.status)).length,
        accept: st.jobs.filter((j) => j.status === 'awaiting_acceptance').length,
        attention: items.length,
        items,
        agents: st.agents.filter((a) => a.status === 'online').map((a) => {
          const t = a.currentTask ? st.tasks.find((x) => x.id === a.currentTask) : null;
          // 这次从什么时候开始做：最近一次领取、接手、开始演播或被打回
          const since = t ? [...t.history].reverse().find((h) => ['claimed', 'handoff', 'demo_started', 'rejected'].includes(h.type))?.ts ?? null : null;
          // 菜单栏的下线选项要用：已安排做完再下线、是不是这个角色唯一在线的（设置里开着「每个角色至少保留一个」时要提醒）
          const role = a.role.trim().toLowerCase();
          const last = store.config().keepOnePerRole !== false && !a.dismiss
            && st.agents.filter((x) => x.status === 'online' && !x.dismiss && x.role.trim().toLowerCase() === role).length === 1;
          return { id: a.id, name: a.name || null, role: a.role, stale: !!a.stale, dismiss: !!a.dismiss, last, task: t ? { id: t.id, title: t.title, status: t.status, hash: `${t.jobId}/${t.id}`, since } : null };
        }),
        lan: lanUrls,
        spawn: spawnRoles(),
        stale: !!staleWhy(),
        update: updateInfo.newer ? updateInfo.latest : null,
      };
    },
    // 推送到手机：配置（token、密钥只露末几位）、保存一个渠道、发测试消息
    'GET /api/push': () => ({ enabled: pushEnabled(), channels: maskedPush(), digest: readDigest(), prefs: readPrefs(), eventTypes: EVENT_TYPES, digestSections: DIGEST_SECTIONS }),
    // 推哪些事、什么格式
    'POST /api/push/prefs': (b) => {
      try { return { prefs: savePrefs({ events: b.events, format: b.format }) }; } catch (err) { throw new AteamError('INVALID', err.message); }
    },
    // 定时小结：kind = daily / weekly 改开关和时间，kind = sections 改段落
    'POST /api/push/digest': (b) => {
      try { return { digest: saveDigest(String(b.kind ?? ''), b) }; } catch (err) { throw new AteamError('INVALID', err.message); }
    },
    // 预览：按现在的数据和设置生成一份（不发）
    'GET /api/push/digest': async (_b, url) => {
      const kind = url.searchParams.get('kind') === 'weekly' ? 'weekly' : 'daily';
      return { preview: await digestMessage(kind) };
    },
    // 立即发一份到所有开启的渠道
    'POST /api/push/digest/send': async (b) => {
      const kind = b.kind === 'weekly' ? 'weekly' : 'daily';
      if (!anyPushOn()) throw new AteamError('INVALID', '请先打开推送总开关并开启至少一个渠道。');
      const m = await digestMessage(kind);
      if (!m) throw new AteamError('INVALID', '这段时间没有任何进展，没有可发送的内容。');
      const results = await sendPush(m);
      const bad = results.filter((r) => !r.ok);
      if (bad.length === results.length) throw new AteamError('INVALID', `发送失败：${bad.map((r) => r.error).join('；')}`);
      return { sent: results.filter((r) => r.ok).length, failed: bad };
    },
    // 只给 enabled：改总开关；给 channel：保存一个渠道
    'POST /api/push': (b) => {
      try {
        if (b.channel === undefined && 'enabled' in b) setPushEnabled(!!b.enabled);
        else savePush(String(b.channel ?? ''), { on: b.on, values: b.values ?? {} });
        return { enabled: pushEnabled(), channels: maskedPush() };
      } catch (err) { throw new AteamError('INVALID', err.message); }
    },
    'POST /api/push/test': async (b) => {
      let results;
      try {
        results = await sendPush({ title: `ateam · ${basename(root)}：推送测试`, lines: ['这是一条测试消息，收到说明推送配置正确。'], link: lanLink() }, String(b.channel ?? ''));
      } catch (err) { throw new AteamError('INVALID', err.message); }
      const r = results[0];
      if (!r.ok) throw new AteamError('INVALID', `发送失败：${r.error}`);
      return { sent: true };
    },
    'POST /api/shutdown': () => { setTimeout(() => stopServer(false), 200); return { stopping: true }; },
    'POST /api/restart': () => { setTimeout(() => stopServer(true), 200); return { restarting: true }; },
    // 版本页：带更新说明；fresh=1 立即查一次
    'GET /api/update': async (_b, url) => {
      if (url.searchParams.get('fresh') === '1') await checkUpdate();
      return { ...updateSummary(), releases: runMode() === 'installed' ? updateInfo.releases.slice(0, 10) : [] };
    },
    'POST /api/update/install': (b) => startUpdate(b.version ? String(b.version) : undefined),
    // 看板设置页的「刷新」：重新从 ego 读取测试用 profile
    'GET /api/ego-profiles': async (_b, url) => {
      if (url.searchParams.get('fresh') === '1') await refreshEgoProfiles();
      return egoProfiles;
    },
    // 自检：启动时跑过一次，fresh=1 重跑
    'GET /api/doctor': async (_b, url) => {
      if (url.searchParams.get('fresh') === '1' || !doctor) await recheck();
      return { checks: doctor };
    },
    // 看板「待处理」里自检项的「修复」：ignore 补 .ateam/.gitignore，cdp 给 DSH 写测试浏览器配置。修完重跑自检
    'POST /api/doctor/fix': async (b) => {
      let message;
      if (b.key === 'ignore') {
        ensureGitignore(root);
        message = '已补全 .ateam/.gitignore。';
      } else if (b.key === 'cdp') {
        const { configureCdp } = await import('./hook-install.js');
        try {
          message = configureCdp({ profile: b.profile || installInfo().profiles[0] });
        } catch (err) {
          throw new AteamError('BAD_STATE', err.message);
        }
      } else {
        throw new AteamError('INVALID', `自检项 ${b.key} 没有自动修复。`);
      }
      await recheck();
      return { message, checks: doctor };
    },
    'GET /api/rules': (_b, url) => {
      const rules = readRules();
      const role = url.searchParams.get('role');
      const roles = knownRoles();
      return { rules, lead: leadRules(rules).trim(), ...(role ? { forRole: rulesFor(rules, role) } : {}), unreceived: unreceived(rules, roles), needsTidy: needsTidy(rules), roles };
    },
    'POST /api/rules': (b) => ({ rules: approvedRules(b.text, !!b.userApproved, countsChange(readRules(), String(b.text ?? ''))) }),
    'POST /api/rules/add': (b) => {
      const line = String(b.text ?? '').trim();
      if (!line) throw new AteamError('INVALID', '规则不能为空。');
      const roles = Array.isArray(b.roles) ? b.roles.map(String).filter((r) => r.trim()) : [];
      const { text, section } = addRule(readRules(), line, roles);
      const rule = `- ${line.replace(/^[-*]\s+/, '')}`;
      return { rules: approvedRules(text, !!b.userApproved, `将在 ${section} 段加一条：${rule}。`), section };
    },
    'POST /api/report': (b) => ({ job: store.report(b.jobId, b.report) }),
    'GET /api/state': (_b, url) => ({
      // 看板不用事件列表（命令行 status 要用它数未读事件），?view=dashboard 时去掉，减小数据量
      state: url.searchParams.get('view') === 'dashboard' ? { ...store.state, events: [] } : store.state,
      pending: store.pendingActions(), root, toolDir: TOOL_DIR, home: homedir(), port, platform: process.platform, repos: layout.mode === 'multi' ? layout.repos : null,
      // 代码已更新、或切换了开发模式 / 安装版，但服务还没重启。staleWhy：code / dev / installed
      stale: !!staleWhy(),
      staleWhy: staleWhy(),
      // 版本、运行模式、有没有新版本、正在下载的更新
      update: updateSummary(),
      config: store.config(),
      // ego-browser 测试用 profile（只在选了 ego-browser 时有）
      egoProfiles: store.config().testBrowser === 'ego' ? egoProfiles : null,
      // 自检没过的项（看板顶部提示）
      doctor: (doctor ?? []).filter((c) => !c.ok),
      // 被别人正在改的同一批文件挡住、暂时不派的卡：{ 卡号: 挡着它的卡号 }
      clash: store.clashes(),
      // 其中挡着它的是同事已通过、但还没推送的卡（看板写「待 xx 推送」）
      clashPush: store.clashes(true),
      // 多人协作时本地代码分支和远程的差距（未开启同步时为 null）
      code: syncCfg.enabled ? codeView() : null,
      // 待演播的演播卡现在能不能开始、缺什么
      demoBlockers: Object.fromEntries(store.state.tasks.filter((t) => t.kind === 'demo' && t.status === 'ready').map((t) => [t.id, store.demoBlockers(t.id)])),
      // leader 在线：挂着 watch 监听，或 3 分钟内用命令行操作过
      leader: { watching: watchers.size > 0, lastSeenAt: leaderSeenAt, online: leaderOnline(), away: store.state.noLeader ?? null },
    }),
    // 带 review 摘要：这张卡所有提交改了哪些文件、各几行；新文件、超出任务路径的文件标出来
    'GET /api/task': async (_b, url) => {
      const task = store.getTask(url.searchParams.get('id') ?? '');
      if (url.searchParams.get('reader') === 'leader') store.leaderOpenedTask(task.id);
      if (!task.commits?.length || task.kind === 'demo') return { task };
      const lead = leadRules(readRules()).trim();
      const files = await commitStats(root, task.commits);
      const norm = (p) => String(p).trim().replace(/^\.\//, '').replace(/\/+$/, '');
      const inPaths = (f) => task.paths.map(norm).some((p) => p === '' || p === '.' || f === p || f.startsWith(`${p}/`));
      return { task, review: files.map((f) => ({ ...f, outside: !inPaths(f.file) })), ...(lead ? { leadRules: lead } : {}) };
    },
  };

  function handleWait(body, res) {
    const agentId = body.as;
    // 先结束同一 worker 的旧挂起，再派发：否则旧挂起可能在下一轮 wake 里再收到同一个任务
    const old = waiters.get(agentId);
    if (old) finishWaiter(agentId, old, 200, { ok: true, result: null, superseded: true, waiting: store.waitingInfo(agentId) });

    const result = store.nextFor(agentId); // 先 touch，掉线的 worker 在这里拿到 LEASE_LOST
    if (result) return send(res, 200, { ok: true, result: withRules(result, agentId) });

    const waiter = { res, timer: null };
    waiter.timer = setTimeout(() => {
      try {
        store.touch(agentId);
        waitRenewAt.set(agentId, Date.now());
        finishWaiter(agentId, waiter, 200, { ok: true, result: null, waiting: store.waitingInfo(agentId) });
      } catch (err) {
        finishWaiter(agentId, waiter, 400, { ok: false, code: err.code ?? 'INTERNAL', message: err.message });
      }
    }, holdMs(body.timeout));
    waiters.set(agentId, waiter);
    res.on('close', () => {
      if (waiters.get(agentId) === waiter) {
        clearTimeout(waiter.timer);
        waiters.delete(agentId);
      }
    });
  }

  // 报告演播的一步。暂停中：挂起这次请求，继续后放行（记下这一步）；挂满 timeout 还在暂停，
  // 回 paused，worker 原样再运行一次。叫停、中断等也在挂起期间放行，由 demoStep 给出结果
  function demoStepOnce(b) {
    // 从脚本里取这一步的讲解和下一步，给看板提词；读不到脚本就不提词，不影响演播
    let cue = null;
    const held = store.state.agents.find((a) => a.id === b.as)?.currentTask;
    const task = held && store.state.tasks.find((t) => t.id === held && t.kind === 'demo');
    if (task) {
      try {
        const steps = parseSteps(readFileSync(join(root, task.script), 'utf8'));
        const i = steps.findIndex((s) => s.n === Number(b.n));
        const step = i >= 0 ? steps[i] : null;
        cue = { narration: step?.narration ?? '', next: steps[i + 1]?.text ?? '' };
      } catch {}
    }
    return store.demoStep(b.as, b.n, b.total, b.text, cue, !!b.slow);
  }
  function handleDemoStep(body, res) {
    const first = demoStepOnce(body);
    if (!first.paused) return send(res, 200, { ok: true, ...first });
    const taskId = first.task.id;
    const deadline = Date.now() + holdMs(body.timeout);
    const timer = setInterval(() => {
      const t = store.state.tasks.find((x) => x.id === taskId);
      const still = t?.paused && t.status === 'demoing';
      if (still && Date.now() < deadline) return;
      clearInterval(timer);
      if (still) return send(res, 200, { ok: true, ...first, task: t });
      try { send(res, 200, { ok: true, ...demoStepOnce(body) }); } catch (err) { sendError(res, err); }
    }, 500);
    res.on('close', () => clearInterval(timer));
  }

  function handleWatch(body, res) {
    const events = store.takeEvents();
    if (events.length > 0) return send(res, 200, { ok: true, events });
    const watcher = { res, timer: null };
    watcher.timer = setTimeout(() => finishWatcher(watcher, { ok: true, events: [] }), holdMs(body.timeout));
    watchers.add(watcher);
    checkLeader(); // 自动进入的无 leader 模式：leader 重新挂上监听就退出
    res.on('close', () => {
      clearTimeout(watcher.timer);
      if (watchers.delete(watcher)) lastWatchEnd = Date.now();
    });
  }

  // 防止网页跨站调用接口：只认本机 Host（挡 DNS rebinding），POST 必须是 JSON（浏览器跨站发 JSON 需要预检，本服务不响应预检）。
  // 局域网模式下，不是从本机来的请求只读
  // 按当前端口算：自动换端口时 port 在监听成功后才定下来
  const allowedHost = (h) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '');

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const key = `${req.method} ${url.pathname}`;
    try {
      const local = isLoopback(req) && allowedHost(req.headers.host ?? '');
      if (!local) {
        if (!lan) {
          return send(res, 403, { ok: false, code: 'INVALID', message: `只接受 http://127.0.0.1:${port} 或 http://localhost:${port} 的请求。` });
        }
        // 别的电脑只读：只放行 GET（看板页面、状态、卡片详情、事件流），任何改动都拒绝
        // 命令行请求（会被当成 leader 在线）也只认本机；leader 已读标记不让远程看板顺带写
        if (req.method !== 'GET' || req.headers['x-ateam-cli']) {
          return send(res, 403, { ok: false, code: 'INVALID', message: '局域网访问是只读的，改动只能在运行 ateam 的那台电脑上操作。' });
        }
        url.searchParams.delete('reader');
      }
      if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
        return send(res, 415, { ok: false, code: 'INVALID', message: '请求的 Content-Type 必须是 application/json。请用 ateam 命令行操作。' });
      }
      if (key === 'GET /') {
        try {
          let html = await readFile(DASHBOARD, 'utf8');
          // 本机打开：把显示偏好写进页面，看板同步读到（换端口、换浏览器都在）。局域网只读访问不给，用那台电脑自己的浏览器
          if (local) {
            const prefs = JSON.stringify(viewPrefs(root)).replace(/</g, '\\u003c');
            html = html.replace('<script>', `<script>window.ATEAM_PREFS = ${prefs};</script>\n<script>`);
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('dashboard.html 不存在');
        }
        return;
      }
      const body = req.method === 'POST' ? await readBody(req) : {};
      // 命令行发来、且不带 --as 的请求都是 leader 的（worker 的命令都带 --as）
      if (req.headers['x-ateam-cli'] && !body.as && !req.headers['x-ateam-as'] && key !== 'POST /api/join') {
        leaderSeenAt = Date.now();
        if (key !== 'POST /api/watch') leaderActedAt = leaderSeenAt;
        checkLeader();
      }
      if (key === 'GET /api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write('retry: 3000\n\n');
        streams.add(res);
        res.on('close', () => streams.delete(res));
        return;
      }
      if (key === 'POST /api/wait') return handleWait(body, res);
      if (key === 'POST /api/watch') return handleWatch(body, res);
      if (key === 'POST /api/demo/step') return handleDemoStep(body, res);
      const route = routes[key];
      if (!route) throw new AteamError('NOT_FOUND', `未知接口：${key}`);
      const out = await route(body, url);
      if (key === 'GET /api/state') return sendCached(req, res, { ok: true, ...out });
      send(res, 200, { ok: true, ...out });
    } catch (err) {
      sendError(res, err);
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });

  // 租约扫描。判掉线之前，先看 worker 任务路径里有没有比上次心跳更新的文件改动：
  // 埋头写代码、很久没调用 ateam 命令的 worker，只要文件还在变，就不算掉线。
  let sweeping = false;
  async function sweepTick() {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const agent of store.state.agents) {
        if (agent.status !== 'online' || !agent.currentTask || waiters.has(agent.id)) continue;
        if (Date.now() - agent.lastSeenAt <= store.leaseMs) continue;
        const task = store.state.tasks.find((t) => t.id === agent.currentTask);
        if (!task || (task.status !== 'working' && task.status !== 'asking')) continue;
        const ts = await latestChangeTime(root, task.paths).catch(() => null);
        if (ts) store.noteActivity(agent.id, ts);
      }
      checkLeader();
      store.sweep((id) => waiters.has(id));
      store.expireDemoRequests();
      store.checkIdle({ leaderAway: !leaderOnline() || !!store.state.noLeader });
      store.checkStaffing();
    } finally {
      sweeping = false;
    }
  }
  // 租约在「设置」里可以改小，扫描间隔按最短 1 分钟的租约算
  const sweepTimer = setInterval(sweepTick, Math.min(20000, leaseMs / 3));
  sweepTimer.unref();
  server.on('close', () => {
    clearInterval(sweepTimer);
    clearInterval(streamTimer);
    clearTimeout(pushTimer);
    for (const res of streams) res.end();
  });

  // autoPort：端口是自动选的（没指定 --port），监听那一刻被别的进程抢先就往后换，最多试 10 个。
  // 不能在外面重新调 startServer：这次已经建好的 store 和定时器会留下，两份同时写数据
  const listenOn = (p) => new Promise((resolve, reject) => {
    const onError = (err) => { server.off('listening', onListening); reject(err); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(p, lan ? '0.0.0.0' : '127.0.0.1');
  });
  for (let tries = 0; ; tries++) {
    try {
      await listenOn(port);
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      if (autoPort && tries < 9 && port < 65535) { port++; continue; }
      throw Object.assign(new Error(`端口 ${port} 被占用。请重新运行 ateam serve（会自动找空闲端口），或用 --port 指定一个。`), { code: 'EADDRINUSE' });
    }
  }
  server.ateamPort = port;
  // 记下实际端口：端口被占用时会自动换成下一个，项目里的 ateam 命令读这个文件找到服务
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'port'), `${port}\n`);
  server.ateamLayout = layout;
  if (lan) server.ateamLan = lanAddresses().map((ip) => `http://${ip}:${port}`);
  lanUrls = server.ateamLan ?? [];
  recheck().catch(() => {});
  if (store.config().testBrowser === 'ego') refreshEgoProfiles().catch(() => {});
  // 菜单栏程序的项目列表
  rememberProject(root);
  // 安装版：启动时和之后每 6 小时查一次新版本
  checkUpdate().catch(() => {});
  setInterval(() => checkUpdate().catch(() => {}), UPDATE_EVERY).unref();
  // 推送到手机：每 15 秒看一次待处理清单
  setTimeout(() => checkPush().catch(() => {}), 5000).unref();
  setInterval(() => checkPush().catch(() => {}), 15000).unref();
  // token 用量：每分钟把新通过的卡的用量记到卡上
  // 启动 10 秒后先算一遍（顺带把会话记录解压进缓存，之后打开「用量」页就快了），之后每分钟看一次
  setTimeout(() => { usageReport(true).then(snapshotTokens).catch(() => {}); }, 10000).unref();
  setInterval(() => { snapshotTokens().catch(() => {}); checkRotate().catch(() => {}); }, 60000).unref();
  setInterval(() => { syncTick().catch(() => {}); syncAuto().catch(() => {}); }, 60000).unref();
  setTimeout(() => { (syncCfg.enabled ? syncTick() : syncAuto()).catch(() => {}); }, 5000).unref();
  return server;
}
