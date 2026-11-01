// 自检：服务启动时跑一遍，ateam doctor 也能手动跑。查的是「出了问题不会报错、只会悄悄做错」的地方，
// 比如这台机器的 git 在某种路径写法下漏暂存新文件（以前 worker 的新文件漏交就是这个）。
// 返回 [{ key, ok, title, detail, fix? }]，ok 为 false 的看板上会提示；有 fix 的看板上能一键修复
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitPaths } from './git.js';

const sh = (cwd, args) => new Promise((ok, fail) => execFile('git', args, { cwd }, (err, stdout) => (err ? fail(err) : ok(stdout))));

// 在临时仓库里按 worker 提交的方式交一次：深层新文件、目录写成 dir/、直接写文件路径、删除。全进提交才算过
async function checkCommit() {
  const dir = mkdtempSync(join(tmpdir(), 'ateam-doctor-'));
  try {
    await sh(dir, ['init', '-q']);
    await sh(dir, ['config', 'user.email', 'doctor@ateam']);
    await sh(dir, ['config', 'user.name', 'ateam doctor']);
    for (const f of ['a/old.txt', 'b/gone.txt', '.ateam/board.json']) {
      mkdirSync(join(dir, f, '..'), { recursive: true });
      writeFileSync(join(dir, f), '1\n');
    }
    await sh(dir, ['add', '-A']);
    await sh(dir, ['commit', '-qm', 'init']);
    const want = ['a/old.txt', 'a/x/y/New.java', 'docs/p/Deep.md', 'b/gone.txt'];
    writeFileSync(join(dir, 'a/old.txt'), '2\n');
    mkdirSync(join(dir, 'a/x/y'), { recursive: true });
    writeFileSync(join(dir, 'a/x/y/New.java'), 'n\n');
    mkdirSync(join(dir, 'docs/p'), { recursive: true });
    writeFileSync(join(dir, 'docs/p/Deep.md'), 'n\n');
    rmSync(join(dir, 'b/gone.txt'));
    writeFileSync(join(dir, '.ateam/board.json'), '2\n');
    const result = await commitPaths(dir, ['a/', 'docs/p/Deep.md', 'b'], 'doctor');
    const got = (await sh(dir, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').filter(Boolean);
    const missing = want.filter((f) => !got.includes(f));
    const leaked = got.filter((f) => f.startsWith('.ateam/'));
    if (missing.length || leaked.length || result.leftover?.length) {
      return { ok: false, detail: `漏交 ${missing.join('、') || '无'}；误交 ${leaked.join('、') || '无'}。worker 提交时文件可能会漏掉，请把这条告诉 ateam 的维护者。` };
    }
    return { ok: true, detail: '新文件、深层新文件、删除都能正确提交，.ateam 不会混进去' };
  } catch (err) {
    return { ok: false, detail: `跑不起来：${err.message}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runDoctor({ root, install, multi = false }) {
  const out = [];
  let gitVersion = '';
  try { gitVersion = (await sh(root, ['--version'])).trim(); } catch {}
  out.push({ key: 'git', ok: !!gitVersion, title: 'git', detail: gitVersion || '找不到 git 命令' });
  if (gitVersion) out.push({ key: 'commit', title: 'worker 提交', ...(await checkCommit()) });

  // 多仓库项目：项目目录本身不是仓库，.ateam 不会被提交，不用查
  if (multi) {
    out.push({ key: 'ignore', title: '.ateam 的提交范围', ok: true, detail: '多仓库项目：项目目录不属于任何仓库，.ateam 不会被提交' });
  } else {
    const ignore = join(root, '.ateam', '.gitignore');
    const ignored = existsSync(ignore) ? readFileSync(ignore, 'utf8').split(/\r?\n/).map((l) => l.trim()) : [];
    out.push({
      key: 'ignore', title: '.ateam 的提交范围', ok: ignored.includes('runtime.json'), fix: true,
      detail: ignored.includes('runtime.json') ? 'board.json、demos/、archive/ 提交；runtime.json、端口文件不提交' : '.ateam/.gitignore 中缺少 runtime.json，worker 运行状态会被提交进仓库。可在看板「待处理」中点击「修复」补全',
    });
  }

  // 测试用的浏览器（可选）：装了 browser-cdp-setup 才检查
  if (install && install.browserSkill !== 'missing') {
    const configured = Object.entries(install.cdpConfigured).filter(([, v]) => v).map(([p]) => p);
    out.push({
      key: 'cdp', title: '测试浏览器配置', ok: configured.length > 0, fix: true,
      detail: configured.length ? `DeepSeek Harness 的 ${configured.join('、')} 配好了 dsh-cdp 的 dataDir` : '已安装 browser-cdp-setup，但 DeepSeek Harness 配置中未设置 dsh-cdp 的 dataDir。可在看板「待处理」中点击「修复」写入配置（之后需重启 DeepSeek Harness）；如仅使用 WorkBuddy 的 test worker，可删除该 skill',
    });
    const port = join(install.home, '.chrome-agent', 'DevToolsActivePort');
    out.push({
      key: 'chrome', title: '测试专用 Chrome', ok: true,
      detail: existsSync(port) ? '开过（~/.chrome-agent）' : '还没开过，test worker 开工时会自己打开',
    });
  }
  return out;
}

export function formatDoctor(checks) {
  const lines = ['# ateam 自检', ''];
  for (const c of checks) lines.push(`- ${c.ok ? '✓' : '✗'} ${c.title}：${c.detail}`);
  const bad = checks.filter((c) => !c.ok).length;
  lines.push('', bad ? `${bad} 项有问题。` : '全部正常。');
  return lines.join('\n');
}
