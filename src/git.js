// 服务端在项目根执行 git。全部用 execFile，不经过 shell。
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
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

// index.lock 冲突（比如主管同时在执行 git）时短暂等待后重试
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
  if (valid.length === 0) return { nothing: true };

  try {
    await git(root, ['diff', '--cached', '--quiet', '--', ...valid]);
    return { nothing: true };
  } catch (err) {
    if (err.code !== 1) throw gitError('git diff', err);
  }

  try {
    await git(root, ['commit', '-m', message, '--', ...valid]);
    const { stdout } = await git(root, ['rev-parse', '--short', 'HEAD']);
    return { sha: stdout.trim() };
  } catch (err) {
    throw gitError('git commit', err);
  }
}

function gitError(step, err) {
  const detail = (err.stderr || err.stdout || err.message || '').trim();
  return new Error(`${step} 失败：${detail}`);
}
