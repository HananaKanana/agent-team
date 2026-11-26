// 项目规则（.ateam/rules.md）、测试报告模板，以及派卡输出里附加的规则、设计文档、提交检查等

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearOps, opsSection, parseOps, stepCount } from '../demo.js';
import { isArchitectRole, isDevRole } from '../dev-guide.js';
import { AteamError } from '../errors.js';
import { DEFAULT_TEST_TEMPLATE } from '../format.js';
import { rulesFor, sectionCounts } from '../rules.js';
import { dataDir, root, rulesFile, store, testTemplateFile } from './context.js';
import { egoProfileList } from './agents.js';

// 新领到、接手、继续的任务附上项目规则；打回意见和答复只是补充消息，不重复附
const RULES_KINDS = new Set(['task', 'handoff', 'resume', 'own', 'demo', 'demo_stopped', 'demo_wrap']);

const MAX_RULES = 20 * 1024;
// 输出里带「## 浏览器」一节的派发：ego-browser 时都要分配（或沿用）测试用 profile，前后说明的空间名才一致
const EGO_KINDS = new Set([...RULES_KINDS, 'rejected', 'back', 'answer']);

export function readRules() {
  try { return readFileSync(rulesFile, 'utf8'); } catch { return ''; }
}
function writeRules(text) {
  if (typeof text !== 'string') throw new AteamError('INVALID', '规则内容必须是文本。');
  if (Buffer.byteLength(text) > MAX_RULES) throw new AteamError('INVALID', '项目规则超过 20KB。规则是每个任务都要读的，请精简到最重要的几条。');
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${rulesFile}.tmp`;
  writeFileSync(tmp, text.trim() ? `${text.trim()}\n` : '');
  renameSync(tmp, rulesFile);
  return readRules();
}
// leader 用命令行改规则要用户同意；看板保存（用户本人）带 userApproved
export function approvedRules(text, userApproved, preview) {
  if (typeof text !== 'string') throw new AteamError('INVALID', '规则内容必须是文本。');
  if (!userApproved) throw new AteamError('NEEDS_USER', `${preview}请给用户看，用户同意后加 --user-approved 重新运行。`);
  return writeRules(text);
}
export function countsChange(before, after) {
  const a = new Map(sectionCounts(before).map((c) => [c.section, c.count]));
  const b = new Map(sectionCounts(after).map((c) => [c.section, c.count]));
  const names = [...new Set([...a.keys(), ...b.keys()])];
  const diff = names.filter((n) => (a.get(n) ?? 0) !== (b.get(n) ?? 0)).map((n) => `${n} ${a.get(n) ?? 0} → ${b.get(n) ?? 0}`);
  return diff.length ? `改动前后各段条数：${diff.join('，')}。` : '各段条数没有变化，内容有改动。';
}
// 会领卡的角色。审卡 worker（critic）不收项目规则，不算在内：写了 ## critic 段会被提示没人收到
export const knownRoles = () => [...new Set([...store.state.tasks, ...store.state.agents].map((x) => x.role).filter(Boolean).map((r) => r.trim().toLowerCase()))].filter((r) => r !== 'critic').sort();
const MAX_TEST_TEMPLATE = 30 * 1024;
export function readTestTemplate() {
  try { return readFileSync(testTemplateFile, 'utf8'); } catch { return ''; }
}
export function writeTestTemplate(text) {
  if (typeof text !== 'string') throw new AteamError('INVALID', '模板内容必须是文本。');
  if (Buffer.byteLength(text) > MAX_TEST_TEMPLATE) throw new AteamError('INVALID', '测试报告模板超过 30KB，请精简。');
  if (!text.trim() || text.trim() === DEFAULT_TEST_TEMPLATE.trim()) {
    // 清空或和自带的一样：删掉文件，回到自带模板（以后自带模板更新也能跟上）
    try { unlinkSync(testTemplateFile); } catch {}
    return '';
  }
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${testTemplateFile}.tmp`;
  writeFileSync(tmp, `${text.trimEnd()}\n`);
  renameSync(tmp, testTemplateFile);
  return readTestTemplate();
}
// 测试卡：项目改过模板就附上全文（custom 为 true），没改过用 format.js 里自带的
function testTemplateFor(task, full) {
  if (task.kind === 'demo' || !/^(test|qa|测试)$/i.test(String(task.role ?? '').trim())) return null;
  const text = readTestTemplate();
  if (!text.trim()) return null;
  return full ? { custom: true, text } : { custom: true };
}

