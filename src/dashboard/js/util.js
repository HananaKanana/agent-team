// 通用工具：建节点、图标、头像、时间格式、Markdown、接口调用、路径比较、角色名和颜色

import { data, LANE_LABEL } from './state.js';

// 用一组子节点替换 node 的内容；嵌套数组会展开，null/false 跳过，字符串转成文本
export function fill(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
export const icon = (id, cls = '') => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `ico ${cls}`);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${id}`);
  svg.append(use);
  return svg;
};
// 头像上的字：frontend-13 这类编号显示尾号，其他显示首字
export function avText(name) {
  const m = String(name).match(/-(\d+)$/);
  return m ? m[1] : String(name).trim().charAt(0).toUpperCase();
}
export function avatar(id, role) {
  if (!id) return el('span', { class: 'av none', title: '未领取' });
  const a = data.state.agents.find((x) => x.id === id);
  return el('span', { class: 'av', style: roleStyle(role ?? a?.role ?? ''), title: agentLabel(id) }, avText(a?.name || id));
}
// 空状态：图标 + 标题 + 下一步做什么（可带一个按钮）
export function emptyState(iconId, title, text, action) {
  return el('div', { class: 'empty-state' },
    el('div', { class: 'ico-wrap' }, icon(iconId)),
    el('h3', null, title),
    text ? el('p', null, text) : null,
    action || null);
}
// 弹框的标题栏：标题 + 右侧按钮（默认一个关闭图标）
export function modalHead(title, onClose, extra) {
  return el('div', { class: 'modal-head' },
    el('h3', null, title),
    extra || null,
    onClose ? el('button', { class: 'btn ghost icon', title: '关闭', 'aria-label': '关闭', onclick: (e) => { e.stopPropagation(); onClose(); } }, icon('close')) : null);
}
const pad = (n) => String(n).padStart(2, '0');
export function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  return `${Math.floor(s / 3600)} 小时前`;
}
// 时长：45 秒 / 23 分钟 / 2 小时 5 分 / 1 天 3 小时
export function dur(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return `${Math.round(Math.max(0, ms) / 1000)} 秒`;
  if (m < 60) return `${m} 分钟`;
  if (m < 1440) return `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ''}`;
  return `${Math.floor(m / 1440)} 天${Math.floor(m % 1440 / 60) ? ` ${Math.floor(m % 1440 / 60)} 小时` : ''}`;
}
// 已通过任务的总用时：第一次被领取 → 最后一次通过（含 review、打回返工）
export function spent(t) {
  const start = t.history.find((h) => h.type === 'claimed');
  const end = t.history.findLast((h) => h.type === 'approved');
  return start && end ? new Date(end.ts) - new Date(start.ts) : null;
}
// 卡片上的时间：在当前这一列待了多久。等 leader 的（等待答复、待 review）超过 10 分钟、
// 做了超过 30 分钟就标橙色。已通过显示总用时；待领取但依赖还没通过的显示「等依赖」
// 只显示时钟 + 时长，含义写在鼠标悬停提示里
const SINCE = {
  pending: [['created', 'released', 'handoff', 'rejected', 'cancelled']],
  working: [['claimed'], 30], rework: [['rejected'], 30],
  asking: [['asked'], 10], submitted: [['submitted'], 10],
  held: [['rejected', 'handoff', 'released', 'created']],
};
const LANE_TIME_TIP = { pending: '排队时长', working: '处理时长', rework: '返工时长', asking: '等待答复时长', submitted: '等待 review 时长', held: '挂起时长' };
export function laneTime(t, lane) {
  if (lane === 'approved') {
    const ms = spent(t);
    return ms == null ? null : el('span', { class: 'since', title: '总耗时' }, icon('clock'), dur(ms));
  }
  // 依赖的卡已作废：永远等不到，标红让人去改依赖（正常流程不会出现，老数据才有）
  const deadDeps = t.status === 'pending' || t.status === 'held' ? t.dependsOn.filter((id) => data.state.tasks.find((x) => x.id === id)?.status === 'cancelled') : [];
  if (deadDeps.length) {
    return el('span', { class: 'since dead-dep', title: `依赖的 ${deadDeps.join('、')} 已作废，该任务的依赖无法满足，不会被派发。请由 leader 执行 ateam task edit ${t.id} --after ... 移除该依赖` }, icon('clock'), `依赖 ${deadDeps.join('、')} 已作废`);
  }
  if (lane === 'pending' && t.dependsOn.some((id) => data.state.tasks.find((x) => x.id === id)?.status !== 'approved')) {
    return el('span', { class: 'since', title: `等待依赖任务通过：${t.dependsOn.join('、')}` }, icon('clock'), '等依赖');
  }
  const clash = lane === 'pending' && data.clash?.[t.id];
  if (clash) {
    const c = data.state.tasks.find((x) => x.id === clash);
    // 同事看板里的卡（多人协作）：编号形如 wu·T88
    if (!c && clash.includes('·') && data.clashPush?.[t.id]) return el('span', { class: 'since', title: `与同事 ${clash.split('·')[0]} 已通过的 ${clash.split('·')[1]} 修改同一批文件，但其提交尚未推送到远程，本机拿不到这些改动。待其推送后再派发（对方超过 2 小时未同步时不再等待）` }, icon('clock'), `待 ${clash} 推送`);
    if (!c && clash.includes('·')) return el('span', { class: 'since', title: `与同事 ${clash.split('·')[0]} 正在处理的 ${clash.split('·')[1]} 修改同一批文件。为避免双方同时修改同一文件，待其提交后再派发（对方超过 2 小时未同步时不再等待）` }, icon('clock'), `待 ${clash} 提交`);
    return el('span', { class: 'since', title: `与 ${c?.assignee ? agentLabel(c.assignee) : ''} 正在处理的 ${clash} 修改同一批文件。为避免提交对方未完成的改动，待其提交后再派发` }, icon('clock'), `待 ${clash} 提交`);
  }
  const rule = SINCE[lane];
  const h = rule && t.history.findLast((x) => rule[0].includes(x.type));
  if (!h) return null;
  const since = new Date(h.ts).getTime();
  const node = el('span', { class: 'since', title: LANE_TIME_TIP[lane], 'data-since': since, 'data-late': rule[1] ? rule[1] * 60000 : null }, icon('clock'), el('span'));
  tickSince(node);
  return node;
}
export function tickSince(n) {
  const ms = Date.now() - Number(n.dataset.since);
  n.lastChild.textContent = dur(ms);
  n.classList.toggle('late', !!n.dataset.late && ms > Number(n.dataset.late));
}
export function laneOf(t) {
  if (t.status === 'working' && t.rejectCount > 0) return 'rework';
  return t.status;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 极简 markdown：先转义 HTML，再处理标题、列表、代码块、行内代码、粗体
// 极简 markdown：先转义 HTML，再处理标题、（可嵌套的）列表、代码块、表格、引用、行内代码、粗体、链接
export function renderMarkdown(src) {
  const lines = escapeHtml(String(src ?? '').replace(/\t/g, '  ')).split('\n');
  const out = [];
  const stack = []; // 打开的列表：{ tag, indent }
  let para = [];
  const inline = (t) => t
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c.replace(/\*/g, '&#42;')}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const closeLists = (indent = -1) => {
    while (stack.length && stack[stack.length - 1].indent > indent) out.push(`</li></${stack.pop().tag}>`);
  };
  const closeAll = () => { flushPara(); closeLists(); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = line.match(/^(\s*)```/))) {
      closeAll();
      const code = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i].slice(m[1].length));
      out.push(`<pre><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flushPara(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { closeAll(); const n = Math.min(m[1].length, 3); out.push(`<h${n}>${inline(m[2])}</h${n}>`); continue; }
    if ((m = line.match(/^\s*&gt;\s?(.*)$/))) { closeAll(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      closeAll();
      const rows = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(lines[i]);
      i--;
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      const head = rows.length > 1 && /^\s*\|[\s:|-]+\|\s*$/.test(rows[1]) ? body.shift() : null;
      out.push(`<table>${head ? `<thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` : ''}<tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if ((m = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/))) {
      flushPara();
      const indent = m[1].length;
      const tag = /\d/.test(m[2]) ? 'ol' : 'ul';
      closeLists(indent);
      const top = stack[stack.length - 1];
      if (top && top.indent === indent && top.tag === tag) out.push('</li><li>');
      else {
        if (top && top.indent === indent) out.push(`</li></${stack.pop().tag}>`);
        out.push(`<${tag}><li>`);
        stack.push({ tag, indent });
      }
      out.push(inline(m[3]));
      continue;
    }
    // 列表项下面缩进的续行，归到当前列表项
    if (stack.length && /^\s+/.test(line)) { out.push(`<br>${inline(line.trim())}`); continue; }
    closeLists();
    para.push(line.trim());
  }
  closeAll();
  return out.join('\n');
}
export function strip(tasks, big) {
  return el('div', { class: big ? 'strip big' : 'strip', 'aria-hidden': 'true' },
    tasks.map((t) => el('span', { class: `s-${laneOf(t)}`, title: `${t.id} ${LANE_LABEL[laneOf(t)]}` })));
}
export function reviewStats(tasks) {
  let reviews = 0;
  let rejects = 0;
  for (const t of tasks) {
    for (const h of t.history) {
      if (h.type === 'approved') reviews++;
      if (h.type === 'rejected') { reviews++; rejects++; }
    }
  }
  const approved = tasks.filter((t) => t.status === 'approved');
  const firstPass = approved.filter((t) => t.rejectCount === 0).length;
  const rate = approved.length ? `${Math.round((firstPass / approved.length) * 100)}%` : '—';
  return { reviews, rejects, rate, approved: approved.length };
}
// 审卡 worker 的进度：它这一批卡里还没审的，第一张就是正在审的
export function criticProgress(a) {
  const reviewed = (t) => (t.critiquedRev ?? -1) === (t.rev ?? 0);
  const left = (a.critiqueBatch || [])
    .map((id) => data.state.tasks.find((t) => t.id === id))
    .filter((t) => t && t.status !== 'cancelled' && !reviewed(t));
  const leaving = a.dismiss || data.config?.criticAutoLeave ? '，审完下线' : '';
  if (left.length) return `审核 ${left[0].id}${left.length > 1 ? `，本批剩余 ${left.length} 张` : ''}${leaving}`;
  const last = a.lastCritiqued?.length ? `，最近审核 ${a.lastCritiqued.join('、')}` : '';
  return `等待新任务${last}`;
}
export const post = async (url, body) => {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return await res.json();
  } catch { return { ok: false, message: '无法连接 ateam 服务。' }; }
};
const normPath = (p) => { const x = String(p).trim().replace(/^\.\//, '').replace(/\/+$/, ''); return x === '.' ? '' : x; };
export function pathsOverlap(a, b) {
  for (const x of a.map(normPath)) for (const y of b.map(normPath)) {
    if (x === '' || y === '' || x === y || y.startsWith(`${x}/`) || x.startsWith(`${y}/`)) return true;
  }
  return false;
}
export function idHasRole(a) {
  const slug = a.role.trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '');
  return a.id.startsWith(`${slug}-`);
}
// worker 显示名：起了名字的显示名字，否则显示编号
export function agentName(id) {
  return data.state.agents.find((a) => a.id === id)?.name || id;
}
export function agentLabel(id) {
  if (id === 'user') return '用户';
  const name = data.state.agents.find((a) => a.id === id)?.name;
  return name ? `${name}（${id}）` : id;
}
// 角色 → 颜色。常用名固定，其他按名字哈希，同一角色永远同一颜色
const ROLE_FIXED = { frontend: 0, fe: 0, 前端: 0, backend: 1, be: 1, 后端: 1, test: 2, qa: 2, 测试: 2, product: 3, pm: 3, 产品: 3, architect: 4, arch: 4, 架构: 4, critic: 5, 审卡: 5, docs: 4, 文档: 4 };
export function roleStyle(role) {
  const key = String(role).trim().toLowerCase();
  let i = ROLE_FIXED[key];
  if (i === undefined) {
    let h = 0;
    for (const ch of key) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    i = h % 6;
  }
  return `--rc: var(--role-${i})`;
}
