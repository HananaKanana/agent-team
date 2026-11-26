// HTTP：读请求体、发响应、只认本机、串行执行 git 操作、请求分发

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AteamError } from '../errors.js';
import { viewPrefs } from '../view-prefs.js';
import { lan, port, root } from './context.js';
import { handleDemoStep, handleWait, handleWatch, leaderSeen, streams } from './live.js';
import { workerRoutes } from './routes-worker.js';
import { leadRoutes } from './routes-lead.js';
import { demoRoutes } from './routes-demo.js';
import { systemRoutes } from './routes-system.js';

// 普通路由：返回 JSON 对象（自动加 ok:true）
const routes = { ...workerRoutes, ...leadRoutes, ...demoRoutes, ...systemRoutes };

export function send(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}
export function sendError(res, err) {
  if (err instanceof AteamError) send(res, 400, { ok: false, code: err.code, message: err.message });
  else send(res, 500, { ok: false, code: 'INTERNAL', message: err?.message ?? String(err) });
}

// 看板：src/dashboard/ 下的 index.html、css/、js/，浏览器直接加载，不需要构建
const DASHBOARD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'dashboard');
const MAX_BODY = 1024 * 1024;

const DASHBOARD = join(DASHBOARD_DIR, 'index.html');
const DASHBOARD_ASSET = /^\/(css|js)\/[a-z0-9-]+\.(css|js)$/;
const ASSET_TYPE = { css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8' };
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

// git 操作串行执行，两个 worker 的提交排队，不会交错
let gitQueue = Promise.resolve();
export function serial(fn) {
  const run = gitQueue.then(fn, fn);
  gitQueue = run.catch(() => {});
  return run;
}

export function requireId(body) {
  if (typeof body.id !== 'string' || !body.id.trim()) throw new AteamError('INVALID', '缺少任务编号（例如 T3）。');
  return body.id.trim();
}

// 防止网页跨站调用接口：只认本机 Host（挡 DNS rebinding），POST 必须是 JSON（浏览器跨站发 JSON 需要预检，本服务不响应预检）。
// 局域网模式下，不是从本机来的请求只读
// 按当前端口算：自动换端口时 port 在监听成功后才定下来
const allowedHost = (h) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;
const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '');

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const key = `${req.method} ${url.pathname}`;
  try {
    const local = isLoopback(req) && allowedHost(req.headers.host ?? '');
    if (!local) {
      if (!lan) {
        return send(res, 403, { ok: false, code: 'INVALID', message: `只接受 http://127.0.0.1:${port} 或 http://localhost:${port} 的请求。` });
      }
      // 别的电脑只读：只放行 GET（看板页面、状态、卡片详情、事件流），任何改动都拒绝
      // 命令行请求（会被当成 leader 在线）也只认本机；leader 已读标记不让远程看板顺带写
      if (req.method !== 'GET' || req.headers['x-ateam-cli']) {
        return send(res, 403, { ok: false, code: 'INVALID', message: '局域网访问是只读的，改动只能在运行 ateam 的那台电脑上操作。' });
      }
      url.searchParams.delete('reader');
    }
    if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      return send(res, 415, { ok: false, code: 'INVALID', message: '请求的 Content-Type 必须是 application/json。请用 ateam 命令行操作。' });
    }
    if (key === 'GET /') {
      try {
        let html = await readFile(DASHBOARD, 'utf8');
        // 本机打开：把显示偏好写进页面，看板同步读到（换端口、换浏览器都在）。局域网只读访问不给，用那台电脑自己的浏览器
        if (local) {
          const prefs = JSON.stringify(viewPrefs(root)).replace(/</g, '\\u003c');
          html = html.replace('<!-- ateam:prefs -->', `<script>window.ATEAM_PREFS = ${prefs};</script>`);
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('src/dashboard/index.html 不存在');
      }
      return;
    }
    // 看板的样式和脚本：只认 /css/<名字>.css、/js/<名字>.js，名字只有小写字母、数字和连字符，读不到 src/dashboard 以外的文件
    if (req.method === 'GET' && DASHBOARD_ASSET.test(url.pathname)) {
      const [, dir, ext] = url.pathname.match(DASHBOARD_ASSET);
      if (dir !== ext) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
      try {
        const body = await readFile(join(DASHBOARD_DIR, url.pathname.slice(1)));
        // 每次都向服务确认：改了看板刷新就生效
        res.writeHead(200, { 'content-type': ASSET_TYPE[ext], 'cache-control': 'no-cache' });
        res.end(body);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
      }
      return;
    }
    const body = req.method === 'POST' ? await readBody(req) : {};
    // 命令行发来、且不带 --as 的请求都是 leader 的（worker 的命令都带 --as）
    if (req.headers['x-ateam-cli'] && !body.as && !req.headers['x-ateam-as'] && key !== 'POST /api/join') {
      leaderSeen(key !== 'POST /api/watch');
    }
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
