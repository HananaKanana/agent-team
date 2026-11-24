// 升级：从 GitHub Releases 查新版本、下载对应架构的安装包、核对 sha256、交给系统安装程序。
// 只有安装版（install.js 的 mode() 为 installed）才查；开发模式和源码运行不查。
// Release 约定：tag vX.Y.Z，附件 ateam-X.Y.Z-arm64.pkg / ateam-X.Y.Z-x64.pkg / ateam-X.Y.Z-win-x64.exe 和各自的 <安装包名>.sha256（release.sh 生成）。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { version } from './install.js';

export const REPO = 'HananaKanana/agent-team';
const API = `https://api.github.com/repos/${REPO}/releases?per_page=15`;
// 不带用户信息
const HEADERS = { 'user-agent': 'ateam-update', accept: 'application/vnd.github+json' };
const DOWNLOAD = { 'user-agent': 'ateam-update', accept: 'application/octet-stream' };

const PATTERN = /^\d+\.\d+\.\d+$/;
export function isNewer(a, b) {
  if (!PATTERN.test(String(a)) || !PATTERN.test(String(b))) return false;
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

export function packageName(v, arch = process.arch, platform = process.platform) {
  if (platform === 'win32') return arch === 'x64' ? `ateam-${v}-win-x64.exe` : null;
  return arch === 'arm64' || arch === 'x64' ? `ateam-${v}-${arch}.pkg` : null;
}

// 最近的正式版本（新的在前），只留本机架构有安装包的
export async function listReleases() {
  const res = await fetch(API, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (res.status === 404) throw new Error(`找不到 ${REPO} 的发布页（仓库不存在或不是公开的）`);
  if (res.status === 403 || res.status === 429) throw new Error('GitHub 暂时限制了查询次数，稍后再试');
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
  const list = await res.json();
  return list
    .filter((r) => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name))
    .map((r) => {
      const v = r.tag_name.slice(1);
      const name = packageName(v);
      const pkg = r.assets?.find((a) => a.name === name);
      const sum = r.assets?.find((a) => a.name === `${name}.sha256`);
      return { version: v, date: r.published_at, notes: String(r.body ?? '').trim(), url: r.html_url, pkg: pkg ? { name, url: pkg.browser_download_url, size: pkg.size } : null, sha256Url: sum?.browser_download_url ?? null };
    })
    .filter((r) => r.pkg && r.sha256Url);
}

// 查一次：{ current, latest, newer, releases, checkedAt, error }
export async function check() {
  const current = version();
  try {
    const releases = await listReleases();
    const latest = releases[0]?.version ?? null;
    return { current, latest, newer: !!latest && isNewer(latest, current), releases, checkedAt: Date.now(), error: null };
  } catch (err) {
    return { current, latest: null, newer: false, releases: [], checkedAt: Date.now(), error: `检查更新失败：${err.message}` };
  }
}

// 下载指定版本（不给就是最新）的安装包，核对 sha256 后用 open 交给系统安装程序。
// onProgress({ received, total })。返回安装包路径
export async function install(wanted, onProgress = () => {}) {
  const releases = await listReleases();
  const rel = wanted ? releases.find((r) => r.version === wanted) : releases[0];
  if (!rel) throw new Error(wanted ? `没有找到版本 ${wanted} 的 ${process.arch} 安装包` : '没有可安装的版本');
  const dir = join(tmpdir(), 'ateam-update');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, rel.pkg.name);
  const part = `${file}.part`;

  const sumRes = await fetch(rel.sha256Url, { headers: DOWNLOAD, signal: AbortSignal.timeout(30000) });
  if (!sumRes.ok) throw new Error(`下载校验文件失败（${sumRes.status}）`);
  const expected = (await sumRes.text()).trim().split(/\s+/)[0]?.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected ?? '')) throw new Error('校验文件格式不对');

  const res = await fetch(rel.pkg.url, { headers: DOWNLOAD });
  if (!res.ok || !res.body) throw new Error(`下载安装包失败（${res.status}）`);
  const total = Number(res.headers.get('content-length')) || rel.pkg.size || 0;
  const hash = createHash('sha256');
  const out = createWriteStream(part);
  let received = 0;
  let idle;
  const reader = res.body.getReader();
  try {
    for (;;) {
      // 30 秒一个字节都没收到就算断了
      const chunk = await Promise.race([reader.read(), new Promise((_, reject) => { idle = setTimeout(() => reject(new Error('下载超时（30 秒没有收到数据）')), 30000); })]);
      clearTimeout(idle);
      if (chunk.done) break;
      hash.update(chunk.value);
      received += chunk.value.length;
      if (!out.write(chunk.value)) await new Promise((r) => out.once('drain', r));
      onProgress({ received, total });
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  } catch (err) {
    clearTimeout(idle);
    out.destroy();
    rmSync(part, { force: true });
    throw err;
  }
  if (hash.digest('hex') !== expected) {
    rmSync(part, { force: true });
    throw new Error('安装包校验失败（sha256 不一致），已删除下载的文件。请稍后重试');
  }
  renameSync(part, file);
  if (process.platform === 'win32') {
    // Windows 安装程序 /update：不弹窗，退掉托盘程序、换掉程序文件、重新打开托盘。不需要管理员权限
    spawn(file, ['/update'], { detached: true, stdio: 'ignore', windowsHide: true, cwd: tmpdir() }).unref();
    return { version: rel.version, file };
  }
  // 交给系统安装程序：用户输一次管理员密码。下载的文件没有隔离标记，不会被 Gatekeeper 拦
  spawn('open', [file], { detached: true, stdio: 'ignore' }).unref();
  return { version: rel.version, file };
}

// 本机 sha256（release.sh 生成 .sha256 时也用这个格式）
export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
