// 在 agent 平台里新开一个 worker 会话并发出开场提示词。
// - DeepSeek Harness：通过 ateam 自带的 DSH 插件（dsh-plugin/），它只接受带密钥的本机请求
// - WorkBuddy：它的任务链接只把提示词和工作目录填进输入框、不发送（有意的安全设计），
//   所以填好后再模拟按一次回车。按键要求运行 ateam serve 的终端有 macOS「辅助功能」权限，
//   没有权限时停在「已填好」，请用户自己按回车
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AteamError } from './errors.js';

const TOKEN = /^[A-Za-z0-9_-]{1,40}$/;
const NOT_INSTALLED = 'DeepSeek Harness 上还没有安装 ateam 的启动插件。请在终端运行 ateam hook install --platform dsh（看板「使用说明 → 安装」第 ③ 步）。';

function launchKey() {
  try {
    return readFileSync(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'ateam-launch.key'), 'utf8').trim();
  } catch {
    throw new AteamError('BAD_STATE', NOT_INSTALLED);
  }
}

// DSH 的本机服务端口每次启动都不同：从正在监听的端口里找
function dshPorts() {
  let out = '';
  try {
    out = execFileSync('lsof', ['-nP', '-a', '-c', 'DeepSeek', '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {}
  return [...new Set([...out.matchAll(/^n(?:127\.0\.0\.1|\[::1\]|localhost):(\d+)$/gm)].map((m) => Number(m[1])))];
}

async function findLauncher(key) {
  const ports = dshPorts();
  if (!ports.length) throw new AteamError('BAD_STATE', 'DeepSeek Harness 没有在运行。请先打开 DeepSeek Harness。');
  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/ateam-launch`, { headers: { 'x-ateam-key': key }, signal: AbortSignal.timeout(1500) });
      if (res.status === 401) throw new AteamError('BAD_STATE', '启动插件的密钥不匹配。请在终端重新运行 ateam hook install --platform dsh。');
      if (res.ok && (await res.json()).ready) return port;
    } catch (err) {
      if (err instanceof AteamError) throw err;
    }
  }
  throw new AteamError('BAD_STATE', `${NOT_INSTALLED}刚安装的话等几十秒再试。`);
}

const WORKBUDDY_ID = 'com.tencent.workbuddy.mac';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function workbuddyRunning() {
  try {
    execFileSync('pgrep', ['-f', '/Applications/WorkBuddy.app/Contents/MacOS/'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function frontmostIsWorkbuddy() {
  try {
    return execFileSync('osascript', ['-e', 'tell application "System Events" to get bundle identifier of first process whose frontmost is true'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === WORKBUDDY_ID;
  } catch {
    return false;
  }
}

async function spawnWorkbuddy(root, text) {
  if (process.platform !== 'darwin') throw new AteamError('INVALID', '在 WorkBuddy 中自动启动 worker 目前只支持 macOS。');
  // 冷启动时送到的链接会被丢掉：先把 WorkBuddy 打开，等它就绪
  if (!workbuddyRunning()) {
    try {
      execFileSync('open', ['-b', WORKBUDDY_ID], { stdio: 'ignore' });
    } catch {
      throw new AteamError('BAD_STATE', '没有找到 WorkBuddy，请先安装并登录。');
    }
    for (let i = 0; i < 30 && !workbuddyRunning(); i++) await sleep(500);
    await sleep(6000);
  }
  const link = `workbuddy://task?${new URLSearchParams({ action: 'start', prompt: text, cwd: root })}`;
  execFileSync('open', [link], { stdio: 'ignore' });
  await sleep(2500);
  // 只在 WorkBuddy 确实在最前面时按回车，免得按到别的窗口里
  if (!frontmostIsWorkbuddy()) return { sent: false, reason: 'WorkBuddy 没有切到最前面' };
  try {
    execFileSync('osascript', ['-e', 'tell application "System Events" to key code 36'], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    return { sent: true };
  } catch (err) {
    const denied = /1002|不允许发送按键|not allowed to send keystrokes/i.test(String(err.stderr ?? err.message));
    return { sent: false, reason: denied ? '运行 ateam serve 的终端没有「辅助功能」权限' : '模拟按键失败' };
  }
}

export async function spawnWorker({ root, role, name, platform = 'dsh' }) {
  if (platform !== 'dsh' && platform !== 'workbuddy') throw new AteamError('INVALID', `不支持在 ${platform} 中自动启动 worker。`);
  role = String(role ?? '').trim();
  name = name ? String(name).trim() : undefined;
  if (!TOKEN.test(role)) throw new AteamError('INVALID', '角色只能包含字母、数字、- 和 _，比如 frontend。');
  if (name !== undefined && !TOKEN.test(name)) throw new AteamError('INVALID', '名字只能包含字母、数字、- 和 _。');
  if (platform === 'workbuddy') {
    const text = `使用 ateam-worker skill，角色 ${role}${name ? `，名字 ${name}` : ''}`;
    const { sent, reason } = await spawnWorkbuddy(root, text);
    return { platform, sessionId: null, inWorkspace: true, text, sent, ...(sent ? {} : { note: `提示词和工作目录已填入 WorkBuddy 的输入框，但没有自动发送（${reason}）。请在 WorkBuddy 中按回车发送。要自动发送，在「系统设置 → 隐私与安全性 → 辅助功能」里允许运行 ateam serve 的终端。` }) };
  }
  const key = launchKey();
  const port = await findLauncher(key);
  const res = await fetch(`http://127.0.0.1:${port}/api/ateam-launch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ateam-key': key },
    body: JSON.stringify({ cwd: root, role, ...(name ? { name } : {}) }),
    signal: AbortSignal.timeout(40_000),
  });
  const out = await res.json().catch(() => ({}));
  if (!out.ok) throw new AteamError('BAD_STATE', `DeepSeek Harness 没能开出会话：${out.message ?? res.status}`);
  return { platform, sessionId: out.sessionId, inWorkspace: !!out.workspaceId, text: out.text, sent: true };
}
