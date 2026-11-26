// 设计文档和项目架构总览：路径约定，以及从设计文档里挑出和某张开发卡有关的部分（派卡时直接贴给 worker）。
// 纯函数，不读文件；读文件在 src/server/rules.js。

// 项目级的架构总览：模块划分、目录约定、技术栈、公共组件、同类功能照哪个写。开发卡和架构卡领卡时附上
export const ARCH_DOC = 'docs/architecture.md';
// 附在派卡输出里的上限（字符）。超出的只给开头，提示去看原文
export const ARCH_MAX = 6000;
const SECTION_MAX = { files: 3000, split: 1500, api: 4000, data: 3000 };

const norm = (p) => String(p).trim().replace(/^`|`$/g, '').replace(/^\.\//, '').replace(/\/+$/, '');

// 架构卡的设计文档：任务路径里的 .md（架构总览除外），否则 <第一个路径>/<卡号>-设计.md
export function designDocPath(task) {
  const paths = (task.paths ?? []).map(norm);
  const file = paths.find((p) => p.toLowerCase().endsWith('.md') && p !== ARCH_DOC);
  if (file) return file;
  const dir = paths.find((p) => p !== ARCH_DOC);
  return dir ? `${dir}/${task.id}-设计.md` : `${task.id}-设计.md`;
}

// 按模板的小标题「## 5. 文件清单」切节：{ 5: { title, body } }
export function designSections(text) {
  const out = {};
  let cur = null;
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/^##\s+(\d+)[.、．]\s*(.+?)\s*$/);
    if (m) { cur = { title: m[2], lines: [] }; out[Number(m[1])] = cur; continue; }
    if (/^#{1,2}\s/.test(line)) { cur = null; continue; }
    cur?.lines.push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([n, s]) => [n, { title: s.title, body: s.lines.join('\n').trim() }]));
}

// 一行里提到的路径有没有落在这张卡的任务路径里（卡的路径是目录时，目录下的文件都算）
function mentionsPaths(line, taskPaths) {
  const words = line.match(/[\w.@\-/]+\.[\w]+|[\w.@\-]+\/[\w.@\-/]*/g) ?? [];
  return words.map(norm).some((w) => w && taskPaths.some((p) => p === '' || p === '.' || w === p || w.startsWith(`${p}/`)));
}

const clip = (text, max, n) => (text.length <= max ? text : `${text.slice(0, max).replace(/\n[^\n]*$/, '')}\n…（后面还有，见文档第 ${n} 节）`);

// 和这张卡有关的部分：第 5 节里路径落在任务路径的行（带表头）、第 10 节里提到这些路径的条目、第 6 节接口、第 7 节数据结构。
// 没有对应小标题的（不是按模板写的）返回 null
export function designExcerpt(text, taskPaths) {
  const s = designSections(text);
  if (!s[5] && !s[6] && !s[10]) return null;
  const paths = (taskPaths ?? []).map(norm);
  const rows = (s[5]?.body ?? '').split('\n');
  const head = rows.filter((l) => /^\s*\|/.test(l)).slice(0, 2);
  const files = rows.filter((l) => /^\s*\|/.test(l) && !head.includes(l) && mentionsPaths(l, paths));
  const split = (s[10]?.body ?? '').split('\n').filter((l) => l.trim() && mentionsPaths(l, paths));
  return {
    files: files.length ? clip([...head, ...files].join('\n'), SECTION_MAX.files, 5) : '',
    split: clip(split.join('\n'), SECTION_MAX.split, 10),
    api: clip(s[6]?.body ?? '', SECTION_MAX.api, 6),
    data: clip(s[7]?.body ?? '', SECTION_MAX.data, 7),
  };
}
