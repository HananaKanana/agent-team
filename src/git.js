// 服务端在项目根执行 git。全部用 execFile，不经过 shell。
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK_RETRIES = 3;
const LOCK_WAIT_MS = 500;

function run(root, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: root }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

// index.lock 冲突（比如 leader 同时在执行 git）时短暂等待后重试
async function git(root, args) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run(root, args);
    } catch (err) {
      if (attempt < LOCK_RETRIES && /index\.lock/.test(err.stderr ?? '')) {
        await new Promise((r) => setTimeout(r, LOCK_WAIT_MS));
        continue;
      }
      throw err;
    }
  }
}

export async function ensureGitRepo(root) {
  try {
    await run(root, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new Error('当前目录不是 git 仓库。请先运行 git init。');
  }
}

export function ensureGitignore(root) {
  const file = join(root, '.gitignore');
  const content = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = content.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes('.ateam/') || lines.includes('.ateam')) return;
  const prefix = content && !content.endsWith('\n') ? '\n' : '';
  appendFileSync(file, `${prefix}.ateam/\n`);
}

// 只提交 paths 内的改动。不存在的路径跳过（任务首次提交时目录可能还没建）。
export async function commitPaths(root, paths, message) {
  const valid = [];
  for (const p of paths) {
    try {
      await git(root, ['add', '-A', '--', p]);
      valid.push(p);
    } catch (err) {
      if (/did not match any files|are ignored by one of your \.gitignore/.test(err.stderr ?? '')) continue;
      throw gitError('git add', err);
    }
  }
  // 只保留确实有暂存改动的路径：空目录、只含被忽略文件的目录 git add 不报错，
  // 但放进 git commit 的路径参数会报 pathspec 不匹配
  const changed = [];
  for (const p of valid) {
    try {
      await git(root, ['diff', '--cached', '--quiet', '--', p]);
    } catch (err) {
      if (err.code !== 1) throw gitError('git diff', err);
      changed.push(p);
    }
  }
  if (changed.length === 0) return { nothing: true };

  try {
    await git(root, ['commit', '-m', message, '--', ...changed]);
    const { stdout } = await git(root, ['rev-parse', '--short', 'HEAD']);
    return { sha: stdout.trim() };
  } catch (err) {
    throw gitError('git commit', err);
  }
}

// 任务路径内未提交改动（含新文件）的最新修改时间，没有改动时返回 null。
// 用作 worker 的「活动心跳」：worker 在写代码，文件就在变；token 用完窗口停了，文件也就不变了。
export async function latestChangeTime(root, paths) {
  const { stdout } = await run(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths]);
  const entries = stdout.split('\0');
  let latest = null;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    if (entry[0] === 'R' || entry[0] === 'C') i++; // 重命名后面跟着原路径
    try {
      const { mtimeMs } = await stat(join(root, entry.slice(3)));
      if (latest === null || mtimeMs > latest) latest = mtimeMs;
    } catch {
      // 已删除的文件没有修改时间，忽略
    }
  }
  return latest === null ? null : Math.floor(latest);
}

function gitError(step, err) {
  const detail = (err.stderr || err.stdout || err.message || '').trim();
  return new Error(`${step} 失败：${detail}`);
}
