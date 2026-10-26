// 服务端执行 git。全部用 execFile，不经过 shell。
//
// 支持两种布局：
// - 单仓库：项目目录本身在一个 git 仓库里（最常见）。
// - 多仓库：项目目录不是仓库，但下面一层有若干仓库，比如 myapp/ 下的 web/、api/。
// 任务路径都相对于项目目录写；提交时按路径找到它所属的仓库，在那个仓库里提交。
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

const LOCK_RETRIES = 3;
const LOCK_WAIT_MS = 500;

function run(cwd, args) {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolvePromise({ stdout, stderr });
      }
    });
  });
}

// index.lock 冲突（比如 leader 同时在执行 git）时短暂等待后重试
async function git(cwd, args) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run(cwd, args);
    } catch (err) {
      if (attempt < LOCK_RETRIES && /index\.lock/.test(err.stderr ?? '')) {
        await new Promise((r) => setTimeout(r, LOCK_WAIT_MS));
        continue;
      }
      throw err;
    }
  }
}

async function repoTop(dir) {
  try {
    const { stdout } = await run(dir, ['rev-parse', '--show-toplevel']);
    return stdout.trim();
  } catch {
    return null;
  }
}

// 返回 { mode: 'single', top } 或 { mode: 'multi', repos: ['api', 'web'] }；两种都不是就报错
export async function detectRepos(root) {
  const top = await repoTop(root);
  if (top) return { mode: 'single', top };
  const repos = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (existsSync(join(root, entry.name, '.git'))) repos.push(entry.name);
  }
  if (repos.length === 0) {
    throw new Error('当前目录不是 git 仓库，下面一层也没有 git 仓库。请先运行 git init，或者在包含多个仓库的上级目录里启动。');
  }
  return { mode: 'multi', repos: repos.sort() };
}

// 兼容旧调用：只检查，不关心布局
export async function ensureGitRepo(root) {
  await detectRepos(root);
}

// 第一次在项目里启动时把 .ateam/ 加进项目的 .gitignore，只加这一次：
// 在 .ateam/ 里留一个标记，之后用户从 .gitignore 删掉这一行（想把 .ateam/ 提交进仓库）就不再加回去。
// 不管提不提交，.ateam/ 里都放一份自己的 .gitignore，排除端口文件和写盘的临时文件。
export function ensureGitignore(root) {
  const dir = join(root, '.ateam');
  mkdirSync(dir, { recursive: true });
  const own = join(dir, '.gitignore');
  if (!existsSync(own)) writeFileSync(own, '# ateam 自动生成：端口和临时文件不提交\nport\n*.tmp\n');
  const marker = join(dir, 'gitignore-added');
  if (existsSync(marker)) return;
  // 已经跑过 ateam 的老项目（有状态文件）：当年已经加过，用户现在没有这一行就是自己删的，尊重它
  if (existsSync(join(dir, 'state.json'))) {
    writeFileSync(marker, '已经把 .ateam/ 加过项目的 .gitignore。想提交 .ateam/ 就从 .gitignore 删掉那一行，ateam 不会再加回去。\n');
    return;
  }
  const file = join(root, '.gitignore');
  const content = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = content.split(/\r?\n/).map((l) => l.trim());
  if (!lines.includes('.ateam/') && !lines.includes('.ateam')) {
    const prefix = content && !content.endsWith('\n') ? '\n' : '';
    appendFileSync(file, `${prefix}.ateam/\n`);
  }
  writeFileSync(marker, '已经把 .ateam/ 加过项目的 .gitignore。想提交 .ateam/ 就从 .gitignore 删掉那一行，ateam 不会再加回去。\n');
}
// 把任务路径（相对于项目目录）按所属仓库分组：Map<仓库根, { label, paths: 相对于仓库根的路径[] }>
// 路径可能还不存在（首次提交前目录没建），就往上找最近的已存在目录来判断仓库。
// 不属于任何仓库的路径跳过。label 是仓库相对于项目目录的位置（单仓库时为空串）。
async function groupByRepo(root, paths) {
  const realRoot = realpathSync(root);
  const groups = new Map();
  for (const p of paths) {
    const abs = resolve(realRoot, p);
    let existing = abs;
    while (!existsSync(existing) && existing !== dirname(existing)) existing = dirname(existing);
    let probe = existing;
    try {
      if (!(await stat(existing)).isDirectory()) probe = dirname(existing);
    } catch {
      continue;
    }
    const top = await repoTop(probe);
    if (!top) continue;
    const realTop = realpathSync(top);
    // 真实路径：existing 部分取 realpath，剩下还不存在的部分原样接上
    const realAbs = join(realpathSync(existing), relative(existing, abs));
    let rel = relative(realTop, realAbs) || '.';
    if (p.endsWith('/') && rel !== '.') rel += '/';
    if (rel.startsWith('..')) continue;
    if (!groups.has(realTop)) {
      const label = relative(realRoot, realTop);
      groups.set(realTop, { label: label.startsWith('..') ? '' : label.split(sep).join('/'), paths: [] });
    }
    groups.get(realTop).paths.push(rel);
  }
  return groups;
}

