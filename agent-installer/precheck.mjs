// 发布前检查（release.sh 打包前运行，任何一项不过就不发布）：
//   1. bin/、src/ 下所有 .js 和看板页面里的脚本能通过 node --check；
//   2. README、skills、看板说明、命令输出里提到的 `ateam <子命令>` 都是存在的命令。
// 用法：node agent-installer/precheck.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const problems = [];
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

// 1. 语法
const scripts = [...walk(join(ROOT, 'bin')), ...walk(join(ROOT, 'src'))].filter((f) => /\.(m?js)$/.test(f));
for (const f of scripts) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (err) { problems.push(`语法错误 ${relative(ROOT, f)}：${String(err.stderr).split('\n').slice(0, 4).join(' ')}`); }
}
const html = readFileSync(join(ROOT, 'src', 'dashboard.html'), 'utf8');
const inline = [...html.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].map((m) => m[1]);
const tmp = mkdtempSync(join(tmpdir(), 'ateam-precheck-'));
inline.forEach((code, i) => {
  const f = join(tmp, `dashboard-${i}.js`);
  writeFileSync(f, code);
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (err) { problems.push(`看板页面第 ${i + 1} 段脚本语法错误：${String(err.stderr).split('\n').slice(0, 4).join(' ')}`); }
});
rmSync(tmp, { recursive: true, force: true });

// 2. 文档里提到的命令
const cli = readFileSync(join(ROOT, 'bin', 'ateam.js'), 'utf8');
const body = cli.slice(cli.indexOf('const commands = {'));
// leader、worker 是角色名（「ateam leader」「ateam worker」），不是命令
const known = new Set(['help']);
const ROLE_WORDS = new Set(['leader', 'worker']);
for (const m of body.matchAll(/^ {2}(?:async )?'?([a-z][a-z-]*)(?: [a-z-]+)?'?\(/gm)) known.add(m[1]);
const docs = [join(ROOT, 'README.md'), join(ROOT, 'src', 'dashboard.html'), join(ROOT, 'src', 'format.js'), join(ROOT, 'docs', 'worker-hook-setup.md'),
  ...walk(join(ROOT, 'skills')).filter((f) => f.endsWith('.md'))];
for (const f of docs) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/(?<![\w/-])ateam ([a-z][a-z-]*)\b/g)) {
    if (!known.has(m[1]) && !ROLE_WORDS.has(m[1])) problems.push(`${relative(ROOT, f)} 提到了不存在的命令「ateam ${m[1]}」`);
  }
}

const unique = [...new Set(problems)];
if (unique.length) {
  console.error(`发布前检查没有通过（${unique.length} 项）：\n${unique.map((p) => `  ✗ ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`发布前检查通过：${scripts.length} 个脚本和看板页面语法正确，文档里提到的命令都存在（共 ${known.size} 个命令）。`);
