// 安装包相关：版本、运行模式（安装版 / 开发模式 / 源码）、skill 软链、开发模式切换、菜单栏程序用的项目列表。
// 安装包把程序装在 /Library/Application Support/ateam（node/ 和 app/），/usr/local/bin/ateam 是启动脚本：
// ~/.config/ateam/dev-repo 记着源码仓库时运行仓库里的代码（开发模式），否则运行 app/ 里的。
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const INSTALL_DIR = '/Library/Application Support/ateam';
export const APP_DIR = join(INSTALL_DIR, 'app');
export const WRAPPER = '/usr/local/bin/ateam';
export const MENU_APP = '/Applications/ateam.app';
const home = () => homedir();
export const configDir = () => join(home(), '.config', 'ateam');
const devFile = () => join(configDir(), 'dev-repo');
const projectsFile = () => join(configDir(), 'projects.json');
const loginItemFile = () => join(home(), 'Library', 'LaunchAgents', 'com.ateam.menubar.plist');
const noLoginItemFile = () => join(configDir(), 'no-login-item');

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

export function version() {
  try { return JSON.parse(readFileSync(join(TOOL_DIR, 'package.json'), 'utf8')).version ?? '0.0.0'; } catch { return '0.0.0'; }
}

// 装了安装包没有
export function installed() {
  return existsSync(join(APP_DIR, 'bin', 'ateam.js'));
}

// 是不是一份 ateam 源码仓库
function isRepo(dir) {
  try {
    return existsSync(join(dir, 'bin', 'ateam.js')) && JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === 'agent-team';
  } catch { return false; }
}

// 开发模式记下的源码仓库（目录还在才算）
export function devRepo() {
  try {
    const dir = readFileSync(devFile(), 'utf8').split('\n')[0].trim();
    return dir && isRepo(dir) ? dir : null;
  } catch { return null; }
}

// installed：运行的是安装目录里的代码；dev：运行的是开发模式记下的仓库；source：没装安装包、直接跑源码（npm link 的老用法）
export function mode() {
  if (real(TOOL_DIR) === real(APP_DIR)) return 'installed';
  const dev = devRepo();
  if (installed() && dev && real(dev) === real(TOOL_DIR)) return 'dev';
  return 'source';
}

// 切换开发模式 / 安装版后，已经在运行的进程还是原来那份代码（要重启才换）。
// 返回启动脚本此刻会选的模式（'dev' / 'installed'），和正在运行的代码一致时返回 null；没装安装包时不比较
export function modeMismatch() {
  if (!installed()) return null;
  const dev = devRepo();
  return real(dev ?? APP_DIR) === real(TOOL_DIR) ? null : dev ? 'dev' : 'installed';
}

export function modeLabel(m = mode()) {
  return m === 'installed' ? '安装版' : m === 'dev' ? `开发模式：${TOOL_DIR}` : `源码运行：${TOOL_DIR}`;
}

// ---------- skill 软链 ----------

// 各平台的 skill 目录。只链本机装了的平台（平台自己的目录在）
function skillTargets() {
  const h = home();
  const out = [];
  if (isDir(join(h, '.claude'))) out.push({ platform: 'Claude Code', name: 'ateam-lead', dir: join(h, '.claude', 'skills') });
  const dshHome = process.env.DSH_HOME || join(h, '.dsh');
  if (isDir(dshHome) || isDir(join(h, '.agents'))) {
    // DeepSeek Harness：已经放着 ateam-worker 的目录优先，否则 ~/.agents/skills
    const cands = [join(h, '.agents', 'skills'), join(dshHome, 'skills')];
    const has = (d) => { try { lstatSync(join(d, 'ateam-worker')); return true; } catch { return false; } };
    const dir = cands.find(has) ?? cands[0];
    out.push({ platform: 'DeepSeek Harness', name: 'ateam-worker', dir });
    out.push({ platform: 'DeepSeek Harness', name: 'browser-cdp-setup', dir });
  }
  if (isDir(join(h, '.workbuddy'))) out.push({ platform: 'WorkBuddy', name: 'ateam-worker', dir: join(h, '.workbuddy', 'skills') });
  return out;
}

const SKILL_NAMES = ['ateam-lead', 'ateam-worker', 'browser-cdp-setup'];
// 固定位置以外、用户自己建的 ateam skill 软链（比如把 ateam-worker 也链进 ~/.claude/skills，让 Claude Code 当 worker）。
// 只认指向某份 ateam（源码仓库或安装目录）skills/ 的软链，切换模式、卸载时跟着改，不新建
function extraLinks() {
  const h = home();
  const dshHome = process.env.DSH_HOME || join(h, '.dsh');
  const dirs = [join(h, '.claude', 'skills'), join(h, '.agents', 'skills'), join(dshHome, 'skills'), join(h, '.workbuddy', 'skills'), join(h, '.codebuddy', 'skills')];
  const fixed = new Set(skillTargets().map((t) => join(t.dir, t.name)));
  const out = [];
  for (const dir of dirs) {
    for (const name of SKILL_NAMES) {
      const dest = join(dir, name);
      if (fixed.has(dest)) continue;
      try {
        if (!lstatSync(dest).isSymbolicLink()) continue;
        const target = resolve(dir, readlinkSync(dest));
        if (basename(target) === name && basename(dirname(target)) === 'skills' && isRepo(dirname(dirname(target)))) out.push({ platform: dir.replace(h, '~'), name, dir });
      } catch {}
    }
  }
  return out;
}

