#!/usr/bin/env node
// ateam 命令行：leader 和 worker 与服务交互的唯一方式。输出是给大模型读的 markdown 文本。
// 退出码：0 成功；1 业务错误；2 服务不可达。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import {
  formatCards, formatError, formatEventLine, formatEvents, formatJob, formatJobs, formatStatus, formatTask, formatWait,
} from '../src/format.js';

// 服务地址：ATEAM_URL 优先；否则从当前目录往上找 .ateam/port（serve 启动时写下的实际端口，
// 7700 被别的项目占用时会自动换成 7701、7702……）；都没有就用 7700。
function findPortFile(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const file = join(d, '.ateam', 'port');
    if (existsSync(file)) return file;
    if (d === dirname(d)) return null;
  }
}
function defaultBase() {
  const file = findPortFile(process.cwd());
  const port = file && Number(readFileSync(file, 'utf8').trim());
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : 7700}`;
}
const BASE = (process.env.ATEAM_URL || defaultBase()).replace(/\/+$/, '');
const RETRY_MS = Number(process.env.ATEAM_RETRY_SEC || 60) * 1000;
const RETRY_INTERVAL_MS = 2000;
const RETRYABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE']);
const DEFAULT_HOLD_SEC = 90;

const BOOLEAN_FLAGS = new Set(['follow', 'no-changes', 'all', 'user-approved', 'after-task', 'top', 'off', 'todo', 'demo', 'slow', 'stuck']);
const REPEATABLE_FLAGS = new Set(['accept']);

const USAGE = `用法：ateam <命令> [参数]

服务
  ateam serve [--port 7700] [--lease 15] [--idle 3]

worker
  ateam join --role <角色> [--id <编号>] [--name <名字>]
  ateam wait --as <ID> [--timeout 90] [--round N]
  ateam progress --as <ID> "<笔记>" [--expect <分钟>]
  ateam ask --as <ID> "<问题>"
  ateam submit --as <ID> "<总结>" [--no-changes]
  ateam demo step --as <ID> 3/12 "<这一步做什么>" [--slow]
  ateam demo end --as <ID> "<结果>" [--stuck]
  ateam demo save --as <ID> "<改了哪些操作记录>" [--no-changes]

leader
  ateam job new "<标题>" [--desc-file f.md] [--origin-file 用户原话.md] [--demo]
  ateam demo add --job J1 --title "..." --script docs/demo/x.md [--role test]
  ateam job edit J1 [--title "..."] [--desc-file f.md] [--origin-file f.md（只能给没有原话的老需求补）]
  ateam job accept J1 [J2...]
  ateam job hold J1 ["<原因>"] [--off]（整个需求暂停 / 恢复领取，用户要求时用）
  ateam job cancel J1 ["<原因>"] [--user-approved]（作废整个需求，必须用户明确同意）
  ateam task add --job J1 --role <角色> --paths a/,b/ [--after T1,T2] --title "..." [--desc-file t.md] [--accept "..."]... [--top]
  ateam task top T3 [--off]
  ateam task hold T3 ["<原因>"] [--off]（暂停 / 恢复领取，用户要求时用）
  ateam task edit T3 [--title "..."] [--role <角色>] [--desc-file f.md] [--accept "..."]... [--paths ...] [--after ...]
  ateam release T3
  ateam cancel T3 ["<原因>"]
  ateam reclaim T3 ["<原因>"]
  ateam dismiss <编号>... | --role <角色> | --all [--after-task] [--user-approved]
  ateam watch [--timeout 90] [--follow]
  ateam approve T3 ["<备注>"]
  ateam reject T3 "<修改意见>"
  ateam answer T3 "<答复>"
  ateam status [--job J1 | --all]
  ateam cards [--job J1] [--todo]
  ateam critique --as <ID> ok T5 [T6 ...] ／ issue T5 "<问题和建议>" --basis "<依据>" [--because "<重新审的原因>"]
  ateam critique agree T5 "<打算怎么改>" --basis "<依据>" ／ dispute T5 "<为什么不改>" --basis "<依据>" ／ done T5 "<改了什么>"
  ateam note T5 "<给正在做的 worker 的补充说明>"
  ateam rules [--role <角色>] | add "<一条规则>" [--role a,b] [--user-approved] | set --file rules.md [--user-approved]（改规则必须用户同意）
  ateam jobs [--all] [--grep <关键词>]
  ateam job show J1
  ateam show T3
  ateam report --job J1 --file report.md

服务地址：ATEAM_URL 优先，否则用项目里 .ateam/port 记下的端口（serve 自动选的），都没有就是 http://127.0.0.1:7700。`;

class CliError extends Error {}

