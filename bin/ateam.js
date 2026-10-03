#!/usr/bin/env node
// ateam 命令行：主管和工人与服务交互的唯一方式。输出是给大模型读的 markdown 文本。
// 退出码：0 成功；1 业务错误；2 服务不可达。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  formatError, formatEventLine, formatEvents, formatStatus, formatTask, formatWait,
} from '../src/format.js';

const BASE = (process.env.ATEAM_URL || 'http://127.0.0.1:7700').replace(/\/+$/, '');
const RETRY_MS = Number(process.env.ATEAM_RETRY_SEC || 60) * 1000;
const RETRY_INTERVAL_MS = 2000;
const RETRYABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE']);
const DEFAULT_HOLD_SEC = 90;

const BOOLEAN_FLAGS = new Set(['follow', 'no-changes']);
const REPEATABLE_FLAGS = new Set(['accept']);

const USAGE = `用法：ateam <命令> [参数]

服务
  ateam serve [--port 7700] [--lease 15]

工人
  ateam join --role <角色>
  ateam wait --as <ID> [--timeout 90]
  ateam progress --as <ID> "<笔记>"
  ateam ask --as <ID> "<问题>"
  ateam submit --as <ID> "<总结>" [--no-changes]

主管
  ateam job new "<标题>" [--desc-file f.md]
  ateam task add --job J1 --role <角色> --paths a/,b/ [--after T1,T2] --title "..." [--desc-file t.md] [--accept "..."]...
  ateam task edit T3 [--title "..."] [--desc-file f.md] [--accept "..."]... [--paths ...] [--after ...]
  ateam release T3
  ateam watch [--timeout 90] [--follow]
  ateam approve T3 ["<备注>"]
  ateam reject T3 "<修改意见>"
  ateam answer T3 "<答复>"
  ateam status [--job J1]
  ateam show T3
  ateam report --job J1 --file report.md

服务地址取自 ATEAM_URL（默认 http://127.0.0.1:7700）。`;

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
  if (!flags.as) fail('缺少 --as <工人编号>。如果还没加入团队，请先运行 ateam join --role <角色>。');
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
        headers: body ? { 'content-type': 'application/json' } : undefined,
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

