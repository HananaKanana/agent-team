// 发布前检查（release.sh 打包前运行，任何一项不过就不发布）：
//   1. bin/、src/ 下所有 .js（含看板 src/dashboard/js）能通过 node --check，看板的样式和模块都会被加载；
//   2. README、skills、看板说明、命令输出里提到的 `ateam <子命令>` 都是存在的命令。
// 用法：node agent-installer/precheck.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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
// 看板：脚本已在上面随 src/ 一起检查。样式都要被 index.html 引用；脚本是 ES 模块，从 index.html 加载的入口沿 import 走，
// 每个模块都要走得到（走不到的不会加载），导入的文件都要存在
const DASH = join(ROOT, 'src', 'dashboard');
const html = readFileSync(join(DASH, 'index.html'), 'utf8');
const linked = [...html.matchAll(/(?:href|src)="\/((?:css|js)\/[^"]+)"/g)].map((m) => m[1]);
for (const f of linked) if (!existsSync(join(DASH, f))) problems.push(`看板 index.html 引用的 ${f} 不存在`);
const reached = new Set();
const follow = (f) => {
  if (reached.has(f) || !existsSync(join(DASH, f))) return;
  reached.add(f);
  for (const m of readFileSync(join(DASH, f), 'utf8').matchAll(/^import [\s\S]*? from '\.\/([a-z0-9-]+\.js)';$/gm)) {
    const g = `js/${m[1]}`;
    if (!existsSync(join(DASH, g))) problems.push(`看板 ${f} 导入的 ${g} 不存在`);
    follow(g);
  }
};
linked.filter((f) => f.startsWith('js/')).forEach(follow);
for (const f of walk(DASH).map((x) => relative(DASH, x).split(sep).join('/')).filter((x) => /^(css|js)\//.test(x))) {
  if (f.startsWith('css/') ? !linked.includes(f) : !reached.has(f)) problems.push(`看板 ${f} 没有被加载（${f.startsWith('css/') ? 'index.html 里没有引用' : '入口模块沿 import 走不到'}）`);
}
if (!html.includes('<!-- ateam:prefs -->')) problems.push('看板 index.html 缺少 <!-- ateam:prefs -->（服务在这里写入显示偏好）');

// 2. 文档里提到的命令
const cli = readFileSync(join(ROOT, 'bin', 'ateam.js'), 'utf8');
const body = cli.slice(cli.indexOf('const commands = {'));
// leader、worker 是角色名（「ateam leader」「ateam worker」），不是命令
const known = new Set(['help']);
const ROLE_WORDS = new Set(['leader', 'worker']);
for (const m of body.matchAll(/^ {2}(?:async )?'?([a-z][a-z-]*)(?: [a-z-]+)?'?\(/gm)) known.add(m[1]);
const docs = [join(ROOT, 'README.md'), ...walk(DASH).filter((f) => /\.(html|js)$/.test(f)), join(ROOT, 'src', 'format.js'), join(ROOT, 'docs', 'worker-hook-setup.md'),
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
