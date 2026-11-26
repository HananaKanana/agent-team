// 多人协作：同步设置、负责人、同事页

import { prefs, READONLY } from './prefs.js';
import { data, LANE_LABEL, view } from './state.js';
import { ago, el, emptyState, fill, fmtTime, icon, laneOf, renderMarkdown, roleStyle } from './util.js';
import { saveSetting } from './settings.js';
import { closeHelper, helper, openHelper, renderHelper } from './helper.js';
import { navCollapsed } from './jobs.js';
import { closeUsage, openUsage, usageOpen } from './usage.js';
import { toastX } from './app.js';

export let syncInfo = null; // /api/sync 的结果
let syncLoadedAt = 0;
let syncMsg = null;
let syncMsgBad = false; // syncMsg 是失败原因（红字）
let syncBusy = false;
let untrackArmed = false; // 「停止在仓库中跟踪看板文件」点第一次后变成「确认提交」
async function loadSync() {
  syncLoadedAt = Date.now();
  try {
    const out = await (await fetch('/api/sync', { cache: 'no-store' })).json();
    if (out.ok) syncInfo = out.sync;
  } catch {}
  if (helper.open && helper.tab === 'settings') renderHelper(true);
  if (peersOpen) renderPeersPage();
  renderPeersBtn();
}
async function postSync(path, body) {
  syncBusy = true;
  syncMsg = null;
  if (helper.open) renderHelper(true);
  try {
    const out = await (await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    if (out.ok) {
      syncInfo = out.sync;
      syncMsgBad = !!out.untrackError;
      syncMsg = out.untrackError ? out.untrackError : out.untrack ? (out.untrack.nothing ? '看板文件已不在仓库中跟踪。' : `已提交 ${out.untrack.sha}：看板文件不再随代码提交，本地文件保留。该提交尚未推送，请照常推送；同事拉取后，其 ateam 将自动开启看板同步。`) : '已保存。';
    } else { syncMsg = out.message; syncMsgBad = true; }
  } catch { syncMsg = '无法连接 ateam 服务。'; syncMsgBad = true; }
  syncBusy = false;
  untrackArmed = false;
  if (helper.open) renderHelper(true);
  renderPeersBtn();
}
// 代码分支：和远程的差距 + 自动推送 / 拉取 / 共享用量的开关（多人协作开启后才显示）
function codeSettings(s, ro) {
  const cfg = data.config || {};
  const c = s.code;
  const sw = (key, label, hint) => {
    const input = el('input', { type: 'checkbox', class: 'switch', role: 'switch', disabled: READONLY });
    input.checked = !!cfg[key];
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('change', () => saveSetting(key, input.checked));
    return el('label', { class: 'setting' }, input, el('span', null, el('b', null, label), el('span', { class: 'hint' }, hint)));
  };
  const line = !c ? '尚未检查。'
    : c.detached ? '当前不在任何分支上（分离 HEAD），不检查。'
    : c.noUpstream ? `远程没有 ${c.branch} 分支，不检查。`
    : null;
  const status = line ? el('span', { class: 'hint' }, line) : el('span', { class: 'code-line' },
    el('span', null, '分支 ', el('b', null, c.branch)),
    el('span', { class: c.ahead ? 'bad' : '' }, c.ahead ? `领先远程 ${c.ahead} 个提交（未推送）` : '无未推送的提交'),
    el('span', { class: c.behind ? 'bad' : '' }, c.behind ? `落后远程 ${c.behind} 个提交` : '与远程同步'),
    c.dirty ? el('span', null, '有未提交的改动') : null,
    c.checkedAt ? el('span', { class: 'hint' }, `${ago(c.checkedAt)}检查`) : null);
  return [
    el('div', { class: 'setting' }, el('span', null, el('b', null, '代码分支'),
      el('span', { class: 'hint' }, '同事拿到你的代码要靠推送，你拿到同事的代码要靠拉取。每分钟检查一次本地分支与远程的差距：有提交超过 30 分钟未推送、落后远程超过 10 分钟时列入「待处理」。同事已通过但尚未推送的任务，与其路径重叠的本机任务会等其推送后再派发。'),
      status, c?.error ? el('span', { class: 'hint sync-msg' }, c.error) : null)),
    sw('autoPush', '自动推送', '本地分支领先远程、且未落后时，自动推送到远程同名分支（不强制推送；远程有新提交时改为提醒）。会改动大家共用的分支，请确认团队允许后开启。'),
    sw('autoPull', '自动拉取', '本地分支落后远程、没有未推送的提交、且已跟踪的文件没有未提交的改动时，自动快进到远程（不合并；worker 正在修改文件时改为提醒）。'),
    sw('shareUsage', '向同事共享用量摘要', '同步看板时附带每天的 token 合计、已通过的任务数、每张任务的平均用量和打回率，同事可在「用量 → 团队」中查看。不包含会话内容。'),
  ];
}
// 目录归属：.ateam/owners.md
let ownersText = null;
let ownersMsg = null;
async function loadOwners() {
  try { const out = await (await fetch('/api/owners', { cache: 'no-store' })).json(); if (out.ok) ownersText = out.text; } catch {}
  if (helper.open && helper.tab === 'settings') renderHelper(true);
}
function ownersSettings(ro) {
  if (ownersText === null) { loadOwners(); return el('p', { class: 'hint' }, '读取中…'); }
  const area = el('textarea', { class: 'owners-edit', spellcheck: 'false', disabled: READONLY, placeholder: '# 每行一条：路径 同步名称（可写多个）\nserver/  liuxiuqi\nweb/     kana' });
  area.value = ownersText;
  area.addEventListener('click', (e) => e.stopPropagation());
  const save = el('button', { class: 'btn sm', type: 'button', disabled: READONLY, onclick: async (e) => {
    e.preventDefault(); e.stopPropagation();
    try {
      const out = await (await fetch('/api/owners', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: area.value }) })).json();
      if (out.ok) { ownersText = out.text; ownersMsg = `已保存，共 ${out.entries.length} 条。文件为 .ateam/owners.md，提交并推送后同事可见。`; } else ownersMsg = out.message;
    } catch { ownersMsg = '无法连接 ateam 服务。'; }
    renderHelper(true);
  } }, '保存');
  return el('div', { class: 'setting owners-setting' }, el('span', null, el('b', null, '目录归属'),
    el('span', { class: 'hint' }, '声明各目录由谁负责，名称使用同步名称。leader 建卡或修改路径时，路径落在他人负责的目录中会收到提醒（仅提醒，不影响派发）；同事页显示各人负责的目录。保存在 .ateam/owners.md，随代码提交，团队共用。'),
    area, el('span', null, save), ownersMsg ? el('span', { class: 'hint' }, ownersMsg) : null));
}
export function syncSettings() {
  const s = syncInfo;
  if (Date.now() - syncLoadedAt > 30000) loadSync(); // 打开设置页时刷新一次（命令行开启、同步状态变化）
  if (!s) return el('p', { class: 'hint' }, '读取中…');
  const ro = READONLY || syncBusy;
  const stop = (e) => e.stopPropagation();
  const toggle = el('input', { type: 'checkbox', class: 'switch', role: 'switch', disabled: ro });
  toggle.checked = !!s.enabled;
  toggle.addEventListener('click', stop);
  toggle.addEventListener('change', () => postSync('/api/sync', { enabled: toggle.checked }));
  const name = el('input', { type: 'text', class: 'setting-num setting-text', value: s.name || '', placeholder: s.defaultName || '', disabled: ro, spellcheck: 'false' });
  name.addEventListener('click', stop);
  name.addEventListener('change', () => postSync('/api/sync', { name: name.value.trim() }));
  const remote = el('input', { type: 'text', class: 'setting-num setting-text', value: s.remote || 'origin', disabled: ro, spellcheck: 'false' });
  remote.addEventListener('click', stop);
  remote.addEventListener('change', () => postSync('/api/sync', { remote: remote.value.trim() }));
  const agoText = (t) => (t ? ago(t) : '尚未');
  const status = syncMsg && syncMsg !== '已保存。' ? syncMsg : !s.enabled ? (s.autoError ? `检测到本项目已改用看板同步，但自动开启失败：${s.autoError}请修改同步名称后手动开启。` : '未开启。')
    : s.error ? `同步失败：${s.error}`
    : `已同步到分支 ateam/${s.name}。上次推送：${agoText(s.pushedAt)}，上次拉取：${agoText(s.fetchedAt)}；同事 ${s.peers?.length ?? 0} 人。${s.autoAt ? `${fmtTime(s.autoAt)} 检测到本项目已改用看板同步，自动开启。` : ''}`;
  return [
    el('label', { class: 'setting' }, toggle, el('span', null, el('b', null, '同步看板'),
      el('span', { class: 'hint' }, '多人在同一项目中各自使用 ateam 时开启。本机看板（需求、任务、归档）同步到 git 远程的 ateam/<同步名称> 分支，每分钟拉取一次同事的看板：需求栏底部「同事」可查看其进行中的需求和任务；同事正在修改的路径，本机的任务会等其提交后再派发（对方超过 2 小时未同步时不再等待）。同步使用本机已有的 git 凭据，不改动工作区和代码分支。'),
      el('span', { class: `hint${status === syncMsg && syncMsgBad ? ' sync-msg' : ''}` }, status))),
    el('label', { class: 'setting' }, name, el('span', null, el('b', null, '同步名称'),
      el('span', { class: 'hint' }, `分支名为 ateam/<同步名称>，同事看到的也是这个名称。只能使用小写字母、数字和连字符；留空则使用 ${s.defaultName || 'git 用户名'}。已被其他电脑使用的名称无法开启。`))),
    el('label', { class: 'setting' }, remote, el('span', null, el('b', null, '远程'),
      el('span', { class: 'hint' }, '同步使用的 git 远程，默认 origin；项目没有 origin 且只有一个远程时，开启时自动改用该远程。远程需允许创建 ateam/ 开头的分支。'))),
    s.repos ? (() => {
      const sel = el('select', { class: 'setting-num', disabled: ro }, s.repos.map((r) => el('option', { value: r }, r)));
      sel.value = s.repo && s.repos.includes(s.repo) ? s.repo : s.repos[0];
      sel.addEventListener('click', stop);
      sel.addEventListener('change', () => postSync('/api/sync', { repo: sel.value }));
      return el('label', { class: 'setting' }, sel, el('span', null, el('b', null, '同步使用的仓库'), el('span', { class: 'hint' }, '多仓库模式下，看板分支存放在所选仓库的远程中。')));
    })() : null,
    s.tracked ? el('div', { class: 'setting' },
      el('button', { class: untrackArmed ? 'btn primary' : 'btn', type: 'button', disabled: ro || !s.enabled || !!s.error, onclick: (e) => {
        e.preventDefault(); stop(e);
        if (!untrackArmed) { untrackArmed = true; renderHelper(true); return; }
        postSync('/api/sync/untrack', {});
      } }, untrackArmed ? '确认提交' : '停止跟踪'),
      el('span', null, el('b', null, '看板文件仍在仓库中被跟踪'),
        el('span', { class: 'hint' }, `当前分支跟踪着 ${s.tracked} 个看板文件，同事拉取代码后会读到你的看板。打开上方「同步看板」开关时，同步成功后会自动完成这一步；也可在同步正常时点击「停止跟踪」：在当前分支提交一次改动，将看板文件（board.json、archive/、demos/）移出版本控制并加入 .ateam/.gitignore，本地文件保留，不推送。同事拉取该提交后，其工作区中的这些文件会被删除，其本人的看板不受影响。`))) : null,
    syncMsg && syncMsg !== status ? el('p', { class: 'hint' }, syncMsg) : null,
    s.enabled ? codeSettings(s, ro) : null,
    s.enabled ? ownersSettings(ro) : null,
  ];
}
// 「同事」整页：同事看板里进行中的需求和卡，只读
export let peersOpen = false;
let peerOpenTask = null; // 展开详情的卡：「名字·编号」
// 同事名字的头像：首字母 + 按名字算出的固定色相
export const peerHue = (name) => { let h = 0; for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360; return h; };
// 同事的在线状态（服务端 syncStatus 算好的 state）
const PEER_STATE = {
  busy: ['工作中', '服务运行中，有 worker 在处理任务'],
  idle: ['在线', '服务运行中，暂无 worker 在处理任务'],
  offline: ['离线', '超过 15 分钟未同步，可能已关机或断网'],
  stopped: ['已停止', '对方已停止 ateam 服务'],
  away: ['超过 2 小时未同步', '超过 2 小时未同步，其任务不再阻止本机派发'],
};
function peerFace(name, state) {
  return el('span', { class: `peer-face${state === 'offline' || state === 'stopped' || state === 'away' ? ' dim' : ''}`, style: `--h:${peerHue(name)}`, 'data-state': state || null, 'aria-hidden': 'true' }, [...name][0]?.toUpperCase() ?? '?');
}
// 「liuxiuqi · 工作中 · 3 个 worker，正在做 T5、T6 · 1 分钟前同步」
function peerTip(p) {
  const st = PEER_STATE[p.state]?.[0] ?? '';
  const ws = p.presence?.workers ?? [];
  const doing = ws.filter((w) => w.task).map((w) => w.task);
  const who = p.presence ? `${ws.length} 个 worker${doing.length ? `，正在做 ${doing.join('、')}` : ''}${p.presence.leader ? '' : '，leader 未连接'}` : null;
  return [p.name, st, who, `${ago(p.at)}同步`].filter(Boolean).join(' · ');
}
// 需求栏底部：「用量」一直在，「同事」开启看板同步后显示
export function peersNav() {
  const item = (ico, label, tip, current, onclick, extra) => el('button', { type: 'button', title: tip, 'aria-label': label, 'aria-current': current ? 'true' : 'false', onclick: (e) => { e.stopPropagation(); onclick(); } },
    icon(ico), navCollapsed ? null : el('span', { class: 'label' }, label), navCollapsed ? null : extra);
  const usage = item('chart', '用量', 'token 用量统计', usageOpen, () => { if (usageOpen) closeUsage(); else { if (peersOpen) closePeers(); openUsage(); } });
  let peers = null;
  if (syncInfo?.enabled) {
    const list = syncInfo.peers ?? [];
    const busy = list.reduce((n, p) => n + (p.tasks?.length ?? 0), 0);
    const tip = list.length ? `同事的进度（进行中 ${busy} 张卡）\n${list.map(peerTip).join('\n')}` : '同事的进度：尚无同事开启看板同步';
    peers = item('users', '同事', tip, peersOpen, () => { if (peersOpen) closePeers(); else { if (usageOpen) closeUsage(); openPeers(); } },
      list.length ? el('span', { class: 'faces' }, list.slice(0, 4).map((p) => peerFace(p.name, p.state))) : null);
  }
  return el('div', { class: 'peers-nav', id: 'peers-nav' }, usage, peers);
}
export function renderPeersBtn() {
  if (data && Date.now() - syncLoadedAt > 60000) loadSync();
  document.getElementById('peers-nav')?.replaceWith(peersNav());
  renderSyncBanner();
}
// 自动开启看板同步后提示一次（关掉后这台电脑上不再提示这一次的开启）
function renderSyncBanner() {
  const box = document.getElementById('sync-banner');
  const s = syncInfo;
  let seen = null;
  try { seen = prefs.get('ateam.syncAutoSeen'); } catch {}
  if (!s?.enabled || !s.autoAt || seen === String(s.autoAt)) { box.hidden = true; box.replaceChildren(); return; }
  const close = () => { try { prefs.set('ateam.syncAutoSeen', String(s.autoAt)); } catch {} box.hidden = true; box.replaceChildren(); };
  fill(box,
    el('b', null, '已自动开启看板同步'),
    el('span', null, `检测到本项目已改用多人看板同步，本机看板以「${s.name}」同步到 ateam/${s.name} 分支，需求栏底部的「同事」可查看同事的进度。`),
    el('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); close(); openHelper({ tab: 'settings' }); } }, '查看设置'),
    toastX(close));
  box.hidden = false;
}
function openPeers() {
  peersOpen = true;
  if (helper.open) { closeHelper(); }
  loadSync();
  renderPeersPage();
  renderPeersBtn();
  document.getElementById('peers-page').scrollTop = 0;
}
export function closePeers() {
  peersOpen = false;
  renderPeersPage();
  renderPeersBtn();
}
function renderPeersPage() {
  const page = document.getElementById('peers-page');
  if (!peersOpen) {
    if (!page.hidden) { page.hidden = true; page.replaceChildren(); if (!view.report && !usageOpen) document.body.style.overflow = ''; }
    return;
  }
  const scroll = page.hidden ? 0 : page.scrollTop;
  const s = syncInfo;
  const peers = s?.peers ?? [];
  const cols = (...w) => el('colgroup', null, w.map((x) => el('col', { style: x ? `width:${x}` : '' })));
  const body = !s ? [el('p', { class: 'hint' }, '读取中…')]
    : !s.enabled ? [el('div', { class: 'peers-empty' }, emptyState('users', '未开启看板同步', '在「帮助 → 设置 → 多人协作」中开启后，可在此查看同一项目中其他成员的进度。'))]
    : !peers.length ? [el('div', { class: 'peers-empty' }, emptyState('users', '暂无同事', '同一项目的其他成员开启看板同步后，约一分钟内显示在此处。其成员拉取本项目的代码并启动 ateam 后会自动开启同步。'))]
    : peers.map((p) => {
      const ws = p.presence?.workers ?? [];
      const meta = [`${ago(p.at)}同步`, p.presence ? `${ws.length} 个 worker${p.presence.leader ? '' : '，leader 未连接'}` : null, p.version ? `ateam ${p.version}` : null].filter(Boolean).join(' · ');
      const st = PEER_STATE[p.state] ?? PEER_STATE.idle;
      const owns = (s.owners ?? []).filter((o) => o.names.includes(p.name)).map((o) => o.path);
      const head = [el('div', { class: 'peer-head' },
        peerFace(p.name, p.state),
        el('div', { class: 'who' }, el('b', null, p.name), el('span', null, meta)),
        el('span', { class: `peer-state ${p.state || ''}`, title: st[1] }, st[0])),
        owns.length ? el('p', { class: 'peer-owns' }, '负责：', owns.map((o, i) => [i ? '、' : '', el('code', null, o)])) : null];
      if (p.newer) return el('section', { class: 'peer-card' }, head, el('p', { class: 'hint' }, '对方使用的 ateam 版本较新，请升级后查看。'));
      if (p.error) return el('section', { class: 'peer-card' }, head, el('p', { class: 'hint' }, `无法读取：${p.error}`));
      const jobs = p.jobs ?? [];
      const tasks = p.tasks ?? [];
      const rows = tasks.flatMap((t) => {
        const key = `${p.name}·${t.id}`;
        const open = peerOpenTask === key;
        const row = el('tr', { class: 'click', title: open ? '收起' : '展开查看描述和验收标准', onclick: (e) => { e.stopPropagation(); peerOpenTask = open ? null : key; renderPeersPage(); } },
          el('td', { title: `${t.id} ${t.title}` }, `${open ? '▾' : '▸'} ${t.id} ${t.title}`, t.overlap?.length ? el('span', { class: 'heavy-tag', title: `与本机 ${t.overlap.join('、')} 修改同一批文件` }, `与 ${t.overlap.join('、')} 重叠`) : null),
          el('td', null, el('span', { class: 'tag role', style: roleStyle(t.role) }, t.role)),
          el('td', null, t.unpushed ? el('span', { class: 'lozenge c-asking', title: '已通过，但提交尚未推送到远程，本机拿不到这些改动；与其路径重叠的本机任务待其推送后再派发' }, '未推送') : el('span', { class: `lozenge c-${laneOf(t)}` }, LANE_LABEL[laneOf(t)] ?? t.status)),
          el('td', { class: 'hint' }, t.assignee ?? '—'),
          el('td', { class: 'hint', title: t.paths.join('\n') }, t.paths.join('、')));
        if (!open) return [row];
        const md = el('div', { class: 'md' });
        md.innerHTML = renderMarkdown(t.description || '（无描述）');
        return [row, el('tr', { class: 'sub' }, el('td', { colspan: '5' }, md,
          t.acceptance?.length ? el('ol', null, t.acceptance.map((a) => el('li', null, a))) : null,
          t.since ? el('p', { class: 'hint' }, `当前状态开始于 ${fmtTime(t.since)}`) : null))];
      });
      return el('section', { class: 'peer-card' },
        head,
        jobs.length ? el('ul', { class: 'peer-jobs' }, jobs.map((j) => el('li', null,
          el('span', { class: 't', title: `${j.id} ${j.title}` }, el('span', { class: 'jid' }, j.id), j.title),
          j.total ? el('span', { class: 'bar' }, el('i', { style: `width:${Math.round((j.done / j.total) * 100)}%` })) : el('span', { class: 'hint' }, '拆分任务中'),
          el('span', { class: 'n' }, j.total ? `${j.done}/${j.total}` : '')))) : el('p', { class: 'hint' }, '没有进行中的需求。'),
        tasks.length ? el('table', { class: 'usage-table' }, cols('', '72px', '72px', '96px', '22%'),
          el('thead', null, el('tr', null, el('th', null, '进行中的任务（点击展开）'), el('th', null, '角色'), el('th', null, '状态'), el('th', null, '处理人'), el('th', null, '路径'))),
          el('tbody', null, rows)) : null);
    });
  fill(page,
    el('div', { class: 'report-top' },
      el('button', { class: 'btn ghost', onclick: closePeers }, icon('back'), '返回看板'),
      el('span', { class: 'crumb' }, data?.root ? `${data.root.split('/').pop()} / ` : '', el('b', null, '同事'))),
    el('div', { class: 'peers-wrap' },
      el('div', { class: 'peers-top' },
        el('div', { class: 'grow' },
          el('h1', null, '同事的进度'),
          el('p', null, s?.enabled
            ? [`本机同步为 ateam/${s.name}`, s.fetchedAt ? `${ago(s.fetchedAt)}拉取` : '尚未拉取', s.error ? `同步失败：${s.error}` : null, '只读，任务操作由对方在其看板中进行'].filter(Boolean).join(' · ')
            : '多人在同一项目中各自使用 ateam 时，可在此查看彼此进行中的需求和任务。')),
        s?.enabled ? el('button', { class: 'btn', type: 'button', title: '立即读取最新的同步状态', onclick: (e) => { e.stopPropagation(); loadSync(); } }, '刷新') : null),
      body));
  page.hidden = false;
  page.scrollTop = scroll;
  document.body.style.overflow = 'hidden';
}