const commands = {
  async serve({ flags }) {
    const { startServer } = await import('../src/server.js');
    const port = Number(flags.port ?? 7700);
    const leaseMin = Number(flags.lease ?? process.env.ATEAM_LEASE_MIN ?? 15);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) fail('--port 必须是 1-65535 的整数。');
    if (!Number.isFinite(leaseMin) || leaseMin <= 0) fail('--lease 必须是正数（分钟）。');
    try {
      await startServer({ root: process.cwd(), port, leaseMin });
    } catch (err) {
      fail(err.message);
    }
    return `ateam 服务已启动：http://127.0.0.1:${port}（看板同地址）`;
  },

  async join({ flags }) {
    const role = requireArg(flags.role, '角色', 'ateam join --role frontend');
    const { agent } = await request('POST', '/api/join', { role });
    return [
      `已加入团队。你的工人编号是 **${agent.id}**（角色 ${agent.role}）。之后每条命令都要带 --as ${agent.id}。`,
      '',
      `下一步：ateam wait --as ${agent.id}`,
    ].join('\n');
  },

  async wait({ flags }) {
    const as = requireAs(flags);
    const data = await request('POST', '/api/wait', { as }, holdSeconds(flags));
    return formatWait(data?.result ?? null, as);
  },

  async progress({ flags, positional }) {
    const as = requireAs(flags);
    const text = requireArg(positional[0], '进度笔记', `ateam progress --as ${as} "改完了 web/login.js"`);
    const { task } = await request('POST', '/api/progress', { as, text });
    return `已记录 ${task.id} 的进度。继续工作；完成后运行：ateam submit --as ${as} "<做了什么、怎么验证的>"`;
  },

  async ask({ flags, positional }) {
    const as = requireAs(flags);
    const text = requireArg(positional[0], '问题', `ateam ask --as ${as} "接口返回的日期用什么格式？"`);
    const { task } = await request('POST', '/api/ask', { as, text });
    return `已就 ${task.id} 向主管提问。请运行 ateam wait --as ${as} 等待答复，不要猜。`;
  },

  async submit({ flags, positional }) {
    const as = requireAs(flags);
    const summary = requireArg(positional[0], '提交总结', `ateam submit --as ${as} "完成登录页，手工验证了表单校验"`);
    const { task, commit } = await request('POST', '/api/submit', { as, summary, noChanges: !!flags['no-changes'] });
    const what = commit ? `提交 ${commit}` : '无代码改动';
    return `已提交 ${task.id}（${what}），等待主管 review。请运行：ateam wait --as ${as}`;
  },

  async 'job new'({ flags, positional }) {
    const title = requireArg(positional[0], '需求标题', 'ateam job new "用户登录"');
    const description = flags['desc-file'] ? readTextFile(flags['desc-file'], '--desc-file') : '';
    const { job } = await request('POST', '/api/jobs', { title, description });
    return `已创建需求 ${job.id}：${job.title}\n\n下一步：ateam task add --job ${job.id} --role <角色> --paths <路径> --title "..." --desc-file <文件> --accept "..."`;
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
    };
    const { task } = await request('POST', '/api/tasks', body);
    const deps = task.dependsOn.length ? `，依赖 ${task.dependsOn.join('、')}` : '';
    return `已添加任务 ${task.id}：${task.title}（角色 ${task.role}，路径 ${task.paths.join('、')}${deps}，验收标准 ${task.acceptance.length} 条）`;
  },

  async 'task edit'({ flags, positional }) {
    const id = requireArg(positional[0], '任务编号', 'ateam task edit T3 --desc-file t.md');
    const body = { id };
    if (flags.title !== undefined) body.title = flags.title;
    if (flags['desc-file'] !== undefined) body.description = readTextFile(flags['desc-file'], '--desc-file');
    if (flags.accept !== undefined) body.acceptance = flags.accept;
    if (flags.paths !== undefined) body.paths = splitList(flags.paths);
    if (flags.after !== undefined) body.dependsOn = splitList(flags.after);
    const { task } = await request('POST', '/api/tasks/edit', body);
    const next = task.status === 'held' ? `\n\n下一步：ateam release ${task.id}` : '';
    return `已修改任务 ${task.id}。${next}`;
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
    const where = task.status === 'working' ? `修改意见将送达 ${task.assignee}` : '原工人已掉线，任务退回待领取，修改意见会交给接手的工人';
    return `已打回 ${task.id}（第 ${task.rejectCount} 次），${where}。`;
  },

  async answer({ positional }) {
    const id = requireArg(positional[0], '任务编号', 'ateam answer T3 "<答复>"');
    const text = requireArg(positional[1], '答复', `ateam answer ${id} "用 ISO 8601 格式"`);
    const { task } = await request('POST', '/api/answer', { id, text });
    const where = task.status === 'working' ? `将送达 ${task.assignee}` : '提问者已掉线，答复会交给接手的工人';
    return `已答复 ${task.id}，${where}。`;
  },

  async status({ flags }) {
    const { state, pending } = await request('GET', '/api/state');
    return formatStatus(state, pending, flags.job);
  },

  async show({ positional }) {
    const id = requireArg(positional[0], '任务编号', 'ateam show T3');
    const { task } = await request('GET', `/api/task?id=${encodeURIComponent(id)}`);
    return `# ${task.id}：${task.title}（需求 ${task.jobId}）\n\n${formatTask(task)}`;
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
  if (name === 'job' || name === 'task') name = `${name} ${positional.shift() ?? ''}`;
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
      console.log('错误：服务不可达，请通知用户。');
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
