// 演播脚本（docs/demo/*.md）的格式约定：四段固定标题「## 准备」「## 演示步骤」「## 清理」「## 操作记录」。
// 前三段由 leader 写，「操作记录」段由 worker 维护（预演时写，演播时修正）。老脚本的「## 经验」段同样算 worker 段。
// 纯文本处理，不碰磁盘。

const SECTION = /^##\s+(.+?)\s*$/;

// 按二级标题切段：[{ title, lines }]，第一个标题之前的内容 title 为空
function sections(markdown) {
  const out = [{ title: '', lines: [] }];
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const m = line.match(SECTION);
    if (m) out.push({ title: m[1], lines: [line] });
    else out[out.length - 1].lines.push(line);
  }
  return out;
}

const OPS_TITLES = new Set(['操作记录', '经验']);

// 去掉 worker 段后的其余内容，用来判断 worker 有没有改它不该改的部分
export function withoutOps(markdown) {
  return sections(markdown)
    .filter((s) => !OPS_TITLES.has(s.title))
    .map((s) => s.lines.join('\n').replace(/\s+$/, ''))
    .join('\n');
}

// worker 段的正文（不含标题），没有则空串
export function opsSection(markdown) {
  return sections(markdown).filter((s) => OPS_TITLES.has(s.title))
    .map((s) => s.lines.slice(1).join('\n')).join('\n').trim();
}

const STEP_LINE = /^\s*(\d+)[.、]\s*(.*)$/;
const NARRATION_LINE = /^\s*[-*]?\s*讲解[:：]\s*(.*)$/;
const INLINE_NARRATION = /[（(]讲[:：]\s*([^）)]*)[）)]/;

// 「## 演示步骤」段解析成 [{ n, text, narration }]。
// 讲解写在步骤下面一行「讲解：……」，也兼容步骤里的「（讲：……）」
export function parseSteps(markdown) {
  const sec = sections(markdown).find((s) => s.title === '演示步骤');
  if (!sec) return [];
  const steps = [];
  for (const line of sec.lines.slice(1)) {
    const m = line.match(STEP_LINE);
    if (m) {
      const inline = m[2].match(INLINE_NARRATION);
      steps.push({ n: Number(m[1]), text: m[2].replace(INLINE_NARRATION, '').trim(), narration: inline ? inline[1].trim() : '' });
      continue;
    }
    const cur = steps[steps.length - 1];
    const nm = cur && line.match(NARRATION_LINE);
    if (nm) cur.narration = [cur.narration, nm[1].trim()].filter(Boolean).join(' ');
  }
  return steps;
}

// 「## 演示步骤」段里的步骤数
export function stepCount(markdown) {
  return parseSteps(markdown).length;
}
