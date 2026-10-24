// 演示脚本（docs/demo/*.md）的格式约定：四段固定标题「## 准备」「## 演示步骤」「## 清理」「## 经验」。
// 前三段由 leader 写，「经验」段由演示的 worker 维护。纯文本处理，不碰磁盘。

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

// 去掉「## 经验」段后的其余内容，用来判断 worker 有没有改经验以外的部分
export function withoutExperience(markdown) {
  return sections(markdown)
    .filter((s) => s.title !== '经验')
    .map((s) => s.lines.join('\n').replace(/\s+$/, ''))
    .join('\n');
}

// 「## 演示步骤」段里以「数字.」开头的行数
export function stepCount(markdown) {
  const steps = sections(markdown).find((s) => s.title === '演示步骤');
  return steps ? steps.lines.filter((l) => /^\s*\d+[.、]/.test(l)).length : 0;
}
