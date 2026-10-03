// HTTP 路由、长轮询挂起和唤醒、租约定时扫描、落盘、托管看板。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AteamError } from './errors.js';
import { createStore } from './store.js';
import { loadState, saveState } from './persist.js';
import { commitPaths, ensureGitignore, ensureGitRepo } from './git.js';

const DASHBOARD = join(dirname(fileURLToPath(import.meta.url)), 'dashboard.html');
const MAX_BODY = 1024 * 1024;
const DEFAULT_HOLD_SEC = 90;
const MAX_HOLD_SEC = 110;

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

export async function startServer({ root, port = 7700, leaseMin = 15 } = {}) {
  await ensureGitRepo(root);
  ensureGitignore(root);

  const dataDir = join(root, '.ateam');
  const leaseMs = leaseMin * 60 * 1000;
  const waiters = new Map(); // agentId -> { res, timer }
  const watchers = new Set(); // { res, timer }
  let waking = false;
  let wakeScheduled = false;

  const store = createStore({ state: loadState(dataDir) ?? undefined, leaseMs, onChange });

  // 每次状态变化：落盘，并在下一轮事件循环唤醒挂起的请求。
  // 唤醒过程本身（nextFor 的 touch、takeEvents）也会触发 onChange，用 waking 标记避免循环。
  function onChange() {
    saveState(dataDir, store.state);
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
          if (result) finishWaiter(agentId, waiter, 200, { ok: true, result });
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

  // git 操作串行执行，两个工人的提交排队，不会交错
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

  // 普通路由：返回 JSON 对象（自动加 ok:true）
  const routes = {
    'POST /api/join': (b) => ({ agent: store.join(b.role) }),
    'POST /api/progress': (b) => ({ task: store.progress(b.as, b.text) }),
    'POST /api/ask': (b) => ({ task: store.ask(b.as, b.text) }),
    'POST /api/submit': (b) => serial(async () => {
      const task = store.taskForSubmit(b.as);
      if (typeof b.summary !== 'string' || !b.summary.trim()) {
        throw new AteamError('INVALID', '提交总结不能为空。请写明做了什么、怎么验证的。');
      }
      let commit = null;
      if (!b.noChanges) {
        const result = await commitPaths(root, task.paths, `[${task.id}] ${b.summary.trim()}`);
        if (result.nothing) {
          throw new AteamError('INVALID', `指定路径（${task.paths.join('、')}）下没有改动；如确实无需改代码，请加 --no-changes。`);
        }
        commit = result.sha;
      }
      return { task: store.recordSubmit(b.as, b.summary, commit), commit };
    }),
    'POST /api/jobs': (b) => ({ job: store.createJob({ title: b.title, description: b.description }) }),
    'POST /api/tasks': (b) => ({
      task: store.addTask({
        jobId: b.jobId, title: b.title, role: b.role, paths: b.paths,
        description: b.description, acceptance: b.acceptance, dependsOn: b.dependsOn,
      }),
    }),
    'POST /api/tasks/edit': (b) => {
      const { id, ...patch } = b;
      return { task: store.editTask(requireId({ id }), patch) };
    },
    'POST /api/approve': (b) => ({ task: store.approve(requireId(b), b.text ?? '') }),
    'POST /api/reject': (b) => ({ task: store.reject(requireId(b), b.text) }),
    'POST /api/answer': (b) => ({ task: store.answer(requireId(b), b.text) }),
    'POST /api/release': (b) => ({ task: store.release(requireId(b)) }),
    'POST /api/report': (b) => ({ job: store.report(b.jobId, b.report) }),
    'GET /api/state': () => ({ state: store.state, pending: store.pendingActions() }),
    'GET /api/task': (_b, url) => ({ task: store.getTask(url.searchParams.get('id') ?? '') }),
  };

  function handleWait(body, res) {
    const agentId = body.as;
    const result = store.nextFor(agentId); // 先 touch，掉线的工人在这里拿到 LEASE_LOST
    if (result) return send(res, 200, { ok: true, result });

    const old = waiters.get(agentId);
    if (old) finishWaiter(agentId, old, 200, { ok: true, result: null });

    const waiter = { res, timer: null };
    waiter.timer = setTimeout(() => {
      try {
        store.touch(agentId);
        finishWaiter(agentId, waiter, 200, { ok: true, result: null });
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

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const key = `${req.method} ${url.pathname}`;
    try {
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
      if (key === 'POST /api/wait') return handleWait(body, res);
      if (key === 'POST /api/watch') return handleWatch(body, res);
      const route = routes[key];
      if (!route) throw new AteamError('NOT_FOUND', `未知接口：${key}`);
      const out = await route(body, url);
      send(res, 200, { ok: true, ...out });
    } catch (err) {
      sendError(res, err);
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });

  const sweepTimer = setInterval(() => {
    store.sweep((id) => waiters.has(id));
  }, Math.min(30000, leaseMs / 3));
  sweepTimer.unref();
  server.on('close', () => clearInterval(sweepTimer));

  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`端口 ${port} 被占用。请用 --port 换一个端口，并设置 ATEAM_URL=http://127.0.0.1:<端口>`));
      } else {
        reject(err);
      }
    });
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}
