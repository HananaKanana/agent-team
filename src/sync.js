// 多人协作：每人的看板（board.json、archive/、demos/）存在仓库的 ateam/<名字> 分支上，经项目本来的 git 远程同步。
// 设计见 docs/superpowers/specs/2026-11-18-multi-person-sync-design.md。
// - 写自己的分支用 git 底层命令和临时暂存区（GIT_INDEX_FILE），不碰工作区、不碰真正的暂存区，worker 在同一目录里干活不受影响
// - 本地不建普通分支：自己的在 refs/ateam/self，同事的拉到 refs/ateam/peers/<名字>，git branch 看不到
// - 设置（开没开、名字、远程、多仓库时用哪个仓库）存在本机 ~/.config/ateam/sync.json，按项目目录分开，不进看板文件
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

export const SYNC_FORMAT = 1; // 分支里数据的格式版本：比自己新的同事数据不读
export const PEER_STALE_MS = 2 * 60 * 60 * 1000; // 同事超过这么久没同步：他的卡只提醒、不拦派卡
const SELF_REF = 'refs/ateam/self';
const PEER_PREFIX = 'refs/ateam/peers/';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// ---------- 本机设置 ----------
const cfgFile = () => join(homedir(), '.config', 'ateam', 'sync.json');
const keyOf = (root) => { try { return realpathSync(root); } catch { return root; } };
function readAll() {
  try { const j = JSON.parse(readFileSync(cfgFile(), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}

export function readSyncConfig(root) {
  const c = readAll()[keyOf(root)] ?? {};
  return { enabled: !!c.enabled, name: c.name ?? '', remote: c.remote || 'origin', repo: c.repo ?? '', autoAt: c.autoAt ?? null };
}

// 这台电脑对这个项目做过选择没有（开启、关闭都算）。没做过选择的才会自动开启
export const hasSyncConfig = (root) => keyOf(root) in readAll();

// 迁移提交写进 .ateam/.gitignore 的说明行：同事拉到这一行，就说明这个项目已经用看板同步了
export const SYNC_MARK = '# 看板改为通过 ateam/<名字> 分支同步，不随代码提交';

export function checkSyncConfig(cur) {
  if (cur.name && !NAME_RE.test(cur.name)) throw new Error('同步名字只能用小写字母、数字和连字符，以字母或数字开头，最多 32 个字符。');
  if (!/^[\w.-]+$/.test(cur.remote)) throw new Error('远程名不正确。');
}

export function saveSyncConfig(root, patch) {
  const all = readAll();
  const cur = { ...readSyncConfig(root), ...patch };
  checkSyncConfig(cur);
  all[keyOf(root)] = cur;
  mkdirSync(join(homedir(), '.config', 'ateam'), { recursive: true });
  writeFileSync(cfgFile(), `${JSON.stringify(all, null, 2)}\n`);
  return cur;
}

// git 用户名 → 同步名字的默认值
export const slugName = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

// ---------- git ----------
// 后台执行，不弹任何输入密码的提示：凭据不可用就直接失败
function git(cwd, args, { input, env, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, {
      cwd, timeout, maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '', ...env },
    }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr ?? ''); reject(err); } else resolve(String(stdout));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

// 推送 / 拉取失败的原因，给看板和命令行看
// git 报错里的具体原因，如 No route to host
function gitReason(s) {
  return s.match(/No route to host|Host is unreachable|Network is unreachable|Could not resolve host|Connection refused|Operation timed out|timed out/i)?.[0] ?? '网络不通或服务器不可用';
}

export function explainGitError(err) {
  const s = `${err?.stderr ?? ''} ${err?.message ?? ''}`;
  if (/non-fast-forward|\[rejected\]|fetch first|stale info/i.test(s)) return '远程的同名分支被别人推送过，这个同步名字可能被占用了，请换一个名字。';
  if (/protected|pre-receive hook declined|not allowed to (push|create)|permission|403/i.test(s)) return '远程拒绝推送 ateam/* 分支（没有权限，或设了分支保护）。请在 git 仓库的设置里允许创建 ateam/ 开头的分支。';
  if (/Authentication failed|could not read Username|terminal prompts disabled|401/i.test(s)) return '没有可用的 git 凭据。请先在终端里对这个仓库成功执行一次 git push（让系统记住账号），再重试。';
  if (/No route to host|Host is unreachable|Network is unreachable/i.test(s)) return `连不上 git 远程（${gitReason(s)}）。终端里能正常 git push 时，多半是 macOS 未允许 ateam 访问本地网络：打开「系统设置 → 隐私与安全性 → 本地网络」，打开 ateam，再在菜单栏重启该项目的服务。`;
  if (/Could not resolve host|Connection refused|timed out|unable to access|Operation timed out/i.test(s) || err?.killed) return `连不上 git 远程（${err?.killed ? '超时' : gitReason(s)}），恢复后自动重试。`;
  if (/does not appear to be a git repository|No such remote/i.test(s)) return '找不到这个 git 远程，请检查「远程」设置。';
  return (s.trim().split('\n').filter(Boolean).pop() ?? '未知错误').slice(0, 200);
}

const BOT = { GIT_AUTHOR_NAME: 'ateam', GIT_AUTHOR_EMAIL: 'ateam@localhost', GIT_COMMITTER_NAME: 'ateam', GIT_COMMITTER_EMAIL: 'ateam@localhost' };

async function refOid(top, ref) {
  try { return (await git(top, ['rev-parse', '-q', '--verify', `${ref}^{commit}`])).trim(); } catch { return null; }
}

// 要同步的文件（相对 .ateam/ 的路径）
function boardFiles(dataDir) {
  const out = [];
  if (existsSync(join(dataDir, 'board.json'))) out.push('board.json');
  for (const sub of ['archive', 'demos']) {
    try { for (const f of readdirSync(join(dataDir, sub))) if (f.endsWith('.json')) out.push(`${sub}/${f}`); } catch {}
  }
  return out;
}

// 把 .ateam/ 下的看板写成 refs/ateam/self 的一个新提交。内容没变、且上次提交在 heartbeatMs 以内时不写。
// 返回 { oid, changed }
export async function writeSelf({ top, dataDir, meta, heartbeatMs = 10 * 60 * 1000 }) {
  const index = join(tmpdir(), `ateam-sync-${process.pid}-${Date.now()}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const files = boardFiles(dataDir);
    const lines = [];
    if (files.length) {
      const oids = (await git(top, ['hash-object', '-w', '--no-filters', '--stdin-paths'], { input: files.map((f) => join(dataDir, f)).join('\n') + '\n' })).trim().split('\n');
      files.forEach((f, i) => lines.push(`100644 ${oids[i]}\t${f}`));
    }
    const metaOid = (await git(top, ['hash-object', '-w', '--stdin'], { input: `${JSON.stringify(meta, null, 2)}\n` })).trim();
    lines.push(`100644 ${metaOid}\tsync.json`);
    await git(top, ['update-index', '--index-info'], { input: `${lines.join('\n')}\n`, env });
    const tree = (await git(top, ['write-tree'], { env })).trim();
    const prev = await refOid(top, SELF_REF);
    if (prev) {
      const [ptree, ptime] = (await git(top, ['log', '-1', '--format=%T %ct', prev])).trim().split(' ');
      if (ptree === tree && Date.now() - Number(ptime) * 1000 < heartbeatMs) return { oid: prev, changed: false };
    }
    // 不接在上一个提交后面：分支上始终只有最新这一个提交（心跳不会把分支越堆越长），推送时覆盖远程
    const oid = (await git(top, ['commit-tree', tree, '-m', 'ateam sync'], { env: BOT })).trim();
    await git(top, ['update-ref', SELF_REF, oid]);
    return { oid, changed: true };
  } finally {
    rmSync(index, { force: true });
  }
}

// 覆盖远程的 ateam/<名字>，但只在远程还是自己上次推的那份（或还不存在）时才覆盖：
// 拉下来的那份是别的电脑、别的项目目录推的（名字被占用）就不推；推送期间被别人推过则失败（stale info）
export async function pushSelf({ top, remote, name, project }) {
  const peerRef = `${PEER_PREFIX}${name}`;
  const expect = (await refOid(top, peerRef)) ?? '';
  if (expect) {
    let meta = {};
    try { meta = JSON.parse(await git(top, ['cat-file', '-p', `${expect}:sync.json`])); } catch {}
    if ((meta.host && meta.host !== hostname()) || (meta.project && project && meta.project !== project)) {
      throw new Error(`同步名字「${name}」已被${meta.host && meta.host !== hostname() ? `另一台电脑（${meta.host}）` : `这台电脑上的另一个项目目录（${meta.project}）`}使用，已停止推送，请在设置中换一个名字。`);
    }
  }
  const oid = await refOid(top, SELF_REF);
  await git(top, ['push', '--porcelain', `--force-with-lease=refs/heads/ateam/${name}:${expect}`, remote, `${SELF_REF}:refs/heads/ateam/${name}`], { timeout: 300000 });
  if (oid) await git(top, ['update-ref', peerRef, oid]); // 记下远程现在是哪一份，下次推送按它核对
}

// 拉取所有 ateam/* 分支到 refs/ateam/peers/，远程删掉的分支本地也删
export async function fetchPeers({ top, remote }) {
  await git(top, ['fetch', '--prune', '--no-tags', '--quiet', remote, `+refs/heads/ateam/*:${PEER_PREFIX}*`], { timeout: 300000 });
}

// 读拉下来的同事看板。cache：oid → 解析结果，没变的分支不重读
export async function readPeers({ top, self, cache = new Map() }) {
  let out = '';
  try { out = await git(top, ['for-each-ref', '--format=%(refname) %(objectname) %(committerdate:unix)', PEER_PREFIX]); } catch { return []; }
  const peers = [];
  for (const line of out.trim().split('\n').filter(Boolean)) {
    const [ref, oid, at] = line.split(' ');
    const name = ref.slice(PEER_PREFIX.length);
    if (name === self) continue;
    if (!cache.has(oid)) {
      const entry = { name, oid };
      try {
        entry.meta = JSON.parse(await git(top, ['cat-file', '-p', `${oid}:sync.json`]));
        if ((entry.meta.format ?? 0) > SYNC_FORMAT) entry.newer = true;
        else entry.board = JSON.parse(await git(top, ['cat-file', '-p', `${oid}:board.json`]));
      } catch (err) { entry.error = '读不出这份看板数据'; }
      cache.set(oid, entry);
    }
    peers.push({ ...cache.get(oid), at: Number(at) * 1000 });
  }
  return peers;
}

// 开启同步前：远程有没有同名分支？是这台电脑、这个项目目录以前推的就接着用（自己的分支从那里接上），不是就报名字被占用。
// 只比电脑名不够：同一台电脑上两个项目目录（两份克隆）用了同一个名字，会互相覆盖
export async function claimName({ top, remote, name, project }) {
  await fetchPeers({ top, remote });
  const theirs = await refOid(top, `${PEER_PREFIX}${name}`);
  if (!theirs) return { fresh: true };
  let meta = {};
  try { meta = JSON.parse(await git(top, ['cat-file', '-p', `${theirs}:sync.json`])); } catch {}
  if (meta.host && meta.host !== hostname()) throw new Error(`同步名字「${name}」已被另一台电脑（${meta.host}）使用，请换一个名字。`);
  if (meta.project && project && meta.project !== project) throw new Error(`同步名字「${name}」已被这台电脑上的另一个项目目录（${meta.project}）使用，请换一个名字。`);
  // 本地还没有自己的看板提交就从远程那份接上（内容一样时不用重新推）；推送时按远程那份核对后覆盖
  if (!(await refOid(top, SELF_REF))) await git(top, ['update-ref', SELF_REF, theirs]);
  return { fresh: false };
}

// 看板文件（board.json、archive/、demos/）还在仓库里被跟踪吗。rel 是 .ateam 相对仓库根的路径
export async function trackedBoardFiles({ top, rel }) {
  try {
    const out = await git(top, ['ls-tree', '-r', '--name-only', 'HEAD', '--', `${rel}/board.json`, `${rel}/archive`, `${rel}/demos`]);
    return out.trim().split('\n').filter(Boolean);
  } catch { return []; }
}

// 迁移：不再在仓库里跟踪看板文件（本地文件保留），.ateam/.gitignore 加上这几项，在当前分支上提交这一处改动。
// 用临时暂存区从 HEAD 生成提交：不能用 git commit --only，它会按工作区把还在的看板文件重新加回去；
// 也不能直接提交真正的暂存区，里面可能有 worker 暂存了一半的改动。提交后真正的暂存区只同步这几个路径
export async function untrackBoardFiles({ top, rel, dataDir, name }) {
  const paths = [`${rel}/board.json`, `${rel}/archive`, `${rel}/demos`];
  const files = await trackedBoardFiles({ top, rel });
  if (!files.length) {
    // 提交已在上次完成、只差暂存区没同步（例如上次在这一步中断）：补上这一步
    const staged = (await git(top, ['ls-files', '--', ...paths])).trim();
    if (staged) await git(top, ['reset', '-q', 'HEAD', '--', ...paths, `${rel}/.gitignore`]);
    return { nothing: true };
  }
  const ignore = join(dataDir, '.gitignore');
  const have = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  const lines = have.split(/\r?\n/).map((l) => l.trim());
  const want = ['board.json', 'archive/', 'demos/'].filter((w) => !lines.includes(w));
  const add = [...(lines.includes(SYNC_MARK) ? [] : [SYNC_MARK]), ...want];
  if (add.length) writeFileSync(ignore, `${have}${have && !have.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
  const blob = (await git(top, ['hash-object', '-w', '--no-filters', ignore])).trim();
  const head = (await git(top, ['rev-parse', 'HEAD'])).trim();
  const index = join(tmpdir(), `ateam-untrack-${process.pid}-${Date.now()}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(top, ['read-tree', head], { env });
    await git(top, ['rm', '--cached', '-r', '--quiet', '--ignore-unmatch', '--', ...paths], { env });
    await git(top, ['update-index', '--add', '--cacheinfo', `100644,${blob},${rel}/.gitignore`], { env });
    const tree = (await git(top, ['write-tree'], { env })).trim();
    const msg = `chore(ateam): 看板改为通过 ateam/${name} 分支同步，不再随代码提交`;
    const commit = (await git(top, ['commit-tree', tree, '-p', head, '-m', msg])).trim();
    await git(top, ['update-ref', '-m', msg, 'HEAD', commit, head]);
  } finally {
    rmSync(index, { force: true });
  }
  // 真正的暂存区：只改这几个路径，和新提交一致
  // 用 reset 而不是 rm --cached：暂存区里的看板文件可能有和工作区、HEAD 都不同的暂存内容，rm 会拒绝
  await git(top, ['reset', '-q', 'HEAD', '--', ...paths, `${rel}/.gitignore`]);
  const sha = (await git(top, ['rev-parse', '--short', 'HEAD'])).trim();
  return { sha, count: files.length };
}

export const thisHost = () => hostname();

// 用哪个远程：仓库里有 want 就用它；want 是默认的 origin 而仓库没有 origin、只有一个远程时，用那一个；其余情况原样返回（开启时报找不到远程）
export async function pickRemote(top, want) {
  let list = [];
  try { list = (await git(top, ['remote'])).split('\n').map((l) => l.trim()).filter(Boolean); } catch { return want; }
  if (list.includes(want)) return want;
  if (want === 'origin' && list.length === 1) return list[0];
  return want;
}

// 同步名字的默认值：git 用户名转成小写短名
export async function defaultName(top) {
  try { return slugName((await git(top, ['config', 'user.name'])).trim()) || slugName(hostname()); } catch { return slugName(hostname()); }
}