// 现有 skill 软链指向的源码仓库（老的 npm link + 手动软链用法）
function linkedRepo() {
  for (const t of skillTargets()) {
    try {
      const link = join(t.dir, t.name);
      if (!lstatSync(link).isSymbolicLink()) continue;
      const repo = resolve(t.dir, readlinkSync(link), '..', '..');
      if (isRepo(repo) && real(repo) !== real(APP_DIR)) return repo;
    } catch {}
  }
  return null;
}

// 把 skill 链到 source（安装目录或源码仓库）。已有同名软链直接换；已有同名真实目录挪到 ~/.config/ateam/backup，
// 不留在 skill 目录里（留着的话 agent 会读到两份同名 skill）
function linkSkills(source) {
  const lines = [];
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  for (const t of [...skillTargets(), ...extraLinks()]) {
    const dest = join(t.dir, t.name);
    const target = join(source, 'skills', t.name);
    try {
      mkdirSync(t.dir, { recursive: true });
      let st = null;
      try { st = lstatSync(dest); } catch {}
      if (st?.isSymbolicLink()) {
        if (resolve(t.dir, readlinkSync(dest)) === target) { lines.push(`✓ ${t.platform}：${t.name} 已链接`); continue; }
        unlinkSync(dest);
      } else if (st) {
        const backup = join(configDir(), 'backup', `${t.platform.replace(/\s+/g, '')}-${t.name}-${stamp}`);
        mkdirSync(dirname(backup), { recursive: true });
        renameSync(dest, backup);
        lines.push(`  ${dest} 原来是一个目录，已移到 ${backup}`);
      }
      symlinkSync(target, dest);
      lines.push(`✓ ${t.platform}：${t.name} → ${target}`);
    } catch (err) {
      lines.push(`✗ ${t.platform}：${t.name} 链接失败（${err.message.split('\n')[0]}）`);
    }
  }
  if (!lines.length) lines.push('没有检测到 Claude Code、DeepSeek Harness 或 WorkBuddy，跳过 skill 链接。装好平台后运行 ateam setup。');
  return lines;
}

// 卸载：删掉指向 source 的 skill 软链
function unlinkSkills(source) {
  const lines = [];
  for (const t of [...skillTargets(), ...extraLinks()]) {
    const dest = join(t.dir, t.name);
    try {
      if (lstatSync(dest).isSymbolicLink() && resolve(t.dir, readlinkSync(dest)).startsWith(`${source}/`)) {
        unlinkSync(dest);
        lines.push(`已删除 ${dest}`);
      }
    } catch {}
  }
  return lines;
}

// ---------- hook ----------