export function withRules(result, agentId) {
  if (!result) return result;
  // 测试卡、演播卡的输出里要写明这次用哪个浏览器（看板设置「测试用的浏览器」）
  const t = result.task;
  if (t && (t.kind === 'demo' || /^(test|qa|测试)$/i.test(String(t.role ?? '').trim()))) {
    result = { ...result, browser: store.config().testBrowser };
    // ego-browser：派卡、开始预演 / 演播时分一个测试用 profile 给这个 worker 独占（没有 ateam 开头的 profile 时不分，输出和以前一样）
    if (result.browser === 'ego' && agentId && EGO_KINDS.has(result.kind)) {
      const egoProfile = store.assignEgoProfile(t.id, agentId, egoProfileList());
      if (egoProfile) result.egoProfile = egoProfile;
    }
  }
  if (!RULES_KINDS.has(result.kind)) {
    const tpl = result.task && testTemplateFor(result.task, false);
    return tpl ? { ...result, testTemplate: tpl } : result;
  }
  const out = { ...result };
  const tpl = testTemplateFor(result.task, true);
  if (tpl) out.testTemplate = tpl;
  const rules = rulesFor(readRules(), result.task.role).trim();
  if (rules) out.rules = rules;
  // 开发卡：同一个需求有架构设计卡的，附上设计文档的位置和状态；配了提交检查的，附上要跑的命令
  if (result.task.kind !== 'demo' && isDevRole(result.task.role)) {
    const designs = store.state.tasks.filter((d) => d.jobId === result.task.jobId && d.id !== result.task.id && d.kind !== 'demo' && isArchitectRole(d.role) && d.status !== 'cancelled');
    if (designs.length) out.designs = designs.map((d) => ({ id: d.id, title: d.title, paths: d.paths, status: d.status }));
    const checks = store.config().submitChecks.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (checks.length) out.submitChecks = checks;
  }
  const job = store.state.jobs.find((j) => j.id === result.task.jobId);
  if (job?.description?.trim()) out.job = { id: job.id, title: job.title, description: job.description.trim() };
  // 演播卡：附上脚本全文，worker 不用自己去找文件
  if (result.task.kind === 'demo') {
    try {
      const text = readFileSync(join(root, result.task.script), 'utf8');
      out.script = { path: result.task.script, text, steps: stepCount(text), hasOps: !!opsSection(text).replace(/<!--[\s\S]*?-->/g, '').trim() };
    } catch (err) {
      out.script = { path: result.task.script, text: '', steps: 0, hasOps: false, error: `读不到脚本文件：${err.message}` };
    }
    const runs = result.task.runs ?? [];
    out.script.mode = runs[runs.length - 1]?.mode ?? 'show';
    out.script.only = runs[runs.length - 1]?.steps ?? null;
    // 目标视口：预演用开始时选的尺寸；演播沿用这张卡预演时记下的尺寸。legacy：旧的按坐标录的记录，要整段重写
    const ops = parseOps(out.script.text);
    // 预演一开始就清空操作记录，worker 从头写；上一版留在 git 里，预演没跑完时还原（见 settleOps）
    if (out.script.mode === 'rehearsal' && result.kind === 'demo' && !result.task.opsCleared && !out.script.error) {
      out.script.text = clearOps(out.script.text);
      writeFileSync(join(root, result.task.script), out.script.text);
      store.markOpsCleared(result.task.id, true);
      out.script.hasOps = false;
      out.script.cleared = true;
      out.script.oldViewport = ops.viewport;
    }
    const fallback = store.config().demoViewport;
    out.script.viewport = out.script.mode === 'rehearsal' ? (runs[runs.length - 1]?.viewport ?? fallback) : (ops.viewport ?? fallback);
    out.script.legacy = ops.legacy;
  }
  return out;
}