function fail(message) {
  throw new CliError(message);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--') || arg === '--') {
      positional.push(arg);
      continue;
    }
    let name = arg.slice(2);
    let value;
    const eq = name.indexOf('=');
    if (eq >= 0) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) fail(`参数 --${name} 缺少值。运行 ateam help 查看用法。`);
    }
    if (REPEATABLE_FLAGS.has(name)) (flags[name] ??= []).push(value);
    else flags[name] = value;
  }
  return { flags, positional };
}

const splitList = (value) => String(value).split(',').map((s) => s.trim()).filter(Boolean);

function readTextFile(path, flag) {
  try {
    return readFileSync(resolve(process.cwd(), path), 'utf8');
  } catch {
    fail(`读取 ${flag} 指定的文件失败：${path}。请确认文件路径（相对当前目录）。`);
  }
}

function requireAs(flags) {
  if (!flags.as) fail('缺少 --as <worker 编号>。如果还没加入团队，请先运行 ateam join --role <角色>。');
  return flags.as;
}

function requireArg(value, what, example) {
  if (!value) fail(`缺少${what}。示例：${example}`);
  return value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Unreachable extends Error {}

class ServerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// 连不上服务（或连接被重置）时每 2 秒重试，从第一次失败起累计约 60 秒。
// holdSec：wait/watch 的挂起时长；断线重连后只挂起剩余时长，总时长不超过它。
async function request(method, path, body, holdSec) {
  const started = Date.now();
  let firstFailure = null;
  for (;;) {
    if (holdSec) {
      const remaining = Math.ceil(holdSec - (Date.now() - started) / 1000);
      body = { ...body, timeout: Math.max(1, remaining) };
    }
    try {
      const res = await fetch(BASE + path, {
        method,
        // x-ateam-cli：让服务区分命令行和看板（leader 是否在线只看命令行的活动）
        headers: body ? { 'content-type': 'application/json', 'x-ateam-cli': '1' } : { 'x-ateam-cli': '1' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!data.ok) throw new ServerError(data.code, data.message);
      return data;
    } catch (err) {
      if (err instanceof ServerError) throw err;
      if (!RETRYABLE.has(err?.cause?.code ?? err?.code)) throw err;
      firstFailure ??= Date.now();
      if (Date.now() - firstFailure >= RETRY_MS) throw new Unreachable();
      await sleep(RETRY_INTERVAL_MS);
    }
  }
}

function holdSeconds(flags) {
  if (flags.timeout === undefined) return DEFAULT_HOLD_SEC;
  const sec = Number(flags.timeout);
  if (!Number.isFinite(sec) || sec <= 0) fail('--timeout 必须是正数（秒）。');
  return sec;
}

// 新任务和别的任务改同一批文件、又没有先后依赖：两个 worker 可能同时改同一个文件
function overlapWarning(task, overlaps) {
  if (!overlaps?.length) return '';
  const lines = ['', '', `⚠ 路径重叠：${task.id} 和下面的任务会改同一批文件，又没有先后依赖，可能被两个 worker 同时改：`];
  for (const t of overlaps) {
    const who = t.assignee ? `，${t.assignee} 在做` : '';
    lines.push(`- ${t.id} ${t.title}（${t.status}${who}，路径 ${t.paths.join('、')}）`);
  }
  lines.push(`同时改同一个文件，提交时会把对方改到一半的内容一起带进去，或者互相冲突。建议：用 ateam task edit ${task.id} --after ${[...new Set([...task.dependsOn, ...overlaps.map((t) => t.id)])].join(',')} 让它排在后面；或者把它们合成一个任务；确定改的是文件里互不相干的部分，也可以不管。`);
  return lines.join('\n');
}

function portFree(port) {
  return new Promise((ok) => {
    const probe = createServer();
    probe.once('error', () => ok(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => ok(true)));
  });
}

// 端口上跑的是不是 ateam、项目目录是哪个
async function ateamRootAt(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) });
    const data = await res.json();
    return data?.ok ? data.root : null;
  } catch {
    return null;
  }
}

// 从 wanted 开始找空闲端口。本项目的服务已经在跑就报错，不重复启动。
// 用 --port 明确指定的端口被占用时也报错，不自动换。
async function pickPort(wanted, explicit) {
  const here = resolve(process.cwd());
  for (let port = wanted; port < wanted + 20 && port <= 65535; port++) {
    if (await portFree(port)) return port;
    const root = await ateamRootAt(port);
    if (root && resolve(root) === here) fail(`这个项目的 ateam 服务已经在运行：http://127.0.0.1:${port}。不用再启动；要重启的话，先在原来的终端里按 Ctrl+C。`);
    if (explicit) fail(`端口 ${port} 被占用${root ? `（另一个项目 ${root} 的 ateam 服务）` : ''}。换一个端口，或者去掉 --port 让它自动找空闲端口。`);
  }
  fail(`${wanted} 到 ${wanted + 19} 的端口都被占用了。请用 --port 指定一个空闲端口。`);
}

