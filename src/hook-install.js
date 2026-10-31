// 给 agent 平台装工具后 hook：DSH 走官方桥接包，WorkBuddy 写 settings.json。
// 重复运行是安全的；改动都在 ateam 标记过的条目里，不碰别人的配置。
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BRIDGE = '@deepseek-ai/dsh-hooks-claude-code';
const PROTOCOL = '@deepseek-ai/dsh-hook-protocol';
const BEGIN = '# ateam hook begin';
const END = '# ateam hook end';
const POST_TOOL = 'hook post-tool';
const PRE_JOB_OUTPUT = 'hook pre-job-output';
// 读后台输出的工具：DSH 是 job_output，WorkBuddy 是 TaskOutput
const JOB_OUTPUT_TOOLS = '^(job_output|TaskOutput)$';
const MANUAL = '文档：agent-team 仓库的 docs/worker-hook-setup.md。';

const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');

function hookCommand(sub) {
  return `"${process.execPath}" "${process.argv[1]}" ${sub}`;
}

function dshHooks() {
  return {
    PostToolUse: [{ hooks: [{ type: 'command', command: hookCommand(POST_TOOL), timeout: 5 }] }],
    PreToolUse: [{ matcher: JOB_OUTPUT_TOOLS, hooks: [{ type: 'command', command: hookCommand(PRE_JOB_OUTPUT), timeout: 5 }] }],
  };
}

// WorkBuddy 把非 0 退出当成拦截，node 路径随它升级失效时不能影响 worker，所以兜底成功退出
function workbuddyHooks() {
  const safe = (sub) => [{ type: 'command', command: `${hookCommand(sub)} 2>/dev/null || true`, timeout: 5 }];
  return {
    PostToolUse: { hooks: safe(POST_TOOL) },
    PreToolUse: { matcher: JOB_OUTPUT_TOOLS, hooks: safe(PRE_JOB_OUTPUT) },
  };
}

function isOurEntry(entry) {
  return (entry?.hooks ?? []).some((h) => / hook (post-tool|pre-job-output)\b/.test(String(h?.command ?? '')));
}

function dshProfileDir(flags) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const profile = flags.profile || process.env.DSH_PROFILE || 'desktop';
  const dir = join(home, 'profiles', profile);
  if (!existsSync(join(dir, 'cordis.yml'))) throw new Error(`找不到 DeepSeek Harness 配置目录：${dir}。用 --profile 指定 profile。`);
  return dir;
}

