// HTTP 路由、长轮询挂起和唤醒、租约定时扫描、落盘、托管看板。
import { spawn } from 'node:child_process';
import http from 'node:http';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AteamError } from './errors.js';
import { createStore } from './store.js';
import { addRule, needsTidy, rulesFor, sectionCounts, unreceived } from './rules.js';
import { loadState, saveState } from './persist.js';
import { commitPaths, detectRepos, ensureGitignore, headContent, latestChangeTime } from './git.js';
import { checkOps, opsSection, parseOps, parseSteps, stepCount, withoutOps } from './demo.js';

const DASHBOARD = join(dirname(fileURLToPath(import.meta.url)), 'dashboard.html');
const PROMPTER_JXA = join(dirname(fileURLToPath(import.meta.url)), 'prompter.jxa');
// agent-team 自己的安装目录，看板「安装」页用它拼出安装命令
const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 1024 * 1024;
const DEFAULT_HOLD_SEC = 90;
const MAX_HOLD_SEC = 110;
const LEADER_FRESH_MS = 3 * 60 * 1000;
const MAX_RULES = 20 * 1024;
// 新领到、接手、继续的任务附上项目规则；打回意见和答复只是补充消息，不重复附
const RULES_KINDS = new Set(['task', 'handoff', 'resume', 'own', 'demo', 'demo_stopped', 'demo_wrap']);

// 服务端代码指纹：src/*.js 和 bin/ateam.js 的内容哈希。启动时记一份，之后比对，
// 代码被更新（git pull、改了代码）而服务没重启时，看板和 status 提示重启。
// 只在文件修改时间变了时才重新读内容，看板每 3 秒查一次也不费事。
const CODE_FILES = () => [
  ...readdirSync(join(TOOL_DIR, 'src')).filter((f) => f.endsWith('.js')).map((f) => join(TOOL_DIR, 'src', f)),
  join(TOOL_DIR, 'bin', 'ateam.js'),
];
let codeCache = { key: '', hash: '' };
function codeHash() {
  try {
    const files = CODE_FILES().sort();
    const key = files.map((f) => `${f}:${statSync(f).mtimeMs}`).join('|');
    if (key !== codeCache.key) {
      const h = createHash('sha1');
      for (const f of files) h.update(f).update(readFileSync(f));
      codeCache = { key, hash: h.digest('hex') };
    }
    return codeCache.hash;
  } catch {
    return codeCache.hash;
  }
}

function holdMs(timeout) {
  const sec = Number(timeout);
  if (!Number.isFinite(sec) || sec <= 0) return DEFAULT_HOLD_SEC * 1000;
  return Math.min(sec, MAX_HOLD_SEC) * 1000;
}

