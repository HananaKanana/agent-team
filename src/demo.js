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
// 一场演播选中的步骤写成人话：连续的写「第 12–21 步」，否则「第 3、5、7 步」；没有选（完整演播）返回空串
export function stepsLabel(steps) {
  if (!steps?.length) return '';
  const contiguous = steps.every((n, i) => i === 0 || n === steps[i - 1] + 1);
  return contiguous && steps.length > 1 ? `第 ${steps[0]}–${steps[steps.length - 1]} 步` : `第 ${steps.join('、')} 步`;
}

export function stepCount(markdown) {
  return parseSteps(markdown).length;
}

// ---------- 操作记录 ----------
// 与浏览器工具无关：每步「### N.」条目里写一个 ```actions 动作块（用 worker 当前浏览器工具的格式，ateam 不解析）、
// 一行「工具：」和一行「预期：」（这一步做完页面上应该看到什么）。开头一行「视口：宽x高」。
// 旧记录是按坐标录的 ```cua 块（WorkBuddy 的 cua_execute），算格式过期，要重新预演。

export const VIEWPORT_RE = /^(\d{3,4})x(\d{3,4})$/;

// 操作记录的结构：{ viewport: '1600x800' | null, legacy, steps: Map<n, { hasBlock, hasExpect, tool, problem }> }
export function parseOps(markdown) {
  const ops = opsSection(markdown);
  const vp = ops.match(/视口[:：]\s*(\d{3,5})\s*[x×*]\s*(\d{3,5})/);
  const steps = new Map();
  for (const part of ops.split(/^(?=###\s)/m)) {
    const m = part.match(/^###\s*(\d+)[.、\s]/);
    if (!m) continue;
    const block = part.match(/```actions[^\n]*\n([\s\S]*?)```/);
    const hasBlock = !!block && block[1].trim() !== '';
    const hasExpect = /^\s*[-*]?\s*预期[:：]\s*\S/m.test(part);
    const tool = part.match(/^\s*[-*]?\s*工具[:：]\s*(.+?)\s*$/m)?.[1] ?? null;
    const problem = [hasBlock ? '' : '没有动作块（```actions）', hasExpect ? '' : '没有预期行（预期：…）'].filter(Boolean).join('，') || null;
    steps.set(Number(m[1]), { hasBlock, hasExpect, tool, problem });
  }
  const legacy = /```cua\b/.test(ops) && !/```actions\b/.test(ops);
  return { viewport: vp ? `${vp[1]}x${vp[2]}` : null, legacy, steps };
}

// 检查操作记录。all：每个演示步骤都必须录全（预演跑完时）；否则只检查已写的条目。
// 返回问题列表，空数组表示通过
export function checkOps(markdown, { all = false } = {}) {
  const { viewport, steps } = parseOps(markdown);
  const problems = [];
  if (all && !viewport) problems.push('操作记录开头缺「视口：宽x高」');
  const want = all ? parseSteps(markdown).map((s) => s.n) : [...steps.keys()];
  for (const n of want) {
    const st = steps.get(n);
    if (!st) problems.push(`第 ${n} 步：操作记录里没有「### ${n}.」`);
    else if (st.problem) problems.push(`第 ${n} 步：${st.problem}`);
  }
  return problems;
}
