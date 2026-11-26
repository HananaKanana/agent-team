// 「项目规则」编辑器（分段规则和 src/rules.js 保持一致）

import { el, fill, renderMarkdown } from './util.js';
import { renderHelper } from './helper.js';

// 项目规则编辑器的状态。规则不在 /api/state 里，进入「项目规则」页时单独读取
let rules = { loaded: false, saved: '', draft: '', status: '', roles: [], previewRole: '' };
// 规则分段，和 src/rules.js 同一套规则（改动两边保持一致）：
// 第一个 `## ` 之前和 `## ALL` 段发给所有人，`## backend`、`## frontend, test` 只发给这些角色
function parseRules(text) {
  const out = [];
  let cur = { heading: null, roles: 'all', lines: [] };
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^## (.*)$/);
    if (!m) { cur.lines.push(line); continue; }
    out.push(cur);
    const heading = m[1].trim();
    cur = { heading, roles: heading.toLowerCase() === 'all' ? 'all' : heading.split(/[,，、\s]+/).map((r) => r.trim().toLowerCase()).filter(Boolean), lines: [] };
  }
  out.push(cur);
  return out.map((x) => ({ heading: x.heading, roles: x.roles, body: x.lines.join('\n') }));
}
// 同 src/rules.js 的 hasContent：只有空行和 # 标题行的段算空
function hasContent(body) {
  return String(body || '').split('\n').some((l) => l.trim() && !/^#{1,6}\s/.test(l.trim()));
}
function unreceivedRoles(text, known) {
  const set = new Set([...known.map((r) => r.toLowerCase()), 'leader', 'lead']); // ## leader 段给 leader，不算没人收
  const out = [];
  for (const x of parseRules(text)) {
    if (x.roles === 'all') continue;
    for (const r of x.roles) if (!set.has(r) && !out.includes(r)) out.push(r);
  }
  return out;
}
export async function loadRules() {
  try {
    const res = await fetch('/api/rules', { cache: 'no-store' });
    const json = await res.json();
    const saved = json.rules || '';
    // 上次没保存的草稿保留着（比如按 Esc 关了面板）
    const keepDraft = rules.loaded && rules.draft !== rules.saved;
    rules = { ...rules, loaded: true, saved, draft: keepDraft ? rules.draft : saved, status: keepDraft ? '有未保存的修改。' : '', roles: json.roles || [] };
  } catch {
    rules = { ...rules, loaded: true, status: '读取失败，请确认服务正在运行且为最新版本。' };
  }
  renderHelper(true);
}
async function saveRules() {
  try {
    const res = await fetch('/api/rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: rules.draft, userApproved: true }) });
    const json = await res.json();
    if (!json.ok) throw new Error(json.message);
    rules = { ...rules, loaded: true, saved: json.rules, draft: json.rules, status: '已保存。此后派发的任务将按角色附带相应规则。' };
  } catch (err) {
    rules = { ...rules, status: `保存失败：${err.message}` };
  }
  renderHelper(true);
}
// 规则每段的条数（- 开头的行），ALL 和开头无标题段合并，顺序同文件
function ruleCounts(text) {
  const counts = new Map();
  for (const x of parseRules(text)) {
    const name = x.roles === 'all' ? 'ALL' : x.roles.join(', ');
    counts.set(name, (counts.get(name) || 0) + x.body.split('\n').filter((l) => /^- /.test(l.trim())).length);
  }
  return [...counts].filter(([, n]) => n > 0);
}
export function rulesEditor() {
  if (!rules.loaded) return el('p', { class: 'hint' }, '读取中……');
  const mode = rules.mode === 'view' ? 'view' : 'edit';
  const dirty = rules.draft !== rules.saved;
  const setMode = (m) => (e) => { e.stopPropagation(); rules.mode = m; renderHelper(true); };
  const counts = el('div', { class: 'rules-counts' });
  const warn = el('p', { class: 'rules-warn' });
  function refreshMeta() {
    fill(counts, ruleCounts(rules.draft).map(([name, n]) => el('span', { class: 'rules-count' }, name, el('b', {}, String(n)))));
    const lost = unreceivedRoles(rules.draft, rules.roles);
    warn.textContent = lost.length ? `以下分段目前没有对应角色：${lost.join('、')}。全员分段的标题须为 ## ALL。` : '';
    warn.hidden = !lost.length;
  }
  refreshMeta();

  let body;
  if (mode === 'edit') {
    const area = el('textarea', {
      class: 'rules-editor', spellcheck: 'false',
      placeholder: '示例：\n- 不写新的测试代码\n\n## backend\n- 提交前先跑一遍编译\n\n## frontend, test\n- 页面文字不出现接口路径',
    });
    area.value = rules.draft;
    area.addEventListener('input', () => {
      rules.draft = area.value;
      const changed = rules.draft !== rules.saved;
      saveBtn.disabled = !changed;
      resetBtn.disabled = !changed;
      refreshMeta();
    });
    body = area;
  } else {
    // 按角色查看：这个角色领卡时收到哪些段（用当前内容，含没保存的修改）
    const roles = [...new Set([...rules.roles, ...parseRules(rules.draft).flatMap((x) => (x.roles === 'all' ? [] : x.roles))])].sort();
    if (!roles.includes(rules.previewRole)) rules.previewRole = roles[0] || '';
    const role = rules.previewRole;
    const list = parseRules(rules.draft);
    const split = list.some((x) => x.heading !== null);
    const secs = list.filter((x) => (!split || x.roles === 'all' || x.roles.includes(role)) && hasContent(x.body));
    const total = secs.reduce((n, x) => n + x.body.split('\n').filter((l) => /^- /.test(l.trim())).length, 0);
    const md = (text) => { const d = el('div', { class: 'md' }); d.innerHTML = renderMarkdown(text); return d; }; // renderMarkdown 先转义了 HTML
    body = [
      el('div', { class: 'role-pills' }, '角色',
        roles.map((r) => el('button', { class: `role-pill${r === role ? ' on' : ''}`, onclick: (e) => { e.stopPropagation(); rules.previewRole = r; renderHelper(true); } }, r)),
        roles.length ? el('span', { class: 'got' }, `领取任务时附带 ${total} 条`) : null),
      secs.length
        ? el('div', { class: 'rules-view' }, secs.map((x) => el('section', { class: 'rules-sec' },
          el('div', { class: 'rules-sec-head' },
            el('span', { class: `rules-tag${x.roles === 'all' ? ' all' : ''}` }, x.heading ?? 'ALL'),
            x.heading === null ? (split ? '首个小标题之前' : '未分段，适用于所有角色') : x.roles === 'all' ? '所有角色' : null),
          md(x.body.trim()))))
        : el('div', { class: 'rules-empty' }, role ? `${role} 没有适用的规则` : '暂无项目规则'),
    ];
  }

  const saveBtn = el('button', { class: 'btn primary sm', disabled: !dirty, onclick: (e) => { e.stopPropagation(); saveRules(); } }, '保存');
  const resetBtn = el('button', { class: 'btn ghost sm', disabled: !dirty, onclick: (e) => { e.stopPropagation(); rules = { ...rules, draft: rules.saved, status: '' }; renderHelper(true); } }, '撤销修改');
  const code = (t) => el('code', {}, t);
  return el('div', { class: 'rules-page' },
    el('p', { class: 'tab-hint' }, '所有任务均需遵守的约定，worker 领取任务时自动附带。使用 ', code('## backend'), '、', code('## frontend, test'),
      ' 分段，仅发送给对应角色；', code('## ALL'), ' 分段及首个小标题之前的内容发送给所有角色。每行一条，支持 Markdown。'),
    el('div', { class: 'rules-bar' },
      el('div', { class: 'seg' },
        el('button', { class: mode === 'edit' ? 'on' : '', onclick: setMode('edit') }, '编辑'),
        el('button', { class: mode === 'view' ? 'on' : '', onclick: setMode('view') }, '按角色查看')),
      counts),
    warn,
    body,
    // 按角色查看是只读的：不放保存 / 还原；有没保存的修改时提示回到编辑里保存
    el('div', { class: 'rules-foot' },
      mode === 'edit' ? [saveBtn, resetBtn, rules.status ? el('span', { class: 'hint' }, rules.status) : null]
        : el('span', { class: 'hint' }, dirty ? '只读预览（含未保存的修改），请返回「编辑」保存' : '只读预览，如需修改请切换至「编辑」'),
      el('span', { class: 'path' }, '存储位置：.ateam/rules.md · leader 通过命令行修改需经用户同意')));
}
