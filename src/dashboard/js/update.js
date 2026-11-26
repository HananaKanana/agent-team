// 版本与更新、运行模式、重启服务

import { READONLY } from './prefs.js';
import { data, setView } from './state.js';
import { el, fill } from './util.js';
import { frozenDemo, modeWord } from './demo.js';
import { poll, render, saveView } from './app.js';

// data.update：当前版本、运行模式、最新版本、正在下载的更新（每次轮询都有）
let updateError = null; // 点「有新版本」后安装请求失败的原因
async function installVersion(version) {
  updateError = null;
  try {
    const out = await (await fetch('/api/update/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(version ? { version } : {}) })).json();
    if (!out.ok) updateError = out.message;
  } catch { updateError = '无法连接 ateam 服务。'; }
  await poll();
  renderUpdatePill();
}
function updateJobLine(job) {
  if (!job) return null;
  if (job.status === 'downloading') return `正在下载 ${job.version ?? '新版本'}${job.total ? `：${Math.floor((job.received / job.total) * 100)}%` : '……'}`;
  if (job.status === 'opened') return `${job.version} 已下载并通过校验，已打开安装程序。请按提示输入管理员密码完成安装，安装后按页面提示重启服务。`;
  return `更新失败：${job.error}`;
}
export function renderUpdatePill() {
  const btn = document.getElementById('update-pill');
  const u = data?.update;
  const downloading = u?.job?.status === 'downloading';
  // 页头 ateam 旁的版本号；开发模式、源码运行时悬停说明
  const ver = document.getElementById('ver');
  ver.textContent = u?.current ?? '';
  ver.title = !u ? '' : u.mode === 'dev'
    ? `开发模式：ateam 命令、skill 和 hook 使用源码仓库的代码（${(u.modeLabel ?? '').replace(/^[^：]*：/, '')}），修改后重启服务即生效，不检查更新。切回安装版请运行 ateam dev off。`
    : u.mode === 'installed' ? `当前版本 ${u.current}` : '当前直接从源码运行，未安装 ateam 安装包，不检查更新。';
  if (READONLY || !u || (!u.newer && !downloading)) { btn.hidden = true; return; }
  fill(btn, el('span', null, updateError ? `更新失败：${updateError}` : u.job ? updateJobLine(u.job) : `有新版本 ${u.latest}`));
  btn.title = downloading ? '正在下载安装包' : `点击下载并安装 ${u.latest ?? ''}：核对校验后打开系统安装程序，需要输入一次管理员密码；装完后重启服务。`;
  btn.onclick = (e) => { e.stopPropagation(); if (!downloading && u.newer) installVersion(u.latest); };
  btn.hidden = false;
}
// 「服务需要重启」的「重启」：服务在后台按原参数重新启动，连上新服务后刷新页面
export async function restartServer(btn) {
  btn.disabled = true;
  btn.textContent = '重启中…';
  const tip = (text) => {
    btn.disabled = false;
    btn.textContent = '重启';
    btn.after(Object.assign(document.createElement('span'), { className: 'hint stale-tip', textContent: text }));
  };
  document.querySelectorAll('.stale-tip').forEach((n) => n.remove());
  try {
    const res = await fetch('/api/restart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
    // 旧版本服务没有这个接口
    if (res.status === 404) return tip('当前运行的服务版本较旧，不支持从看板重启。请在运行 ateam 的终端中按 Ctrl+C 后重新运行 ateam，之后即可使用此按钮。');
  } catch {}
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      // 每次最多等 2 秒：重启那一刻连到正在关闭的旧服务的请求可能一直不返回
      const out = await (await fetch('/api/summary', { cache: 'no-store', signal: AbortSignal.timeout(2000) })).json();
      if (out.ok && !out.stale) { location.reload(); return; }
    } catch {}
  }
  tip('服务未能在 30 秒内重新启动，请查看项目中的 .ateam/serve.log，或在终端中运行 ateam 启动。');
}
export function renderModePill() {
  const btn = document.getElementById('mode-pill');
  const t = data && frozenDemo();
  if (!t) { btn.hidden = true; btn.replaceChildren(); return; }
  fill(btn,
    el('span', { class: 'pulse' }),
    el('span', null, t.status === 'queued' ? `等待${modeWord(t)}` : `${modeWord(t)}中`),
    el('span', { class: 'sub' }, '· 派发已暂停'));
  btn.title = `${t.id} ${t.title}\n${modeWord(t)}期间暂停派发新任务，结束或叫停后自动恢复。点击查看`;
  btn.onclick = (e) => { e.stopPropagation(); setView({ job: t.jobId, task: null, report: false }); saveView(); render(); };
  btn.hidden = false;
}
