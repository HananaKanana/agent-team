'use strict';
// 显示偏好的读写（本机存服务端、局域网只读时存浏览器），局域网只读模式下拦截写操作

// 显示偏好（主题、侧栏、泳道、分组展开等）：本机打开时存在服务端（~/.config/ateam/dashboard.json，服务把它写进页面的
// window.ATEAM_PREFS），换端口、换浏览器都在；局域网只读访问时没有它，存在那台电脑自己的浏览器里。
// PREF_PROJECT 里的只属于当前项目，其余所有项目共用
const PREF_PROJECT = new Set(['ateam.workerOrder', 'ateam.acceptedOpen', 'ateam.openJobsOpen', 'ateam.demoJobsOpen', 'ateam.cancelledJobsOpen', 'ateam.cancelledOpen', 'ateam.syncAutoSeen']);
const prefs = (() => {
  const local = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const srv = window.ATEAM_PREFS;
  if (!srv || typeof srv !== 'object') return local;
  srv.global ??= {}; srv.project ??= {};
  const scope = (k) => PREF_PROJECT.has(k) ? 'project' : 'global';
  return {
    get(k) {
      const box = srv[scope(k)];
      if (Object.hasOwn(box, k)) return box[k];
      // 第一次：把这个浏览器里原来存的搬到服务端
      const old = local.get(k);
      if (old !== null) this.set(k, old);
      return old;
    },
    set(k, v) {
      const value = String(v), box = srv[scope(k)];
      if (box[k] === value) return;
      box[k] = value;
      fetch('/api/prefs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: scope(k), key: k, value }) }).catch(() => {});
    },
  };
})();
// 局域网里的其他电脑打开（ateam --lan）：只读。服务端会拒绝所有改动，这里先拦下，直接给出说明，不发请求
const READONLY = !['127.0.0.1', 'localhost'].includes(location.hostname);
if (READONLY) {
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const method = String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method === 'GET' || method === 'HEAD') return realFetch(input, init);
    const pill = document.getElementById('ro-pill');
    if (pill) { pill.classList.remove('flash'); void pill.offsetWidth; pill.classList.add('flash'); }
    const body = JSON.stringify({ ok: false, code: 'INVALID', message: '局域网访问为只读模式，请在运行 ateam 的电脑上操作。' });
    return Promise.resolve(new Response(body, { status: 403, headers: { 'content-type': 'application/json' } }));
  };
  addEventListener('DOMContentLoaded', () => { document.getElementById('ro-pill').hidden = false; });
}