// 用 bin 那份代码重装 hook：hook 里写的是「node + ateam.js」的绝对路径，切换安装版 / 开发模式后要跟着换
function installHooks(bin) {
  const h = home();
  const platforms = [];
  if (isDir(process.env.DSH_HOME || join(h, '.dsh'))) platforms.push(['dsh', 'DeepSeek Harness']);
  if (isDir(join(h, '.workbuddy')) || isDir(join(h, '.codebuddy'))) platforms.push(['workbuddy', 'WorkBuddy']);
  if (!platforms.length) return ['没有检测到 DeepSeek Harness 或 WorkBuddy，跳过 hook。'];
  return platforms.map(([p, label]) => {
    const r = spawnSync(process.execPath, [bin, 'hook', 'install', '--platform', p], { encoding: 'utf8', timeout: 60000 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n')[0] ?? '';
    return r.status === 0 ? `✓ ${label} hook：${out}` : `✗ ${label} hook 安装失败：${out}（可在看板「使用说明 → 安装」重试）`;
  });
}

function uninstallHooks(bin) {
  const lines = [];
  for (const p of ['dsh', 'workbuddy']) {
    const r = spawnSync(process.execPath, [bin, 'hook', 'uninstall', '--platform', p], { encoding: 'utf8', timeout: 60000 });
    if (r.status === 0) lines.push(`${p === 'dsh' ? 'DeepSeek Harness' : 'WorkBuddy'} hook：${`${r.stdout ?? ''}`.trim().split('\n')[0]}`);
  }
  return lines;
}

// ---------- npm link 留下的旧命令 ----------

// PATH 里名为 ateam、指向某个 .../bin/ateam.js 的软链（npm link 建的）会抢在 /usr/local/bin/ateam 前面，删掉
function removeNpmLinks() {
  const h = home();
  const dirs = new Set([...String(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', join(h, '.npm-global', 'bin'), join(h, '.local', 'bin')]);
  const nvm = join(h, '.nvm', 'versions', 'node');
  if (isDir(nvm)) for (const v of readdirSync(nvm)) dirs.add(join(nvm, v, 'bin'));
  const lines = [];
  for (const d of dirs) {
    if (!d || d === dirname(WRAPPER)) continue;
    const f = join(d, 'ateam');
    try {
      if (!lstatSync(f).isSymbolicLink()) continue;
      const target = real(f);
      if (basename(target) === 'ateam.js' && basename(dirname(target)) === 'bin') {
        unlinkSync(f);
        lines.push(`已删除 npm link 留下的 ${f}（现在由 ${WRAPPER} 提供 ateam 命令）`);
      }
    } catch {}
  }
  return lines;
}

// ---------- 登录时打开菜单栏程序 ----------

export function loginItemOn() {
  return existsSync(loginItemFile());
}

export function setLoginItem(on) {
  if (on) {
    mkdirSync(dirname(loginItemFile()), { recursive: true });
    writeFileSync(loginItemFile(), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ateam.menubar</string>
  <key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-a</string><string>${MENU_APP}</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`);
    rmSync(noLoginItemFile(), { force: true });
  } else {
    rmSync(loginItemFile(), { force: true });
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(noLoginItemFile(), '');
  }
}

// ---------- 对外的命令 ----------

// 安装包的 postinstall（以登录用户身份）和用户手动都会跑：链 skill、清 npm link、装 hook、登录项。
// 第一次安装时发现 skill 正链着某个源码仓库（老用法），记为开发模式，保持现状
export function setup({ installer = false } = {}) {
  const lines = [];
  if (installer && !devRepo()) {
    const repo = linkedRepo();
    if (repo) {
      mkdirSync(configDir(), { recursive: true });
      writeFileSync(devFile(), `${repo}\n`);
      lines.push(`检测到 skill 链接的是源码仓库 ${repo}，已进入开发模式：ateam 命令、skill 和 hook 继续使用这个仓库的代码。切回安装版：ateam dev off`);
    }
  }
  const dev = devRepo();
  const source = dev && installed() ? dev : installed() ? APP_DIR : TOOL_DIR;
  lines.push(...linkSkills(source));
  if (installed()) lines.push(...removeNpmLinks());
  lines.push(...installHooks(join(source, 'bin', 'ateam.js')));
  if (installed() && !loginItemOn() && !existsSync(noLoginItemFile())) {
    setLoginItem(true);
    lines.push('✓ 已设置登录时自动打开 ateam 菜单栏程序（可在菜单里取消）');
  }
  return lines.join('\n');
}

// 卸载脚本调用：删指向安装目录的 skill 软链、卸 hook、删登录项
export function teardown() {
  const lines = [...unlinkSkills(APP_DIR)];
  const dev = devRepo();
  if (dev) lines.push(...unlinkSkills(dev));
  lines.push(...uninstallHooks(join(APP_DIR, 'bin', 'ateam.js')));
  rmSync(loginItemFile(), { force: true });
  if (dev) lines.push(`开发模式记录的仓库 ${dev} 没有动。卸载后要继续从源码运行，在仓库里执行 npm link，再运行 ateam setup。`);
  return lines.join('\n');
}

export function devOn(path) {
  const repo = resolve(path ?? '');
  if (!path || !isRepo(repo)) throw new Error(`${path ? `${repo} 不是 agent-team 源码仓库（缺少 bin/ateam.js 或 package.json 的 name 不是 agent-team）` : '用法：ateam dev on <源码仓库路径>'}`);
  if (!installed()) throw new Error('没有安装 ateam 安装包，不需要开发模式：直接在仓库里 npm link 即可。');
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(devFile(), `${repo}\n`);
  return [`已进入开发模式：ateam 命令、skill 和 hook 使用 ${repo} 的代码，改完代码重启 ateam 服务即生效；不检查更新。`, ...linkSkills(repo), ...installHooks(join(repo, 'bin', 'ateam.js')),
    '正在运行的 ateam 服务仍是原来的代码，重启后切换。'].join('\n');
}

export function devOff() {
  if (!installed()) throw new Error('没有安装 ateam 安装包，无法切回安装版。');
  rmSync(devFile(), { force: true });
  return ['已切回安装版：ateam 命令、skill 和 hook 使用安装目录里的代码。', ...linkSkills(APP_DIR), ...installHooks(join(APP_DIR, 'bin', 'ateam.js')),
    '正在运行的 ateam 服务仍是原来的代码，重启后切换。'].join('\n');
}

// ---------- 菜单栏程序的项目列表 ----------

export function readProjects() {
  try {
    const list = JSON.parse(readFileSync(projectsFile(), 'utf8')).projects;
    return Array.isArray(list) ? list.filter((p) => p && typeof p.path === 'string') : [];
  } catch { return []; }
}

// ateam serve 启动时调用：把项目目录记进列表（最近用的排前面）
export function rememberProject(root) {
  try {
    const path = resolve(root);
    const list = [{ path, lastUsed: Date.now() }, ...readProjects().filter((p) => p.path !== path)].slice(0, 30);
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(projectsFile(), `${JSON.stringify({ projects: list }, null, 2)}\n`);
  } catch {}
}
