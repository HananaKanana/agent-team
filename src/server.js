// HTTP 服务的启动：设置上下文、建 store、开定时器、监听端口。各部分在 src/server/ 下

import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { detectRepos, ensureGitignore } from './git.js';
import { rememberProject } from './install.js';
import { loadState, saveState } from './persist.js';
import { createStore } from './store.js';
import { dataDir, initContext, leaseMs, setHttpServer, setLanUrls, setPort, setStore, store } from './server/context.js';
import { handle } from './server/http.js';
import { lanAddresses } from './server/install-info.js';
import { onChange, pushAll, pushTimer, streams, sweepTick } from './server/live.js';
import { checkRotate, recheck, refreshEgoProfiles, rotateSpawn } from './server/agents.js';
import { checkUpdate, stopServer, UPDATE_EVERY } from './server/update.js';
import { checkPush } from './server/push.js';
import { loadUsageHistory, snapshotTokens, usageReport } from './server/usage.js';
import { loadSyncConfig, syncAuto, syncCfg, syncTick } from './server/sync.js';
import { killPrompter } from './server/routes-demo.js';


// argv：启动参数（重启时原样带上，端口固定为当前端口）
export async function startServer({ root, port = 7700, autoPort = false, leaseMin = 15, idleMin = 3, lan = false, argv = [] } = {}) {
  const layout = await detectRepos(root);
  initContext({ root, layout, lan, argv, port, leaseMin });
  // 单仓库：把 .ateam/ 加进项目的 .gitignore。多仓库：项目目录本身不是仓库，不用加
  if (layout.mode === 'single') ensureGitignore(root);
  loadUsageHistory();
  loadSyncConfig();

  setStore(createStore({ state: loadState(dataDir) ?? undefined, leaseMs, idleMs: idleMin * 60 * 1000, onChange, onRotate: rotateSpawn }));
  // 启动时按当前版本的文件布局写一遍（新加的拆分方式马上生效，不用等第一次状态变化；内容没变的文件不会重写）
  saveState(dataDir, store.state);

  // leader 在线与否、心跳时间这类随时间变化的状态没有对应的 onChange，定时推一下
  const streamTimer = setInterval(() => pushAll('tick'), 15000);
  streamTimer.unref();

  process.on('exit', () => killPrompter());
  // Ctrl+C、kill：和「停止」按钮一样正常停止（保存状态，开着看板同步时告诉同事已停止）
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => stopServer(false));

  const server = http.createServer((req, res) => { handle(req, res); });
  setHttpServer(server);

  // 租约在「设置」里可以改小，扫描间隔按最短 1 分钟的租约算
  const sweepTimer = setInterval(sweepTick, Math.min(20000, leaseMs / 3));
  sweepTimer.unref();
  server.on('close', () => {
    clearInterval(sweepTimer);
    clearInterval(streamTimer);
    clearTimeout(pushTimer);
    for (const res of streams) res.end();
  });

  // autoPort：端口是自动选的（没指定 --port），监听那一刻被别的进程抢先就往后换，最多试 10 个。
  // 不能在外面重新调 startServer：这次已经建好的 store 和定时器会留下，两份同时写数据
  const listenOn = (p) => new Promise((resolve, reject) => {
    const onError = (err) => { server.off('listening', onListening); reject(err); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(p, lan ? '0.0.0.0' : '127.0.0.1');
  });
  for (let tries = 0; ; tries++) {
    try {
      await listenOn(port);
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      if (autoPort && tries < 9 && port < 65535) { port++; continue; }
      throw Object.assign(new Error(`端口 ${port} 被占用。请重新运行 ateam serve（会自动找空闲端口），或用 --port 指定一个。`), { code: 'EADDRINUSE' });
    }
  }
  setPort(port);
  server.ateamPort = port;
  // 记下实际端口：端口被占用时会自动换成下一个，项目里的 ateam 命令读这个文件找到服务
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'port'), `${port}\n`);
  server.ateamLayout = layout;
  if (lan) server.ateamLan = lanAddresses().map((ip) => `http://${ip}:${port}`);
  setLanUrls(server.ateamLan ?? []);
  recheck().catch(() => {});
  if (store.config().testBrowser === 'ego') refreshEgoProfiles().catch(() => {});
  // 菜单栏程序的项目列表
  rememberProject(root);
  // 安装版：启动时和之后每 6 小时查一次新版本
  checkUpdate().catch(() => {});
  setInterval(() => checkUpdate().catch(() => {}), UPDATE_EVERY).unref();
  // 推送到手机：每 15 秒看一次待处理清单
  setTimeout(() => checkPush().catch(() => {}), 5000).unref();
  setInterval(() => checkPush().catch(() => {}), 15000).unref();
  // token 用量：每分钟把新通过的卡的用量记到卡上
  // 启动 10 秒后先算一遍（顺带把会话记录解压进缓存，之后打开「用量」页就快了），之后每分钟看一次
  setTimeout(() => { usageReport(true).then(snapshotTokens).catch(() => {}); }, 10000).unref();
  setInterval(() => { snapshotTokens().catch(() => {}); checkRotate().catch(() => {}); }, 60000).unref();
  setInterval(() => { syncTick().catch(() => {}); syncAuto().catch(() => {}); }, 60000).unref();
  setTimeout(() => { (syncCfg.enabled ? syncTick() : syncAuto()).catch(() => {}); }, 5000).unref();
  return server;
}
