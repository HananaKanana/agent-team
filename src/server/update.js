// 升级（安装版查新版本、下载安装）和停止 / 重启服务

import { spawn } from 'node:child_process';
import { existsSync, openSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { AteamError } from '../errors.js';
import { APP_DIR, devRepo, installed, mode as runMode, modeLabel, version as ateamVersion, WIN, WRAPPER } from '../install.js';
import { saveState } from '../persist.js';
import { check as checkRelease, install as installRelease } from '../update.js';
import { argv, dataDir, httpServer, port, root, store } from './context.js';
import { pushSoon } from './live.js';
import { syncFinal } from './sync.js';

// ---------- 升级（只有安装版查，见 update.js）----------
export const UPDATE_EVERY = 6 * 60 * 60 * 1000;
export const updateInfo = { current: ateamVersion(), latest: null, newer: false, releases: [], checkedAt: 0, error: null };
let updateJob = null; // 正在下载安装的版本：{ version, received, total, status: downloading|opened|failed, error }
export async function checkUpdate() {
  if (runMode() !== 'installed') return;
  Object.assign(updateInfo, await checkRelease());
  pushSoon();
}
export function updateSummary() {
  const { releases, ...rest } = updateInfo;
  const m = runMode();
  return { ...rest, mode: m, modeLabel: modeLabel(m), devRepo: m === 'dev' ? devRepo() : null, job: updateJob };
}
export function startUpdate(wanted) {
  if (runMode() !== 'installed') throw new AteamError('INVALID', runMode() === 'dev' ? '当前是开发模式，代码来自源码仓库，不通过安装包更新。' : '当前不是安装版，请下载安装包安装。');
  if (updateJob?.status === 'downloading') throw new AteamError('BAD_STATE', `正在下载 ${updateJob.version}，请稍候。`);
  updateJob = { version: wanted ?? updateInfo.latest, received: 0, total: 0, status: 'downloading', error: null };
  let last = 0;
  installRelease(wanted, ({ received, total }) => {
    Object.assign(updateJob, { received, total });
    if (Date.now() - last > 500) { last = Date.now(); pushSoon(); }
  }).then((r) => { Object.assign(updateJob, { version: r.version, status: 'opened' }); pushSoon(); },
    (err) => { Object.assign(updateJob, { status: 'failed', error: err.message }); pushSoon(); });
  pushSoon();
  return { started: true };
}

// ---------- 停止 / 重启（菜单栏程序和看板「重启」按钮用，只限本机）----------
let stopping = false;
export function stopServer(restart) {
  if (stopping) return;
  stopping = true;
  saveState(dataDir, store.state);
  // 停止（不是重启）时先告诉同事「已停止」，最多等 5 秒
  (restart ? Promise.resolve() : syncFinal()).finally(() => { httpServer.close(() => {
    if (restart) {
      // 原来的启动参数，端口固定为当前端口；输出写到 .ateam/serve.log，在后台运行
      const args = [];
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--port') { i++; continue; }
        if (String(argv[i]).startsWith('--port=')) continue;
        args.push(argv[i]);
      }
      // 装了安装包：用 /usr/local/bin/ateam 启动（它按开发模式 / 安装版选代码，切换模式后重启也跟着走）。
      // 否则用当前程序的真实路径：argv[1] 可能是 npm link 的软链，装安装包时会被删掉
      const logFile = join(dataDir, 'serve.log');
      let script = process.argv[1];
      try { script = realpathSync(script); } catch {}
      // Windows：ateam.cmd 不能直接 spawn（要经过 cmd），也不需要：按启动脚本的规则（开发模式用仓库、否则用安装目录）选好代码，用同一个 node 跑
      if (WIN && installed()) script = join(devRepo() ?? APP_DIR, 'bin', 'ateam.js');
      const [cmd, ...pre] = !WIN && existsSync(WRAPPER) ? [WRAPPER] : [process.execPath, script];
      const all = [...pre, ...args, '--port', String(port)];
      let child;
      if (WIN) {
        // 托盘经「cmd /c ... >> serve.log」启动的服务：那个 cmd 一直占着 serve.log，直到本进程退出，这里打开会 EBUSY。
        // 所以也经 cmd 启动新服务，先等两秒（本进程和旧 cmd 退出、放开文件）再打开日志
        const quoted = [cmd, ...all].map((a) => `"${a}"`).join(' ');
        child = spawn('cmd.exe', ['/d', '/s', '/c', `"ping -n 3 127.0.0.1 >nul & ${quoted} >> "${logFile}" 2>&1"`],
          { cwd: root, detached: true, stdio: 'ignore', env: process.env, windowsHide: true, windowsVerbatimArguments: true });
      } else {
        // 打不开日志也照样重启，输出丢掉而已，不能让服务就此停掉
        let log = 'ignore';
        try { log = openSync(logFile, 'a'); } catch {}
        child = spawn(cmd, all, { cwd: root, detached: true, stdio: ['ignore', log, log], env: process.env });
      }
      child.unref();
      console.log(`\nateam 服务已在后台重启（进程 ${child.pid}），输出写到 ${join(dataDir, 'serve.log')}。`);
    } else {
      console.log('\nateam 服务已停止。');
    }
    process.exit(0);
  });
  httpServer.closeAllConnections?.();
  });
}