// 在一个仓库里只提交 paths 内的改动，返回短提交号或 null（没有改动）
async function commitInRepo(top, paths, message, exclude = []) {
  const valid = [];
  // .ateam 原来有没有暂存的改动（leader 自己暂存的）：有就不碰，没有的话下面 add 带进来的再撤掉
  const ateam = exclude.length ? exclude[0].replace(':(exclude)', '') : null;
  const ateamStaged = ateam ? await git(top, ['diff', '--cached', '--quiet', '--', ateam]).then(() => false, () => true) : true;
  for (const p of paths) {
    try {
      // git add 不带 :(exclude)：带了以后，目录路径写成「xxx/」（结尾带斜杠）时 git 会漏掉里面的新文件
      // （git 2.54 实测：git add -A -- dir/ ':(exclude).ateam' 不加未跟踪文件）。.ateam 在下面单独撤出暂存区
      await git(top, ['add', '-A', '--', p]);
      valid.push(p);
    } catch (err) {
      // 找不到文件不一定是没改动：worker 用 git rm 删掉的路径，磁盘和暂存区里都没有了，git add 会报
      // did not match any files，但删除已经暂存好了。照样留下，交给下面的 diff --cached 判断有没有暂存改动
      if (/did not match any files|are ignored by one of your \.gitignore/.test(err.stderr ?? '')) {
        valid.push(p);
        continue;
      }
      throw gitError('git add', err);
    }
  }
  if (!ateamStaged) await git(top, ['reset', '-q', '--', ateam]).catch(() => {});
  // 只保留确实有暂存改动的路径：空目录、只含被忽略文件的目录 git add 不报错，
  // 但放进 git commit 的路径参数会报 pathspec 不匹配
  const changed = [];
  for (const p of valid) {
    try {
      await git(top, ['diff', '--cached', '--quiet', '--', p, ...exclude]);
    } catch (err) {
      if (err.code !== 1) throw gitError('git diff', err);
      changed.push(p);
    }
  }
  if (changed.length === 0) return null;

  try {
    await git(top, ['commit', '-m', message, '--', ...changed, ...exclude]);
    const { stdout } = await git(top, ['rev-parse', '--short', 'HEAD']);
    return stdout.trim();
  } catch (err) {
    throw gitError('git commit', err);
  }
}

// 只提交 paths 内的改动，每个涉及的仓库各提交一次。
// 返回 { commits: ['a1b2c3d'] }（单仓库）或 { commits: ['api@a1b2c3d', ...] }（多仓库）；都没有改动时返回 { nothing: true }。
// worker 的提交永远不带上 .ateam/：用户可能把 .ateam/ 提交进仓库，任务路径写得宽（比如 .）时
// 会把看板状态一起带进 worker 的提交
export async function commitPaths(root, paths, message) {
  const groups = await groupByRepo(root, paths);
  const realRoot = realpathSync(root);
  const commits = [];
  const leftover = [];
  for (const [top, { label, paths: repoPaths }] of groups) {
    const rel = relative(top, join(realRoot, '.ateam')).split(sep).join('/');
    const exclude = rel && !rel.startsWith('..') ? [`:(exclude)${rel}`] : [];
    const sha = await commitInRepo(top, repoPaths, message, exclude);
    if (sha) commits.push(label ? `${label}@${sha}` : sha);
    // 提交后路径里还有没进提交的改动（不该有）：列出来，让 worker 和 leader 知道，别悄悄漏掉
    const { stdout } = await run(top, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...repoPaths, ...exclude]);
    for (const line of stdout.split('\n').filter(Boolean)) leftover.push((label ? `${label}/` : '') + line.slice(3));
  }
  if (!commits.length) return { nothing: true, leftover };
  return leftover.length ? { commits, leftover } : { commits };
}

// 任务路径内未提交改动（含新文件）的最新修改时间，没有改动时返回 null。
// 用作 worker 的「活动心跳」：worker 在写代码，文件就在变；token 用完窗口停了，文件也就不变了。
export async function latestChangeTime(root, paths) {
  const groups = await groupByRepo(root, paths);
  const realRoot = realpathSync(root);
  let latest = null;
  for (const [top, { paths: repoPaths }] of groups) {
    // 看板状态文件一直在变，不算 worker 的活动
    const rel = relative(top, join(realRoot, '.ateam')).split(sep).join('/');
    const exclude = rel && !rel.startsWith('..') ? [`:(exclude)${rel}`] : [];
    const { stdout } = await run(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...repoPaths, ...exclude]);
    const entries = stdout.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.length < 4) continue;
      if (entry[0] === 'R' || entry[0] === 'C') i++; // 重命名后面跟着原路径
      try {
        // porcelain 输出的路径相对于仓库根
        const { mtimeMs } = await stat(join(top, entry.slice(3)));
        if (latest === null || mtimeMs > latest) latest = mtimeMs;
      } catch {
        // 已删除的文件没有修改时间，忽略
      }
    }
  }
  return latest === null ? null : Math.floor(latest);
}

// 文件在所属仓库 HEAD 里的内容（path 相对项目目录），没有提交过返回 null
export async function headContent(root, path) {
  const [entry] = await groupByRepo(root, [path]);
  if (!entry) return null; // 不在任何仓库里
  const [top, { paths }] = entry;
  try {
    const { stdout } = await run(top, ['show', `HEAD:${paths[0].split(sep).join('/')}`]);
    return stdout;
  } catch {
    return null;
  }
}

function gitError(step, err) {
  const detail = (err.stderr || err.stdout || err.message || '').trim();
  return new Error(`${step} 失败：${detail}`);
}