function dshVersion(flags) {
  if (flags['dsh-version']) return flags['dsh-version'];
  if (process.platform === 'darwin') {
    try {
      return execFileSync('defaults', ['read', '/Applications/DeepSeek Harness.app/Contents/Info', 'CFBundleShortVersionString'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {}
  }
  throw new Error('无法读取 DeepSeek Harness 版本。在应用的「关于」里查看，然后用 --dsh-version <版本号> 重新运行。');
}

// 优先用 DSH 自带的 pnpm，用户机器上不一定装了
function pnpmAdd(dir, packages) {
  const bundled = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs');
  const [file, ...args] = existsSync(bundled) ? [process.execPath, bundled] : ['pnpm'];
  try {
    execFileSync(file, [...args, 'add', '-w', ...packages], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  } catch (err) {
    // pnpm 把错误原因写在 stdout，只看 stderr 会什么都看不到
    const output = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim().split('\n').filter((l) => l.trim()).slice(-15).join('\n');
    throw new Error(`在 ${dir} 安装 hook 桥接包失败（${packages.join(' ')}）。pnpm 输出：\n${output || '（无输出）'}`);
  }
}

function stripPatchBlock(text) {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start < 0 || end < start) return text;
  return text.slice(0, start).trimEnd() + '\n' + text.slice(end + END.length).replace(/^\n+/, '');
}

function installDsh(flags) {
  const dir = dshProfileDir(flags);
  const version = dshVersion(flags);
  const patchFile = join(dir, 'cordis.patch.yml');
  // 配置内容变了就换文件名：DSH 只在 patch 变化时重新加载，文件名写在 patch 里
  const configFile = join(dir, 'ateam-hooks-2.json');
  const installed = JSON.parse(read(join(dir, 'package.json')) || '{}').dependencies?.[BRIDGE];
  const patch = read(patchFile);
  const config = JSON.stringify({ hooks: dshHooks() }, null, 2) + '\n';
  // 新插件必须放在 insert 里：只有 id 的条目是改已有的行，匹配不到会被 DSH 跳过
  const block = `${BEGIN}\n- insert:\n    - id: ateam-hooks\n      name: '${BRIDGE}'\n      config:\n        configPath: ${JSON.stringify(configFile)}\n${END}\n`;
  if (installed === version && patch.includes(block) && read(configFile) === config) {
    return `hook 已安装（DeepSeek Harness ${version}），不需要操作。`;
  }
  // 版本必须和 DSH 完全一致（桥接包的 peer 依赖锁定了版本）
  if (installed !== version) pnpmAdd(dir, [`${BRIDGE}@${version}`, `${PROTOCOL}@${version}`]);
  writeFileSync(configFile, config);
  if (!patch.includes(block)) {
    // 备份只留第一次的，它才是 ateam 动手之前的样子
    if (patch && !existsSync(`${patchFile}.bak.ateam`)) copyFileSync(patchFile, `${patchFile}.bak.ateam`);
    writeFileSync(patchFile, `${stripPatchBlock(patch).trimEnd()}\n${block}`);
  }
  return `hook 已写入 DeepSeek Harness 配置（${dir}），通常几十秒内自动生效，不用重启。如果一直不生效，由用户在菜单中点击「Restart App and Host」，这会打断所有会话，不要自己重启。${MANUAL}`;
}

function workbuddySettingsFile() {
  const candidates = [join(homedir(), '.workbuddy', 'settings.json'), join(homedir(), '.codebuddy', 'settings.json')];
  const file = candidates.find(existsSync);
  if (!file) throw new Error(`找不到 WorkBuddy 配置文件（${candidates.join('、')}）。请先启动一次 WorkBuddy。`);
  return file;
}

function readSettings(file) {
  try {
    return JSON.parse(read(file));
  } catch {
    throw new Error(`${file} 不是合法的 JSON，没有修改。`);
  }
}

function installWorkbuddy() {
  const file = workbuddySettingsFile();
  const settings = readSettings(file);
  const wanted = workbuddyHooks();
  const hasEntry = (event) => (settings.hooks?.[event] ?? []).some((e) => isOurEntry(e) && e.hooks[0].command === wanted[event].hooks[0].command);
  if (hasEntry('PostToolUse') && hasEntry('PreToolUse')) return `hook 已安装（${file}），不需要操作。`;
  const ours = (settings.hooks?.PostToolUse ?? []).some(isOurEntry);
  copyFileSync(file, `${file}.bak.ateam`);
  settings.hooks = { ...settings.hooks };
  for (const event of Object.keys(wanted)) {
    settings.hooks[event] = [...(settings.hooks[event] ?? []).filter((e) => !isOurEntry(e)), wanted[event]];
  }
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  if (ours) return `hook 已安装（${file}），配置已更新，不需要操作。`;
  return `hook 已写入 ${file}，重启会话或在 /hooks 面板确认后生效。${MANUAL}`;
}

function uninstallDsh(flags) {
  const dir = dshProfileDir(flags);
  const patchFile = join(dir, 'cordis.patch.yml');
  const patch = read(patchFile);
  if (!patch.includes(BEGIN)) return 'DeepSeek Harness 上没有安装 ateam 的 hook。';
  writeFileSync(patchFile, stripPatchBlock(patch));
  return '已从 DeepSeek Harness 配置中移除 hook，通常几十秒内自动生效。补充说明回到下一次调用 ateam 时送达。';
}

function uninstallWorkbuddy() {
  const file = workbuddySettingsFile();
  const settings = readSettings(file);
  if (!(settings.hooks?.PostToolUse ?? []).some(isOurEntry) && !(settings.hooks?.PreToolUse ?? []).some(isOurEntry)) return 'WorkBuddy 上没有安装 ateam 的 hook。';
  for (const event of ['PostToolUse', 'PreToolUse']) {
    if (settings.hooks[event]) settings.hooks[event] = settings.hooks[event].filter((e) => !isOurEntry(e));
  }
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return `已从 ${file} 移除 hook，重启会话后生效。`;
}

function platformOf(flags) {
  const platform = flags.platform || (process.env.DSH_PROFILE || process.env.DSH_WEB_URL ? 'dsh' : '');
  if (platform === 'dsh' || platform === 'workbuddy') return platform;
  throw new Error(platform
    ? `不支持自动安装 ${platform}。支持 Claude Code 格式 PostToolUse hook 的平台可以手工配置。${MANUAL}`
    : `认不出当前平台，用 --platform dsh 或 --platform workbuddy 指定。其他平台可以手工配置。${MANUAL}`);
}

export function installHook(flags) {
  return platformOf(flags) === 'dsh' ? installDsh(flags) : installWorkbuddy();
}

export function uninstallHook(flags) {
  return platformOf(flags) === 'dsh' ? uninstallDsh(flags) : uninstallWorkbuddy();
}
