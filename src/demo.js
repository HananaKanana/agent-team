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

// ---------- 操作记录里的动作块 ----------
// 每步一个 ```cua 代码块：一段或多段 JSON 数组，段之间单独一行 ---，每段是一次 cua_execute 的 actions。
// 字段规则照 WorkBuddy Browser 工具的 cua_execute（不能有多余字段）。

const NUM = (v) => typeof v === 'number' && Number.isFinite(v);
const ACTIONS = {
  click: { need: ['x', 'y'], opt: ['button', 'keypress'] },
  double_click: { need: ['x', 'y'], opt: ['button', 'keypress'] },
  move: { need: ['x', 'y'], opt: ['keys'] },
  drag: { need: ['path'], opt: ['keys'] },
  scroll: { need: ['x', 'y', 'scroll_x', 'scroll_y'], opt: ['keypress'] },
  keypress: { need: ['keys'], opt: [] },
  type: { need: ['text'], opt: [] },
  screenshot: { need: [], opt: ['format', 'quality', 'full_page', 'clip'] },
};
const MAX_BATCH = 100;

function actionProblem(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return '动作必须是对象';
  const spec = ACTIONS[a.type];
  if (!spec) return `不支持的动作类型 ${JSON.stringify(a.type)}（只能是 ${Object.keys(ACTIONS).join('、')}）`;
  const extra = Object.keys(a).filter((k) => k !== 'type' && !spec.need.includes(k) && !spec.opt.includes(k));
  if (extra.length) return `${a.type} 不能有字段 ${extra.join('、')}（没有 wait，等待靠分段）`;
  const miss = spec.need.filter((k) => a[k] === undefined);
  if (miss.length) return `${a.type} 缺少 ${miss.join('、')}`;
  for (const k of ['x', 'y', 'scroll_x', 'scroll_y']) if (spec.need.includes(k) && !NUM(a[k])) return `${a.type} 的 ${k} 必须是数字`;
  if (a.type === 'drag' && !(Array.isArray(a.path) && a.path.length >= 2 && a.path.length <= 256 && a.path.every((p) => NUM(p?.x) && NUM(p?.y)))) return 'drag 的 path 必须是 2–256 个 {x,y}';
  if (a.type === 'type' && typeof a.text !== 'string') return 'type 的 text 必须是字符串';
  if (a.type === 'keypress' && !(typeof a.keys === 'string' || (Array.isArray(a.keys) && a.keys.length >= 1 && a.keys.length <= 8))) return 'keypress 的 keys 必须是字符串或 1–8 个键的数组';
  return null;
}

// 解析一个 cua 代码块，返回 { segments, problem }
function parseCuaBlock(text) {
  const segments = [];
  const parts = text.split(/^\s*---\s*$/m).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { segments, problem: '动作块是空的' };
  for (let i = 0; i < parts.length; i++) {
    let arr;
    try { arr = JSON.parse(parts[i]); } catch { return { segments, problem: `第 ${i + 1} 段不是合法 JSON` }; }
    if (!Array.isArray(arr) || !arr.length) return { segments, problem: `第 ${i + 1} 段必须是非空 JSON 数组` };
    if (arr.length > MAX_BATCH) return { segments, problem: `第 ${i + 1} 段有 ${arr.length} 个动作，一段最多 ${MAX_BATCH} 个` };
    for (const a of arr) {
      const p = actionProblem(a);
      if (p) return { segments, problem: `第 ${i + 1} 段：${p}` };
    }
    segments.push(arr);
  }
  return { segments, problem: null };
}

// 操作记录的结构：{ viewport: '1694x808' | null, steps: Map<n, { segments, problem, hasBlock }> }
export function parseOps(markdown) {
  const ops = opsSection(markdown);
  const vp = ops.match(/视口[:：]\s*(\d{3,5})\s*[x×*]\s*(\d{3,5})/);
  const steps = new Map();
  for (const part of ops.split(/^(?=###\s)/m)) {
    const m = part.match(/^###\s*(\d+)[.、\s]/);
    if (!m) continue;
    const block = part.match(/```cua\s*\n([\s\S]*?)```/);
    steps.set(Number(m[1]), block ? { hasBlock: true, ...parseCuaBlock(block[1]) } : { hasBlock: false, segments: [], problem: '没有动作块（```cua）' });
  }
  return { viewport: vp ? `${vp[1]}x${vp[2]}` : null, steps };
}

// 检查操作记录。all：每个演示步骤都必须有合法动作块（预演跑完时）；否则只检查已写的动作块格式。
// 返回问题列表，空数组表示通过
export function checkOps(markdown, { all = false } = {}) {
  const { viewport, steps } = parseOps(markdown);
  const problems = [];
  if (all && !viewport) problems.push('操作记录开头缺「视口：宽x高」（从截图结果读，比如 视口：1694x808）');
  const want = all ? parseSteps(markdown).map((s) => s.n) : [...steps.keys()];
  for (const n of want) {
    const st = steps.get(n);
    if (!st) problems.push(`第 ${n} 步：操作记录里没有「### ${n}.」`);
    else if (st.problem && (all || st.hasBlock)) problems.push(`第 ${n} 步：${st.problem}`);
  }
  return problems;
}
