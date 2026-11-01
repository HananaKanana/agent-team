// 在 agent 平台里新开一个 worker 会话并发出开场提示词。目前支持 DeepSeek Harness：
// 通过 ateam 自带的 DSH 插件（dsh-plugin/），它只接受带密钥的本机请求。
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

export async function spawnWorker({ root, role, name, platform = 'dsh' }) {
  if (platform !== 'dsh') throw new AteamError('INVALID', `暂不支持在 ${platform} 中自动启动 worker，目前只支持 DeepSeek Harness（dsh）。`);
  role = String(role ?? '').trim();
  name = name ? String(name).trim() : undefined;
  if (!TOKEN.test(role)) throw new AteamError('INVALID', '角色只能包含字母、数字、- 和 _，比如 frontend。');
  if (name !== undefined && !TOKEN.test(name)) throw new AteamError('INVALID', '名字只能包含字母、数字、- 和 _。');
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
  return { platform, sessionId: out.sessionId, inWorkspace: !!out.workspaceId, text: out.text };
}
