// 项目规则按角色分段：`## ALL` 段和第一个小标题之前的内容发给所有人，
// `## backend`、`## frontend, test` 这类段只发给标题里的角色。
// 看板 src/dashboard.html 里有一份同样规则的解析（预览用），两边改动要保持一致。

const HEADING = /^## (.*)$/;
const ROLE_SPLIT = /[,，、\s]+/;

function isAll(heading) {
  return heading.trim().toLowerCase() === 'all';
}

function headingRoles(heading) {
  return heading.split(ROLE_SPLIT).map((r) => r.trim().toLowerCase()).filter(Boolean);
}

// 按行切段，记下每段的起止行，加规则时按行插入，不动文件其他地方的排版
function sections(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let cur = { heading: null, roles: 'all', start: 0, lines: [] };
  lines.forEach((line, i) => {
    const m = line.match(HEADING);
    if (m) {
      out.push(cur);
      const heading = m[1].trim();
      cur = { heading, roles: isAll(heading) ? 'all' : headingRoles(heading), start: i + 1, lines: [] };
    } else {
      cur.lines.push(line);
    }
  });
  out.push(cur);
  return { lines, list: out };
}

export function parseRules(text) {
  return sections(text).list.map(({ heading, roles, lines }) => ({ heading, roles, body: lines.join('\n') }));
}

function hasHeadings(text) {
  return parseRules(text).some((s) => s.heading !== null);
}

function receives(section, role) {
  return section.roles === 'all' || section.roles.includes(String(role ?? '').trim().toLowerCase());
}

// 某个角色收到的规则。没有小标题的老文件整份发，和分段之前一字不差
export function rulesFor(text, role) {
  if (!hasHeadings(text)) return String(text ?? '').trim();
  return parseRules(text)
    .filter((s) => receives(s, role) && s.body.trim())
    .map((s) => (s.heading === null ? s.body.trim() : `## ${s.heading}\n${s.body.trim()}`))
    .join('\n\n');
}

function sameSet(a, b) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

// 在 lines 的 [start, end) 段里，紧跟最后一个非空行插入
function insertAfterContent(lines, start, end, line) {
  let at = end;
  while (at > start && !lines[at - 1].trim()) at--;
  lines.splice(at, 0, line);
}

// 加一条规则。roles 为空加到全员，否则加到角色完全相同的段，没有就在末尾新建
export function addRule(text, line, roles = null) {
  const rule = `- ${String(line).trim().replace(/^[-*]\s+/, '')}`;
  const want = (roles ?? []).map((r) => String(r).trim().toLowerCase()).filter(Boolean);
  const { lines, list } = sections(String(text ?? '').replace(/\s+$/, ''));
  if (!want.length && lines.length === 1 && !lines[0].trim()) return { text: rule, section: 'ALL' };
  const endOf = (i) => (i + 1 < list.length ? list[i + 1].start - 1 : lines.length);
  let idx;
  if (!want.length) {
    idx = list.map((s, i) => (s.heading !== null && s.roles === 'all' ? i : -1)).filter((i) => i >= 0).pop() ?? 0;
  } else {
    idx = list.findIndex((s) => s.roles !== 'all' && sameSet(s.roles, want));
  }
  if (idx >= 0) {
    insertAfterContent(lines, list[idx].start, endOf(idx), rule);
    const section = list[idx].heading ?? 'ALL';
    return { text: lines.join('\n').trim(), section };
  }
  const heading = roles.map((r) => String(r).trim()).filter(Boolean).join(', ');
  return { text: `${lines.join('\n').trim()}\n\n## ${heading}\n${rule}`.trim(), section: heading };
}

// 每段的条数（以 - 开头的行）。开头无标题段和 ALL 段都记作 ALL，同名段合并
export function sectionCounts(text) {
  const counts = new Map();
  for (const s of parseRules(text)) {
    const name = s.roles === 'all' ? 'ALL' : s.roles.join(', ');
    const n = s.body.split('\n').filter((l) => /^- /.test(l.trim())).length;
    counts.set(name, (counts.get(name) ?? 0) + n);
  }
  return [...counts].map(([section, count]) => ({ section, count }));
}

// 小标题里写了、但没有任何卡或 worker 是这个角色的名字（比如写成了 ## 全员）
export function unreceived(text, knownRoles = []) {
  const known = new Set(knownRoles.map((r) => String(r).trim().toLowerCase()));
  const out = [];
  for (const s of parseRules(text)) {
    if (s.roles === 'all') continue;
    for (const r of s.roles) if (!known.has(r) && !out.includes(r)) out.push(r);
  }
  return out;
}

export function needsTidy(text) {
  return !hasHeadings(text) && String(text ?? '').split('\n').filter((l) => /^- /.test(l.trim())).length > 8;
}