function send(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

// 带 ETag 返回：内容没变时只回 304，看板每 3 秒轮询不用每次传整份状态
function sendCached(req, res, body) {
  const data = JSON.stringify(body);
  const etag = `"${createHash('sha1').update(data).digest('base64url')}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), etag });
  res.end(data);
}

function sendError(res, err) {
  if (err instanceof AteamError) send(res, 400, { ok: false, code: err.code, message: err.message });
  else send(res, 500, { ok: false, code: 'INTERNAL', message: err?.message ?? String(err) });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new AteamError('INVALID', '请求体超过 1MB。请缩短内容后重试。'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        const body = JSON.parse(text);
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch {
        reject(new AteamError('INVALID', '请求体不是合法的 JSON 对象。'));
      }
    });
    req.on('error', reject);
  });
}

export async function startServer({ root, port = 7700, leaseMin = 15, idleMin = 3 } = {}) {
  const layout = await detectRepos(root);
  const startHash = codeHash();
  // 单仓库：把 .ateam/ 加进项目的 .gitignore。多仓库：项目目录本身不是仓库，不用加
  if (layout.mode === 'single') ensureGitignore(root);

  const dataDir = join(root, '.ateam');
  const leaseMs = leaseMin * 60 * 1000;
  const waiters = new Map(); // agentId -> { res, timer }
  const watchers = new Set(); // { res, timer }
  let leaderSeenAt = null; // leader 最近一次用命令行操作的时间（只在内存里，重启后等 leader 下次操作）
  // leader 在线：挂着 watch 监听，或 3 分钟内用命令行操作过
  const leaderOnline = () => watchers.size > 0 || (leaderSeenAt !== null && Date.now() - leaderSeenAt < LEADER_FRESH_MS);
  let waking = false;
  let wakeScheduled = false;

  // 项目规则：.ateam/rules.md，每个任务都要遵守的约定（不写测试、提交前跑编译……）。
  // 每次派任务时现读，用户或 leader 改了马上生效。
  const rulesFile = join(dataDir, 'rules.md');
  function readRules() {
    try { return readFileSync(rulesFile, 'utf8'); } catch { return ''; }
  }
  function writeRules(text) {
    if (typeof text !== 'string') throw new AteamError('INVALID', '规则内容必须是文本。');
    if (Buffer.byteLength(text) > MAX_RULES) throw new AteamError('INVALID', '项目规则超过 20KB。规则是每个任务都要读的，请精简到最重要的几条。');
    mkdirSync(dataDir, { recursive: true });
    const tmp = `${rulesFile}.tmp`;
    writeFileSync(tmp, text.trim() ? `${text.trim()}\n` : '');
    renameSync(tmp, rulesFile);
    return readRules();
  }
  // leader 用命令行改规则要用户同意；看板保存（用户本人）带 userApproved
  function approvedRules(text, userApproved, preview) {
    if (typeof text !== 'string') throw new AteamError('INVALID', '规则内容必须是文本。');
    if (!userApproved) throw new AteamError('NEEDS_USER', `${preview}请给用户看，用户同意后加 --user-approved 重新运行。`);
    return writeRules(text);
  }
  function countsChange(before, after) {
    const a = new Map(sectionCounts(before).map((c) => [c.section, c.count]));
    const b = new Map(sectionCounts(after).map((c) => [c.section, c.count]));
    const names = [...new Set([...a.keys(), ...b.keys()])];
    const diff = names.filter((n) => (a.get(n) ?? 0) !== (b.get(n) ?? 0)).map((n) => `${n} ${a.get(n) ?? 0} → ${b.get(n) ?? 0}`);
    return diff.length ? `改动前后各段条数：${diff.join('，')}。` : '各段条数没有变化，内容有改动。';
  }
  // 会领卡的角色。审卡 worker（critic）不收项目规则，不算在内：写了 ## critic 段会被提示没人收到
  const knownRoles = () => [...new Set([...store.state.tasks, ...store.state.agents].map((x) => x.role).filter(Boolean).map((r) => r.trim().toLowerCase()))].filter((r) => r !== 'critic').sort();
  // 新领到、接手、继续的任务附上：所属需求的说明（这次需求的设计文档、计划在哪等，只对这个需求的任务有效）
  // 和项目规则（长期有效的约定）
  function withRules(result) {
    if (!result || !RULES_KINDS.has(result.kind)) return result;
    const out = { ...result };
    const rules = rulesFor(readRules(), result.task.role).trim();
    if (rules) out.rules = rules;
    const job = store.state.jobs.find((j) => j.id === result.task.jobId);
    if (job?.description?.trim()) out.job = { id: job.id, title: job.title, description: job.description.trim() };
    // 演播卡：附上脚本全文，worker 不用自己去找文件
    if (result.task.kind === 'demo') {
      try {
        const text = readFileSync(join(root, result.task.script), 'utf8');
        out.script = { path: result.task.script, text, steps: stepCount(text), hasOps: !!opsSection(text).replace(/<!--[\s\S]*?-->/g, '').trim() };
      } catch (err) {
        out.script = { path: result.task.script, text: '', steps: 0, hasOps: false, error: `读不到脚本文件：${err.message}` };
      }
      const runs = result.task.runs ?? [];
      out.script.mode = runs[runs.length - 1]?.mode ?? 'show';
      out.script.only = runs[runs.length - 1]?.steps ?? null;
      // 目标视口：预演按当前设置录；演播沿用这张卡预演时记下的尺寸。legacy：旧的按坐标录的记录，要整段重写
      const ops = parseOps(out.script.text);
      out.script.viewport = out.script.mode === 'rehearsal' ? store.config().demoViewport : (ops.viewport ?? store.config().demoViewport);
      out.script.legacy = ops.legacy;
    }
    return out;
  }

  const store = createStore({ state: loadState(dataDir) ?? undefined, leaseMs, idleMs: idleMin * 60 * 1000, onChange });

  // 每次状态变化：落盘，并在下一轮事件循环唤醒挂起的请求。
  // 唤醒过程本身（nextFor 的 touch、takeEvents）也会触发 onChange，用 waking 标记避免循环。
  // 看板的推送连接（SSE）。浏览器会暂停后台标签页的定时器，看板的 3 秒轮询在后台可能不跑，
  // 标签页标题上的提醒就不更新；网络推送来的消息在后台照样会处理，收到后看板立即刷新一次。
  const streams = new Set();
  function pushAll(msg) {
    for (const res of streams) res.write(`data: ${msg}\n\n`);
  }
  // leader 在线与否、心跳时间这类随时间变化的状态没有对应的 onChange，定时推一下
  const streamTimer = setInterval(() => pushAll('tick'), 15000);
  streamTimer.unref();

  // 状态变化很频繁（每次心跳都算），合并成最多每秒推一次
  let pushTimer = null;
  function pushSoon() {
    if (pushTimer || streams.size === 0) return;
    pushTimer = setTimeout(() => { pushTimer = null; pushAll('change'); }, 1000);
  }

  function onChange() {
    saveState(dataDir, store.state);
    pushSoon();
    if (waking || wakeScheduled) return;
    wakeScheduled = true;
    setImmediate(wake);
  }

  function wake() {
    wakeScheduled = false;
    waking = true;
    try {
      for (const [agentId, waiter] of [...waiters]) {
        try {
          const result = store.nextFor(agentId);
          if (result) finishWaiter(agentId, waiter, 200, { ok: true, result: withRules(result) });
        } catch (err) {
          finishWaiter(agentId, waiter, err instanceof AteamError ? 400 : 500,
            { ok: false, code: err.code ?? 'INTERNAL', message: err.message });
        }
      }
      if (watchers.size > 0) {
        const events = store.takeEvents();
        if (events.length > 0) {
          for (const watcher of [...watchers]) finishWatcher(watcher, { ok: true, events });
        }
      }
    } finally {
      waking = false;
    }
  }

  function finishWaiter(agentId, waiter, status, body) {
    clearTimeout(waiter.timer);
    if (waiters.get(agentId) === waiter) waiters.delete(agentId);
    send(waiter.res, status, body);
  }

  function finishWatcher(watcher, body) {
    clearTimeout(watcher.timer);
    watchers.delete(watcher);
    send(watcher.res, 200, body);
  }

  // git 操作串行执行，两个 worker 的提交排队，不会交错
  let gitQueue = Promise.resolve();
  function serial(fn) {
    const run = gitQueue.then(fn, fn);
    gitQueue = run.catch(() => {});
    return run;
  }

  function requireId(body) {
    if (typeof body.id !== 'string' || !body.id.trim()) throw new AteamError('INVALID', '缺少任务编号（例如 T3）。');
    return body.id.trim();
  }

  // 提词悬浮窗进程（osascript）；服务退出时一起关掉
  let prompterProc = null;
  process.on('exit', () => prompterProc?.kill());

  // 普通路由：返回 JSON 对象（自动加 ok:true）
  const routes = {
    'POST /api/join': (b) => ({ agent: store.join(b.role, b.name, b.id) }),
    'POST /api/progress': (b) => ({ task: store.progress(b.as, b.text, b.expect) }),
    'POST /api/ask': (b) => ({ task: store.ask(b.as, b.text) }),
    'POST /api/submit': (b) => serial(async () => {
      const task = store.taskForSubmit(b.as);
      if (typeof b.summary !== 'string' || !b.summary.trim()) {
        throw new AteamError('INVALID', '提交总结不能为空。请写明做了什么、怎么验证的。');
      }
      let commits = null;
      if (!b.noChanges) {
        const result = await commitPaths(root, task.paths, `[${task.id}] ${b.summary.trim()}`);
        if (result.nothing) {
          throw new AteamError('INVALID', `指定路径（${task.paths.join('、')}）下没有改动。服务的项目目录是 ${root}，路径相对于这个目录：如果你的改动在别的目录，说明服务起错了目录，请通知用户，不要挪动改动；如确实无需改代码，请加 --no-changes。`);
        }
        commits = result.commits;
      }
      return { task: store.recordSubmit(b.as, b.summary, commits), commit: commits ? commits.join('、') : null };
    }),
    'POST /api/jobs': (b) => ({ job: store.createJob({ title: b.title, description: b.description, origin: b.origin, demo: !!b.demo }) }),
    'POST /api/demo/add': (b) => {
      if (typeof b.script !== 'string' || !b.script.trim()) throw new AteamError('INVALID', '缺少脚本路径（--script），比如 docs/demo/protocol-adapter.md。');
      const script = relative(root, resolve(root, b.script.trim())).split(sep).join('/');
      if (!script || script.startsWith('..')) throw new AteamError('INVALID', `脚本路径 ${b.script} 不在项目目录（${root}）里。`);
      if (!existsSync(join(root, script))) throw new AteamError('INVALID', `脚本文件 ${script} 不存在，请先按演播脚本格式写好并提交，再建演播卡。`);
      return { task: store.addDemo({ jobId: b.jobId, title: b.title, script, role: b.role }) };
    },
    // steps：演播只演这几步。总步数从脚本读，读不到就交给 store 拒绝
    'POST /api/demo/start': (b) => {
      const id = requireId(b);
      let total = null;
      let text = null;
      try { text = readFileSync(join(root, store.getTask(id).script), 'utf8'); } catch {}
      if (b.steps != null && text != null) total = stepCount(text);
      // 旧的按坐标录的操作记录不能直接演播，要先按新格式重新预演
      if ((b.mode ?? 'show') === 'show' && text != null && parseOps(text).legacy) {
        throw new AteamError('BAD_STATE', `${id} 的操作记录是旧格式（按坐标录的），请先重新预演一次。`);
      }
      return { task: store.startDemo(id, b.mode ?? 'show', b.steps ?? null, total) };
    },
    'GET /api/demo/ops': (_b, url) => {
      const task = store.getTask(url.searchParams.get('id') ?? '');
      if (task.kind !== 'demo') throw new AteamError('INVALID', `任务 ${task.id} 不是演播卡。`);
      // ops：worker 写的操作记录；steps：脚本的步骤列表（编号、做什么、讲解），看板右栏的步骤大纲用
      try {
        const text = readFileSync(join(root, task.script), 'utf8');
        const parsed = parseOps(text);
        // recorded：动作块和预期都录好了的步骤号，看板标「已录」；legacy：旧的按坐标录的记录
        return { ops: opsSection(text), steps: parseSteps(text), viewport: parsed.viewport, legacy: parsed.legacy, recorded: [...parsed.steps].filter(([, v]) => !v.problem).map(([n]) => n) };
      } catch (err) {
        return { ops: '', steps: [], error: `读不到脚本文件 ${task.script}：${err.message}` };
      }
    },
    'POST /api/demo/stop': (b) => ({ task: store.stopDemo(requireId(b)) }),
    'POST /api/demo/release': (b) => ({ task: store.releaseDemo(requireId(b)) }),
    // 提词悬浮窗（只有 macOS）：服务替看板起一个系统窗口，没有浏览器边框、浮在最上层。
    // 同一时间只留一个；再点就关掉旧的重开（跳到最前）。其他系统返回错误，看板改用普通弹窗
    'POST /api/prompter/open': () => {
      if (process.platform !== 'darwin') throw new AteamError('INVALID', '提词悬浮窗只支持 macOS');
      prompterProc?.kill();
      const proc = spawn('osascript', ['-l', 'JavaScript', PROMPTER_JXA, `http://127.0.0.1:${server.address().port}/?prompter&native`], { stdio: 'ignore' });
      proc.on('exit', () => { if (prompterProc === proc) prompterProc = null; });
      proc.on('error', () => { if (prompterProc === proc) prompterProc = null; });
      prompterProc = proc;
      return {};
    },
    'POST /api/prompter/close': () => { prompterProc?.kill(); prompterProc = null; return {}; },
    'POST /api/demo/pause': (b) => ({ task: store.pauseDemo(requireId(b)) }),
    'POST /api/demo/resume': (b) => ({ task: store.resumeDemo(requireId(b)) }),
    'POST /api/demo/end': (b) => {
      // 预演跑完：每一步都要录好动作块，才算预演完成
      const held = store.state.agents.find((a) => a.id === b.as)?.currentTask;
      const task = held && store.state.tasks.find((t) => t.id === held && t.kind === 'demo');
      const run = task?.runs?.[task.runs.length - 1];
      if (task && run?.mode === 'rehearsal' && !b.stuck && task.status === 'demoing' && !task.stopRequested) {
        let text = '';
        try { text = readFileSync(join(root, task.script), 'utf8'); } catch {}
        const problems = checkOps(text, { all: true });
        if (problems.length) throw new AteamError('INVALID', `预演还不能算跑完，「## 操作记录」没录全：\n${problems.map((p) => `- ${p}`).join('\n')}\n\n把这些补上（开头「视口：宽x高」；每步「### N.」条目、\`\`\`actions 动作块和「预期：」行），再运行 ateam demo end。实在走不通的步骤用 --stuck 结束。`);
      }
      return { task: store.demoEnd(b.as, b.result, !!b.stuck) };
    },
    'POST /api/demo/save': (b) => serial(async () => {
      const task = store.demoTaskForSave(b.as);
      if (typeof b.summary !== 'string' || !b.summary.trim()) throw new AteamError('INVALID', '总结不能为空。写明这次记了或改了哪些操作；操作记录没有改动就加 --no-changes。');
      let current;
      try { current = readFileSync(join(root, task.script), 'utf8'); } catch {
        throw new AteamError('INVALID', `读不到脚本文件 ${task.script}。不要删除或移动它；恢复后再 demo save。`);
      }
      const head = await headContent(root, task.script);
      if (head === null) throw new AteamError('INVALID', `脚本文件 ${task.script} 还没有提交过，请通知用户让 leader 先提交脚本。`);
      if (b.noChanges) {
        // 写了操作记录却加 --no-changes，记录会丢：拒绝
        if (current !== head) throw new AteamError('INVALID', `脚本 ${task.script} 有没提交的改动，不能加 --no-changes。去掉 --no-changes 重新运行，服务会提交它。`);
        return { task: store.recordDemoSave(b.as, b.summary, null), commit: null };
      }
      // 预演跑完的收尾：每步都要有合法动作块；其他情况只检查已写的动作块格式
      const run = task.runs?.[task.runs.length - 1];
      const problems = checkOps(current, { all: run?.mode === 'rehearsal' && run?.outcome === 'done' });
      if (problems.length) throw new AteamError('INVALID', `「## 操作记录」有问题，先改好再 demo save：\n${problems.map((p) => `- ${p}`).join('\n')}`);
      if (withoutOps(current) !== withoutOps(head)) {
        throw new AteamError('INVALID', `只能改脚本的「## 操作记录」段，其他段有改动。请把其他段恢复原样（git diff ${task.script} 查看）后再 demo save。`);
      }
      const result = await commitPaths(root, [task.script], `[${task.id}] 操作记录：${b.summary.trim()}`);
      if (result.nothing) throw new AteamError('INVALID', `脚本 ${task.script} 没有改动。操作记录没有改动就加 --no-changes。`);
      return { task: store.recordDemoSave(b.as, b.summary, result.commits), commit: result.commits.join('、') };
    }),
    'POST /api/jobs/edit': (b) => {
      const { jobId, ...patch } = b;
      return { job: store.editJob(jobId, patch) };
    },
    'POST /api/jobs/accept': (b) => ({ jobs: store.acceptJobs(b.ids) }),
    'POST /api/jobs/cancel': (b) => store.cancelJob(requireId(b), b.text ?? '', !!b.userApproved),
    'POST /api/tasks': (b) => {
      const task = store.addTask({
        jobId: b.jobId, title: b.title, role: b.role, paths: b.paths,
        description: b.description, acceptance: b.acceptance, dependsOn: b.dependsOn, top: !!b.top,
      });
      return { task, overlaps: store.overlapsFor(task) };
    },
    'POST /api/critique': (b) => ({ tasks: store.submitCritique(b.as, b.ids, b.verdict, b.text, b.because, b.basis) }),
    'POST /api/critique/handle': (b) => ({ task: store.handleCritique(requireId(b), b.action, b.text, b.basis) }),
    'POST /api/critique/rule': (b) => ({ task: store.ruleCritique(requireId(b), b.side, b.text) }),
    'POST /api/note': (b) => ({ task: store.noteTask(requireId(b), b.text) }),
    'GET /api/cards': (_b, url) => ({ cards: store.cards({ jobId: url.searchParams.get('job') ?? '', todo: url.searchParams.get('todo') === '1' }) }),
    'POST /api/tasks/assign': (b) => ({ task: store.assignTask(requireId(b), b.to) }),
    // by：看板传 user，命令行（leader）不传
    'POST /api/tasks/hold': (b) => ({ task: store.holdTask(requireId(b), !!b.on, b.text ?? '', b.by === 'user' ? 'user' : 'lead') }),
    'POST /api/jobs/hold': (b) => ({ job: store.holdJob(requireId(b), !!b.on, b.text ?? '', b.by === 'user' ? 'user' : 'lead') }),
    'POST /api/tasks/priority': (b) => ({ task: store.setPriority(requireId(b), !!b.top) }),
    'POST /api/tasks/edit': (b) => {
      const { id, ...patch } = b;
      const task = store.editTask(requireId({ id }), patch);
      // 只在改了路径或依赖时提醒
      return { task, overlaps: patch.paths !== undefined || patch.dependsOn !== undefined ? store.overlapsFor(task) : [] };
    },
    'POST /api/approve': (b) => ({ task: store.approve(requireId(b), b.text ?? '') }),
    'POST /api/reject': (b) => ({ task: store.reject(requireId(b), b.text) }),
    'POST /api/answer': (b) => ({ task: store.answer(requireId(b), b.text) }),
    'POST /api/release': (b) => ({ task: store.release(requireId(b)) }),
    'POST /api/cancel': (b) => ({ task: store.cancel(requireId(b), b.text ?? '') }),
    'POST /api/agents/hide': (b) => ({ hidden: store.hideAgents(b.ids) }),
    'POST /api/dismiss': (b) => {
      const dismissed = store.dismiss({ ids: b.ids, role: b.role, all: !!b.all, userApproved: !!b.userApproved, afterTask: !!b.afterTask });
      // 正挂在 wait 上的 worker 立即收到「已下线」（「做完再下线」的等任务结束后由 nextFor 处理）
      for (const { id, later } of dismissed) {
        if (later) continue;
        const waiter = waiters.get(id);
        if (waiter) finishWaiter(id, waiter, 200, { ok: true, result: { kind: 'dismissed' } });
      }
      return { dismissed };
    },
    'POST /api/agents/still-there': (b) => ({ agent: store.keepWaiting(String(b.id ?? '')) }),
    'POST /api/settings': (b) => ({ settings: store.setSettings(b) }),
    'POST /api/agents/keep': (b) => ({ kept: store.keepAgents(b.ids) }),
    'POST /api/reclaim': (b) => {
      const { task, agentId } = store.reclaim(requireId(b), b.text ?? '');
      // 原 worker 若正挂在 wait 上，立即告诉它租约已失效
      const waiter = agentId && waiters.get(agentId);
      if (waiter) {
        finishWaiter(agentId, waiter, 400, { ok: false, code: 'LEASE_LOST', message: `你的租约已失效，任务已被收回。请重新运行 ateam join --role ${task.role} --id ${agentId}（沿用原编号）` });
      }
      return { task, agentId };
    },
    'GET /api/rules': (_b, url) => {
      const rules = readRules();
      const role = url.searchParams.get('role');
      const roles = knownRoles();
      return { rules, ...(role ? { forRole: rulesFor(rules, role) } : {}), unreceived: unreceived(rules, roles), needsTidy: needsTidy(rules), roles };
    },
    'POST /api/rules': (b) => ({ rules: approvedRules(b.text, !!b.userApproved, countsChange(readRules(), String(b.text ?? ''))) }),
    'POST /api/rules/add': (b) => {
      const line = String(b.text ?? '').trim();
      if (!line) throw new AteamError('INVALID', '规则不能为空。');
      const roles = Array.isArray(b.roles) ? b.roles.map(String).filter((r) => r.trim()) : [];
      const { text, section } = addRule(readRules(), line, roles);
      const rule = `- ${line.replace(/^[-*]\s+/, '')}`;
      return { rules: approvedRules(text, !!b.userApproved, `将在 ${section} 段加一条：${rule}。`), section };
    },
    'POST /api/report': (b) => ({ job: store.report(b.jobId, b.report) }),
    'GET /api/state': (_b, url) => ({
      // 看板不用事件列表（命令行 status 要用它数未读事件），?view=dashboard 时去掉，减小数据量
      state: url.searchParams.get('view') === 'dashboard' ? { ...store.state, events: [] } : store.state,
      pending: store.pendingActions(), root, toolDir: TOOL_DIR, home: homedir(), port, repos: layout.mode === 'multi' ? layout.repos : null,
      // 代码已更新但服务还没重启
      stale: codeHash() !== startHash,
      config: store.config(),
      // 待演播的演播卡现在能不能开始、缺什么
      demoBlockers: Object.fromEntries(store.state.tasks.filter((t) => t.kind === 'demo' && t.status === 'ready').map((t) => [t.id, store.demoBlockers(t.id)])),
      // leader 在线：挂着 watch 监听，或 3 分钟内用命令行操作过
      leader: { watching: watchers.size > 0, lastSeenAt: leaderSeenAt, online: leaderOnline() },
    }),
    'GET /api/task': (_b, url) => ({ task: store.getTask(url.searchParams.get('id') ?? '') }),
  };

  function handleWait(body, res) {
    const agentId = body.as;
    // 先结束同一 worker 的旧挂起，再派发：否则旧挂起可能在下一轮 wake 里再收到同一个任务
    const old = waiters.get(agentId);
    if (old) finishWaiter(agentId, old, 200, { ok: true, result: null, waiting: store.waitingInfo(agentId) });

    const result = store.nextFor(agentId); // 先 touch，掉线的 worker 在这里拿到 LEASE_LOST
    if (result) return send(res, 200, { ok: true, result: withRules(result) });

    const waiter = { res, timer: null };
    waiter.timer = setTimeout(() => {
      try {
        store.touch(agentId);
        finishWaiter(agentId, waiter, 200, { ok: true, result: null, waiting: store.waitingInfo(agentId) });
      } catch (err) {
        finishWaiter(agentId, waiter, 400, { ok: false, code: err.code ?? 'INTERNAL', message: err.message });
      }
    }, holdMs(body.timeout));
    waiters.set(agentId, waiter);
    res.on('close', () => {
      if (waiters.get(agentId) === waiter) {
        clearTimeout(waiter.timer);
        waiters.delete(agentId);
      }
    });
  }

  // 报告演播的一步。暂停中：挂起这次请求，继续后放行（记下这一步）；挂满 timeout 还在暂停，
  // 回 paused，worker 原样再运行一次。叫停、中断等也在挂起期间放行，由 demoStep 给出结果
  function demoStepOnce(b) {
    // 从脚本里取这一步的讲解和下一步，给看板提词；读不到脚本就不提词，不影响演播
    let cue = null;
    const held = store.state.agents.find((a) => a.id === b.as)?.currentTask;
    const task = held && store.state.tasks.find((t) => t.id === held && t.kind === 'demo');
    if (task) {
      try {
        const steps = parseSteps(readFileSync(join(root, task.script), 'utf8'));
        const i = steps.findIndex((s) => s.n === Number(b.n));
        const step = i >= 0 ? steps[i] : null;
        cue = { narration: step?.narration ?? '', next: steps[i + 1]?.text ?? '' };
      } catch {}
    }
    return store.demoStep(b.as, b.n, b.total, b.text, cue, !!b.slow);
  }
  function handleDemoStep(body, res) {
    const first = demoStepOnce(body);
    if (!first.paused) return send(res, 200, { ok: true, ...first });
    const taskId = first.task.id;
    const deadline = Date.now() + holdMs(body.timeout);
    const timer = setInterval(() => {
      const t = store.state.tasks.find((x) => x.id === taskId);
      const still = t?.paused && t.status === 'demoing';
      if (still && Date.now() < deadline) return;
      clearInterval(timer);
      if (still) return send(res, 200, { ok: true, ...first, task: t });
      try { send(res, 200, { ok: true, ...demoStepOnce(body) }); } catch (err) { sendError(res, err); }
    }, 500);
    res.on('close', () => clearInterval(timer));
  }

  function handleWatch(body, res) {
    const events = store.takeEvents();
    if (events.length > 0) return send(res, 200, { ok: true, events });
    const watcher = { res, timer: null };
    watcher.timer = setTimeout(() => finishWatcher(watcher, { ok: true, events: [] }), holdMs(body.timeout));
    watchers.add(watcher);
    res.on('close', () => {
      clearTimeout(watcher.timer);
      watchers.delete(watcher);
    });
  }

  // 防止网页跨站调用接口：只认本机 Host（挡 DNS rebinding），POST 必须是 JSON（浏览器跨站发 JSON 需要预检，本服务不响应预检）
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const key = `${req.method} ${url.pathname}`;
    try {
      if (!allowedHosts.has(req.headers.host ?? '')) {
        return send(res, 403, { ok: false, code: 'INVALID', message: `只接受 http://127.0.0.1:${port} 或 http://localhost:${port} 的请求。` });
      }
      if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
        return send(res, 415, { ok: false, code: 'INVALID', message: '请求的 Content-Type 必须是 application/json。请用 ateam 命令行操作。' });
      }
      if (key === 'GET /') {
        try {
          const html = await readFile(DASHBOARD);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('dashboard.html 不存在');
        }
        return;
      }
      const body = req.method === 'POST' ? await readBody(req) : {};
      // 命令行发来、且不带 --as 的请求都是 leader 的（worker 的命令都带 --as）
      if (req.headers['x-ateam-cli'] && !body.as && key !== 'POST /api/join') leaderSeenAt = Date.now();
      if (key === 'GET /api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write('retry: 3000\n\n');
        streams.add(res);
        res.on('close', () => streams.delete(res));
        return;
      }
      if (key === 'POST /api/wait') return handleWait(body, res);
      if (key === 'POST /api/watch') return handleWatch(body, res);
      if (key === 'POST /api/demo/step') return handleDemoStep(body, res);
      const route = routes[key];
      if (!route) throw new AteamError('NOT_FOUND', `未知接口：${key}`);
      const out = await route(body, url);
      if (key === 'GET /api/state') return sendCached(req, res, { ok: true, ...out });
      send(res, 200, { ok: true, ...out });
    } catch (err) {
      sendError(res, err);
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });

  // 租约扫描。判掉线之前，先看 worker 任务路径里有没有比上次心跳更新的文件改动：
  // 埋头写代码、很久没调用 ateam 命令的 worker，只要文件还在变，就不算掉线。
  let sweeping = false;
  async function sweepTick() {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const agent of store.state.agents) {
        if (agent.status !== 'online' || !agent.currentTask || waiters.has(agent.id)) continue;
        if (Date.now() - agent.lastSeenAt <= store.leaseMs) continue;
        const task = store.state.tasks.find((t) => t.id === agent.currentTask);
        if (!task || (task.status !== 'working' && task.status !== 'asking')) continue;
        const ts = await latestChangeTime(root, task.paths).catch(() => null);
        if (ts) store.noteActivity(agent.id, ts);
      }
      store.sweep((id) => waiters.has(id));
      store.expireDemoRequests();
      store.checkIdle();
    } finally {
      sweeping = false;
    }
  }
  // 租约在「设置」里可以改小，扫描间隔按最短 1 分钟的租约算
  const sweepTimer = setInterval(sweepTick, Math.min(20000, leaseMs / 3));
  sweepTimer.unref();
  server.on('close', () => {
    clearInterval(sweepTimer);
    clearInterval(streamTimer);
    clearTimeout(pushTimer);
    for (const res of streams) res.end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`端口 ${port} 被占用。请重新运行 ateam serve（会自动找空闲端口），或用 --port 指定一个。`));
      } else {
        reject(err);
      }
    });
    server.listen(port, '127.0.0.1', resolve);
  });
  // 记下实际端口：端口被占用时会自动换成下一个，项目里的 ateam 命令读这个文件找到服务
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'port'), `${port}\n`);
  server.ateamLayout = layout;
  return server;
}