const commands = {
  async serve({ flags }) {
    const { startServer } = await import('../src/server.js');
    const wanted = Number(flags.port ?? 7700);
    const leaseMin = Number(flags.lease ?? process.env.ATEAM_LEASE_MIN ?? 15);
    if (!Number.isInteger(wanted) || wanted <= 0 || wanted > 65535) fail('--port 必须是 1-65535 的整数。');
    const idleMin = Number(flags.idle ?? process.env.ATEAM_IDLE_MIN ?? 3);
    if (!Number.isFinite(leaseMin) || leaseMin <= 0) fail('--lease 必须是正数（分钟）。');
    if (!Number.isFinite(idleMin) || idleMin <= 0) fail('--idle 必须是正数（分钟）。');
    const port = await pickPort(wanted, flags.port !== undefined);
    let server;
    try {
      server = await startServer({ root: process.cwd(), port, leaseMin, idleMin });
    } catch (err) {
      fail(err.message);
    }
    const layout = server.ateamLayout;
    const repos = layout?.mode === 'multi'
      ? `\n多仓库模式，包含 git 仓库：${layout.repos.join('、')}（任务路径写成「仓库目录/子路径」，比如 ${layout.repos[0]}/src/）`
      : '';
    const moved = port !== wanted ? `\n端口 ${wanted} 已被占用，自动改用 ${port}。这个项目目录里的 ateam 命令会自动找到它，不用设置 ATEAM_URL。` : '';
    return `ateam 服务已启动：http://127.0.0.1:${port}（看板同地址）${moved}\n项目目录：${process.cwd()}（任务路径相对于这里，worker 的改动必须在这个目录里）${repos}`;
  },

  async join({ flags }) {
    const role = requireArg(flags.role, '角色', 'ateam join --role frontend');
    const { agent } = await request('POST', '/api/join', { role, name: flags.name ?? '', id: flags.id ?? '' });
    const named = agent.name ? `，名字 ${agent.name}` : '';
    const head = agent.rejoined
      ? `已重新加入团队，沿用原编号 **${agent.id}**（角色 ${agent.role}${named}）。之后每条命令都要带 --as ${agent.id}。`
      : `已加入团队。你的 worker 编号是 **${agent.id}**（角色 ${agent.role}${named}）。之后每条命令都要带 --as ${agent.id}。`;
    return [
      head,
      ...(agent.refused ? [`（${agent.refused}，所以分配了新编号 ${agent.id}，之后用新编号。）`] : []),
      '',
      `下一步：ateam wait --as ${agent.id}`,
    ].join('\n');
  },

  async wait({ flags }) {
    const as = requireAs(flags);
    const data = await request('POST', '/api/wait', { as }, holdSeconds(flags));
    const round = Number.parseInt(flags.round ?? '0', 10);
    return formatWait(data?.result ?? null, as, data?.waiting, Number.isFinite(round) && round > 0 ? round : 0);
  },

  async progress({ flags, positional }) {
    const as = requireAs(flags);
    const text = requireArg(positional[0], '进度笔记', `ateam progress --as ${as} "改完了 web/login.js"`);
    const { task } = await request('POST', '/api/progress', { as, text, expect: flags.expect });
    const busy = flags.expect ? `接下来 ${Math.min(Number(flags.expect), 180)} 分钟内不调用 ateam 也不会被当成停住。` : '';
    const note = task.note ? `\n\n# leader 补充说明\n\n${task.note}\n\n按这条说明调整你的做法。` : '';
    return `已记录 ${task.id} 的进度。${busy}继续工作；完成后运行：ateam submit --as ${as} "<做了什么、怎么验证的>"${note}`;
  },

  async ask({ flags, positional }) {
    const as = requireAs(flags);
    const text = requireArg(positional[0], '问题', `ateam ask --as ${as} "接口返回的日期用什么格式？"`);
    const { task } = await request('POST', '/api/ask', { as, text });
    return `已就 ${task.id} 向 leader 提问。请运行 ateam wait --as ${as} 等待答复，不要猜。`;
  },

  async submit({ flags, positional }) {
    const as = requireAs(flags);
    const summary = requireArg(positional[0], '提交总结', `ateam submit --as ${as} "完成登录页，手工验证了表单校验"`);
    const { task, commit } = await request('POST', '/api/submit', { as, summary, noChanges: !!flags['no-changes'] });
    const what = commit ? `提交 ${commit}` : '无代码改动';
    return `已提交 ${task.id}（${what}），等待 leader review。请运行：ateam wait --as ${as}`;
  },

  async 'job new'({ flags, positional }) {
    const title = requireArg(positional[0], '需求标题', 'ateam job new "用户登录"');
    const description = flags['desc-file'] ? readTextFile(flags['desc-file'], '--desc-file') : '';
    const origin = flags['origin-file'] ? readTextFile(flags['origin-file'], '--origin-file') : (flags.origin ?? '');
    const { job } = await request('POST', '/api/jobs', { title, description, origin, demo: !!flags.demo });
    if (job.demo) return `已创建演播需求 ${job.id}：${job.title}\n\n下一步：ateam demo add --job ${job.id} --title "..." --script docs/demo/<名字>.md（脚本先写好并提交）`;
    return `已创建需求 ${job.id}：${job.title}\n\n下一步：ateam task add --job ${job.id} --role <角色> --paths <路径> --title "..." --desc-file <文件> --accept "..."`;
  },

  // 用户在对话里说「J1 验收通过」时由 leader 运行；用户也可以在看板上直接点「验收通过」
  async 'job accept'({ positional }) {
    if (positional.length === 0) fail('请指定需求编号。示例：ateam job accept J1 J2');
    const { jobs } = await request('POST', '/api/jobs/accept', { ids: positional });
    return `已验收通过：${jobs.map((j) => `${j.id} ${j.title}`).join('、')}。`;
  },

  // 作废整个需求：只有用户明确要求时运行；先不带 --user-approved 看会作废哪些卡，用户同意后再带上
  async 'job cancel'({ flags, positional }) {
    const id = requireArg(positional[0], '需求编号', 'ateam job cancel J1 "方向变了，不做了" --user-approved');
    const { job, cancelled } = await request('POST', '/api/jobs/cancel', { id, text: positional[1] ?? '', userApproved: !!flags['user-approved'] });
    return `已作废需求 ${job.id}：${job.title}。连带作废 ${cancelled.length} 张卡${cancelled.length ? `：${cancelled.map((t) => t.id).join('、')}` : ''}；已通过的卡和代码保留。正在做这些卡的 worker 下次调用 ateam 时会收到停手通知。`;
  },

  async 'job edit'({ flags, positional }) {
    const jobId = requireArg(positional[0], '需求编号', 'ateam job edit J1 --desc-file job.md');
    const body = { jobId };
    if (flags.title !== undefined) body.title = flags.title;
    if (flags['desc-file'] !== undefined) body.description = readTextFile(flags['desc-file'], '--desc-file');
    if (flags['origin-file'] !== undefined) body.origin = readTextFile(flags['origin-file'], '--origin-file');
    if (body.title === undefined && body.description === undefined && body.origin === undefined) fail('请提供 --title、--desc-file 或 --origin-file。示例：ateam job edit J1 --desc-file job.md');
    const { job } = await request('POST', '/api/jobs/edit', body);
    return `已修改需求 ${job.id}：${job.title}（说明 ${job.description.length} 字）`;
  },

  async 'task add'({ flags }) {
    const body = {
      jobId: requireArg(flags.job, '需求编号 --job', 'ateam task add --job J1 ...'),
      role: requireArg(flags.role, '角色 --role', 'ateam task add --role backend ...'),
      paths: splitList(requireArg(flags.paths, '路径 --paths', 'ateam task add --paths server/ ...')),
      title: requireArg(flags.title, '任务标题 --title', 'ateam task add --title "登录接口" ...'),
      description: flags['desc-file'] ? readTextFile(flags['desc-file'], '--desc-file') : '',
      acceptance: flags.accept ?? [],
      dependsOn: flags.after ? splitList(flags.after) : [],
      top: !!flags.top,
    };
    const { task, overlaps } = await request('POST', '/api/tasks', body);
    const deps = task.dependsOn.length ? `，依赖 ${task.dependsOn.join('、')}` : '';
    const top = task.priority ? '，优先' : '';
    return `已添加任务 ${task.id}：${task.title}（角色 ${task.role}，路径 ${task.paths.join('、')}${deps}${top}，验收标准 ${task.acceptance.length} 条）${overlapWarning(task, overlaps)}`;
  },

  // 设为优先：同角色的 worker 下一个先领它；--off 取消
  async 'task top'({ flags, positional }) {
    const id = requireArg(positional[0], '任务编号', 'ateam task top T5');
    const { task } = await request('POST', '/api/tasks/priority', { id, top: !flags.off });
    if (!task.priority) return `已取消 ${task.id} 的优先，按编号顺序派发。`;
    const waiting = task.dependsOn.length ? `（它依赖 ${task.dependsOn.join('、')}，依赖通过后才会派发）` : '';
    return `已把 ${task.id} 设为优先：${task.role} 角色的 worker 下一个先领它${waiting}。正在做别的任务的 worker 不会被打断。`;
  },

  // 暂停领取：用户要求时才用。卡留在待领取但不派发，--off 恢复
  async 'task hold'({ flags, positional }) {
    const id = requireArg(positional[0], '任务编号', 'ateam task hold T5 "等接口定下来"');
    const { task } = await request('POST', '/api/tasks/hold', { id, on: !flags.off, text: positional[1] ?? '' });
    return task.onHold
      ? `已暂停 ${task.id} 的领取：卡留在待领取，worker 不会领到它（ateam task hold ${task.id} --off 恢复）。`
      : `已恢复 ${task.id} 的领取，按派发顺序派发。`;
  },

  async 'job hold'({ flags, positional }) {
    const id = requireArg(positional[0], '需求编号', 'ateam job hold J5 "先停一下，等用户确认方向"');
    const { job } = await request('POST', '/api/jobs/hold', { id, on: !flags.off, text: positional[1] ?? '' });
    return job.onHold
      ? `已暂停需求 ${job.id} 的领取：它下面待领取的卡（包括之后新加的）都不会派发；正在做的卡不受影响（ateam job hold ${job.id} --off 恢复）。`
      : `已恢复需求 ${job.id} 的领取。`;
  },

  async 'task edit'({ flags, positional }) {
    const id = requireArg(positional[0], '任务编号', 'ateam task edit T3 --desc-file t.md');
    const body = { id };
    if (flags.title !== undefined) body.title = flags.title;
    if (flags.role !== undefined) body.role = flags.role;
    if (flags['desc-file'] !== undefined) body.description = readTextFile(flags['desc-file'], '--desc-file');
    if (flags.accept !== undefined) body.acceptance = flags.accept;
    if (flags.paths !== undefined) body.paths = splitList(flags.paths);
    if (flags.after !== undefined) body.dependsOn = splitList(flags.after);
    const { task, overlaps } = await request('POST', '/api/tasks/edit', body);
    const next = task.status === 'held' ? `\n\n下一步：ateam release ${task.id}` : '';
    return `已修改任务 ${task.id}。${overlapWarning(task, overlaps)}${next}`;
  },

  async dismiss({ flags, positional }) {
    const body = { ids: positional, role: flags.role ?? '', all: !!flags.all, userApproved: !!flags['user-approved'], afterTask: !!flags['after-task'] };
    if (!body.all && !body.role && body.ids.length === 0) {
      fail('请指定要下线的 worker。示例：ateam dismiss frontend-2 ／ ateam dismiss --role frontend ／ ateam dismiss --all');
    }
    const { dismissed } = await request('POST', '/api/dismiss', body);
    if (dismissed.length === 0) return '没有符合条件的在线 worker。';
    const now = dismissed.filter((d) => !d.later);
    const later = dismissed.filter((d) => d.later);
    const lines = [];
    if (later.length) lines.push(`做完手上的任务（通过或作废）后下线，期间不领新任务：${later.map((d) => `${d.id}（${d.later}）`).join('、')}。`);
    if (!now.length) return lines.join('\n');
    lines.push(`已让 ${now.length} 个 worker 下线：${now.map((d) => d.id).join('、')}。`);
    const returned = dismissed.filter((d) => d.returned).map((d) => `${d.returned}（${d.id}）`);
    const submitted = dismissed.filter((d) => d.submitted).map((d) => d.submitted);
    if (returned.length) lines.push(`- 进行中的任务已退回待领取，等同角色的 worker 接手，已有改动保留：${returned.join('、')}`);
    if (submitted.length) lines.push(`- 已提交待 review 的任务照常 review：${submitted.join('、')}（打回的话会交给别人接手）`);
    lines.push('正在等任务的 worker 会马上收到通知；正在写代码的，下一次调用 ateam 命令时收到。');
    return lines.join('\n');
  },

  async reclaim({ positional }) {
    const id = requireArg(positional[0], '任务编号', 'ateam reclaim T3 "原窗口 token 用完了"');
    const { task, agentId } = await request('POST', '/api/reclaim', { id, text: positional[1] ?? '' });
    return `已收回 ${task.id}${agentId ? `（原 worker ${agentId} 已标记掉线）` : ''}，任务退回待领取，同角色（${task.role}）的空闲 worker 会以「接手任务」领走，在已有改动上继续。`;
  },

  async cancel({ positional }) {
    const id = requireArg(positional[0], '任务编号', 'ateam cancel T3 "改由 backend 角色做，见 T12"');
    const { task } = await request('POST', '/api/cancel', { id, text: positional[1] ?? '' });
    // 正在等任务的 worker 马上收到；正在写代码的，下一次调用 ateam 命令（按规则最多约 5 分钟一次）时收到
    const who = task.cancelledWhileHeld
      ? `。${task.assignee} 手上拿着它：等待中的话马上收到作废通知，正在写代码的话下一次调用 ateam 命令时收到（一般几分钟内）。它会停手、不提交，并还原已做的改动`
      : '';
    return `已作废 ${task.id}。它不再派发，也不计入进度和汇报${who}。`;
  },

  async release({ positional }) {
    const id = requireArg(positional[0], '任务编号', 'ateam release T3');
    const { task } = await request('POST', '/api/release', { id });
    return `已把 ${task.id} 放回待领取，打回次数清零。`;
  },

  async watch({ flags }) {
    const timeout = holdSeconds(flags);
    if (!flags.follow) {
      const data = await request('POST', '/api/watch', {}, timeout);
      return formatEvents(data?.events ?? []);
    }
    for (;;) {
      const data = await request('POST', '/api/watch', {}, timeout);
      for (const e of data?.events ?? []) process.stdout.write(`${formatEventLine(e)}\n`);
    }
  },

  async approve({ positional }) {
    const id = requireArg(positional[0], '任务编号', 'ateam approve T3 "备注"');
    const { task } = await request('POST', '/api/approve', { id, text: positional[1] ?? '' });
    return `已通过 ${task.id}。`;
  },

  async reject({ positional }) {
    const id = requireArg(positional[0], '任务编号', 'ateam reject T3 "<修改意见>"');
    const text = requireArg(positional[1], '修改意见', `ateam reject ${id} "web/login.js 缺少空密码校验"`);
    const { task } = await request('POST', '/api/reject', { id, text });
    if (task.status === 'held') {
      return `已打回 ${task.id}（第 ${task.rejectCount} 次），任务已转为挂起。请改写任务（ateam task edit ${task.id} ...）后 ateam release ${task.id}，或自己修改后 ateam approve ${task.id}。`;
    }
    const where = task.status === 'working' ? `修改意见将送达 ${task.assignee}` : '原 worker 已掉线，任务退回待领取，修改意见会交给接手的 worker';
    return `已打回 ${task.id}（第 ${task.rejectCount} 次），${where}。`;
  },

  async answer({ positional }) {
    const id = requireArg(positional[0], '任务编号', 'ateam answer T3 "<答复>"');
    const text = requireArg(positional[1], '答复', `ateam answer ${id} "用 ISO 8601 格式"`);
    const { task } = await request('POST', '/api/answer', { id, text });
    const where = task.status === 'working' ? `将送达 ${task.assignee}` : '提问者已掉线，答复会交给接手的 worker';
    return `已答复 ${task.id}，${where}。`;
  },

  // 项目规则：每个任务派给 worker 时按角色附上（## ALL 段给所有人，## <角色> 段只给这些角色）。
  // 改规则必须用户同意：先不带 --user-approved 运行，把服务给出的改动说明给用户看
  async rules({ flags, positional }) {
    const sub = positional[0];
    const approved = !!flags['user-approved'];
    if (!sub) {
      const role = flags.role ? String(flags.role).trim() : '';
      const info = await request('GET', `/api/rules${role ? `?role=${encodeURIComponent(role)}` : ''}`);
      let out;
      if (role) {
        out = info.forRole.trim() ? `# ${role} 收到的项目规则\n\n${info.forRole.trim()}` : `${role} 目前收不到任何项目规则。`;
      } else {
        out = info.rules.trim()
          ? `# 项目规则（派发时按角色附上）\n\n${info.rules.trim()}`
          : '还没有项目规则。添加：ateam rules add "提交前先跑一遍编译" [--role <角色>]（需要用户同意），或 ateam rules set --file rules.md';
      }
      if (info.unreceived?.length) out += `\n\n这些段目前没有角色会收到：${info.unreceived.join('、')}（现有角色：${info.roles.join('、') || '无'}）。全员段的小标题只认 ## ALL。`;
      if (info.needsTidy) out += '\n\n规则还没按角色分段，各角色都会收到全部规则；可以向用户提议整理（先给用户看哪条归哪段，用户同意后 ateam rules set --file … --user-approved）。';
      return out;
    }
    if (sub === 'add') {
      const line = requireArg(positional[1], '规则', 'ateam rules add "不写新的测试代码" [--role test]');
      const roles = flags.role ? splitList(flags.role) : [];
      const { section } = await request('POST', '/api/rules/add', { text: line, roles, userApproved: approved });
      return `已加到 ${section} 段。之后派发的${roles.length ? ` ${roles.join('、')} ` : '所有'}任务会带上（ateam rules 查看全部）。`;
    }
    if (sub === 'set') {
      const file = requireArg(flags.file, '规则文件 --file', 'ateam rules set --file rules.md');
      try {
        const { rules } = await request('POST', '/api/rules', { text: readTextFile(file, '--file'), userApproved: approved });
        return rules.trim() ? '已更新项目规则。之后派发的任务按角色带上。' : '已清空项目规则。';
      } catch (err) {
        if (err instanceof ServerError && err.code === 'NEEDS_USER') throw new ServerError(err.code, `${err.message}新内容：${file}`);
        throw err;
      }
    }
    fail('用法：ateam rules [--role <角色>] ／ ateam rules add "<一条规则>" [--role a,b] [--user-approved] ／ ateam rules set --file rules.md [--user-approved]');
  },

  async status({ flags }) {
    const { state, pending, root, repos, stale } = await request('GET', '/api/state');
    return formatStatus({ ...state, stale }, pending, flags.job, root, repos, !!flags.all);
  },

  // 审卡。审卡 worker：ateam critique --as critic-1 ok T5 T6 ／ issue T5 "<问题和建议>" [--because "和 T12 冲突"]
  // leader：ateam critique done T5 "<改了什么>" ／ dispute T5 "<为什么不改>"（交给用户裁决）
  async critique({ flags, positional }) {
    const [verb, ...rest] = positional;
    if (flags.as) {
      if (verb !== 'ok' && verb !== 'issue') fail(`用法：ateam critique --as ${flags.as} ok T5 [T6 ...] ／ ateam critique --as ${flags.as} issue T5 "<问题和修改建议>" --basis "<依据>" [--because "<重新审的原因>"]`);
      const ids = verb === 'ok' ? rest.filter((x) => /^T\d+$/i.test(x)) : rest.slice(0, 1);
      const text = verb === 'ok' ? rest.filter((x) => !/^T\d+$/i.test(x)).join(' ') : rest[1];
      const { tasks } = await request('POST', '/api/critique', { as: flags.as, ids: ids.map((x) => x.toUpperCase()), verdict: verb, text: text ?? '', because: flags.because ?? '', basis: flags.basis ?? '' });
      const what = verb === 'ok' ? '审卡通过' : '已提交审卡意见，leader 回复后交给用户决定';
      return `${what}：${tasks.map((t) => t.id).join('、')}。继续审下一张；都审完了运行 ateam wait --as ${flags.as}`;
    }
    if (!['agree', 'dispute', 'done'].includes(verb)) fail('用法：ateam critique agree T5 "<打算怎么改>" --basis "<依据>" ／ ateam critique dispute T5 "<为什么不改>" --basis "<依据>" ／ 用户决定后 ateam critique done T5 "<改了什么>"');
    const id = requireArg(rest[0], '任务编号', `ateam critique ${verb} T5 "..."`);
    const { task } = await request('POST', '/api/critique/handle', { id, action: verb, text: rest[1] ?? '', basis: flags.basis ?? '' });
    if (verb === 'done') return `已结案 ${task.id} 的审卡意见。`;
    return `已回复 ${task.id} 的审卡意见，交给用户在看板上决定。先不要改这张卡；用户决定后你会收到 critique_ruling 事件（按什么改），照做后 ateam critique done ${task.id} "<改了什么>"。用户选「不改」就不会有事件。`;
  },

  // 给正在做的 worker 补充说明，它下一次调用 progress / wait / submit 时收到
  async note({ positional }) {
    const id = requireArg(positional[0], '任务编号', 'ateam note T5 "<补充说明>"');
    const { task } = await request('POST', '/api/note', { id, text: positional[1] ?? '' });
    return `已给 ${task.id} 的 worker（${task.assignee}）留了补充说明，它下一次调用 ateam 命令时收到；提交前一定会看到。`;
  },

  // 全部能审的卡（审卡用；leader 也能看）
  async cards({ flags }) {
    const q = new URLSearchParams();
    if (flags.job) q.set('job', flags.job);
    if (flags.todo) q.set('todo', '1');
    const { cards } = await request('GET', `/api/cards?${q}`);
    return formatCards(cards, { todo: !!flags.todo });
  },

  // 翻看历史需求：默认只列已验收的，--all 列全部；--grep 按关键词查
  async jobs({ flags }) {
    const { state } = await request('GET', '/api/state');
    return formatJobs(state, { filter: flags.all ? 'all' : 'accepted', keyword: flags.grep ?? '' });
  },

  async 'job show'({ positional }) {
    const id = requireArg(positional[0], '需求编号', 'ateam job show J3');
    const { state } = await request('GET', '/api/state');
    const job = state.jobs.find((j) => j.id === id);
    if (!job) fail(`找不到需求 ${id}。用 ateam jobs --all 查看所有需求。`);
    return formatJob(state, job);
  },

  async show({ positional }) {
    const id = requireArg(positional[0], '任务编号', 'ateam show T3');
    const { task } = await request('GET', `/api/task?id=${encodeURIComponent(id)}`);
    return `# ${task.id}：${task.title}（需求 ${task.jobId}）\n\n${formatTask(task)}`;
  },

  async 'demo add'({ flags }) {
    const jobId = requireArg(flags.job, '--job', 'ateam demo add --job J5 --title "协议适配全流程" --script docs/demo/protocol.md');
    const title = requireArg(flags.title, '--title', 'ateam demo add --job J5 --title "协议适配全流程" --script docs/demo/protocol.md');
    const script = requireArg(flags.script, '--script', 'ateam demo add --job J5 --title "协议适配全流程" --script docs/demo/protocol.md');
    const { task } = await request('POST', '/api/demo/add', { jobId, title, script, role: flags.role ?? 'test' });
    return `已创建演播卡 ${task.id}：${task.title}（脚本 ${task.script}，角色 ${task.role}）。告诉用户：先在看板上点「开始预演」，空闲的 ${task.role} worker 会预演一遍并写出操作记录；预演跑完后才能「开始演播」。`;
  },

  async 'demo step'({ flags, positional }) {
    const as = requireAs(flags);
    const m = String(positional[0] ?? '').match(/^(\d+)\/(\d+)$/);
    if (!m) fail(`步数格式是「第几步/总步数」，比如：ateam demo step --as ${as} 3/12 "新建装备"`);
    const text = requireArg(positional[1], '这一步的说明', `ateam demo step --as ${as} 3/12 "新建装备"`);
    const data = await request('POST', '/api/demo/step', { as, n: Number(m[1]), total: Number(m[2]), text, slow: !!flags.slow, timeout: 50 });
    if (data.stopped) return formatWait({ kind: 'demo_stopped', task: data.task }, as);
    if (data.paused) {
      // 用户暂停了：原样再运行这条命令等着（带递增的 --round，免得被平台判成重复命令）
      const round = (Number.parseInt(flags.round ?? '0', 10) || 0) + 1;
      const q = (v) => `"${String(v).replace(/(["\\$`])/g, '\\$1')}"`;
      const again = `ateam demo step --as ${as} ${m[1]}/${m[2]} ${q(text)}${flags.slow ? ' --slow' : ''} --round ${round}`;
      const after = data.task.paused?.afterStep;
      return [
        '# 演播已暂停',
        '',
        `用户暂停了演播（${after ? `第 ${after} 步做完后` : '第一步开始前'}），第 ${m[1]} 步还没开始。**不要操作浏览器、不要截图**，立刻原样运行：`,
        '',
        `  ${again}`,
        '',
        `用户点「继续」后这条命令会直接返回「已记录第 ${m[1]}/${m[2]} 步」，你接着做第 ${m[1]} 步；如果又输出「# 演播已暂停」，就照它给的命令再运行。不要结束、不要向用户汇报。`,
      ].join('\n');
    }
    return `已记录第 ${m[1]}/${m[2]} 步${flags.slow ? '（慢档）' : ''}。继续；全部跑完后运行 ateam demo end --as ${as} "<结果>"。`;
  },

  async 'demo end'({ flags, positional }) {
    const as = requireAs(flags);
    const result = requireArg(positional[0], '结果', `ateam demo end --as ${as} "12 步全部顺利"`);
    const { task } = await request('POST', '/api/demo/end', { as, result, stuck: !!flags.stuck });
    return `已记录 ${task.id} ${flags.stuck ? '停住' : '跑完'}，派发已恢复。现在运行 ateam wait --as ${as}，按收到的收尾说明做。`;
  },

  async 'demo save'({ flags, positional }) {
    const as = requireAs(flags);
    const summary = requireArg(positional[0], '总结', `ateam demo save --as ${as} "写了 12 步的操作记录"`);
    const { task, commit } = await request('POST', '/api/demo/save', { as, summary, noChanges: !!flags['no-changes'] });
    return `演播卡 ${task.id} 收尾完成（${commit ? `操作记录已提交 ${commit}` : '操作记录没有改动'}），已回到待演播。请运行：ateam wait --as ${as}`;
  },

  async report({ flags }) {
    const jobId = requireArg(flags.job, '需求编号 --job', 'ateam report --job J1 --file report.md');
    const file = requireArg(flags.file, '汇报文件 --file', 'ateam report --job J1 --file report.md');
    const { job } = await request('POST', '/api/report', { jobId, report: readTextFile(file, '--file') });
    return `已提交需求 ${job.id} 的汇报，需求进入待用户验收。请在对话里把汇报告诉用户。`;
  },
};

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  let name = positional.shift();
  if (!name || name === 'help' || flags.help) {
    console.log(USAGE);
    return 0;
  }
  if (name === 'job' || name === 'task' || name === 'demo') name = `${name} ${positional.shift() ?? ''}`;
  const command = commands[name];
  if (!command) fail(`未知命令：${name.trim()}。\n\n${USAGE}`);
  const out = await command({ flags, positional });
  if (out) console.log(out);
  return 0;
}

main().then(
  (code) => { if (code) process.exitCode = code; },
  (err) => {
    if (err instanceof Unreachable) {
      console.log(`错误：服务不可达（${BASE}），请通知用户。`);
      process.exitCode = 2;
    } else if (err instanceof ServerError) {
      console.log(formatError(err.code, err.message));
      process.exitCode = 1;
    } else if (err instanceof CliError) {
      console.log(`错误：${err.message}`);
      process.exitCode = 1;
    } else {
      console.log(formatError('INTERNAL', err?.message ?? String(err)));
      process.exitCode = 1;
    }
  },
);
