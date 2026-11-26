// 演播卡和提词窗口的接口

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkOps, opsSection, parseOps, parseSteps, stepCount, withoutOps } from '../demo.js';
import { AteamError } from '../errors.js';
import { commitPaths, commitTitle, headContent } from '../git.js';
import { WIN } from '../install.js';
import { httpServer, root, store } from './context.js';
import { requireId, serial } from './http.js';
import { settleOps } from './demo-ops.js';

// 提词悬浮窗进程（macOS 的 osascript）：同一时间只开一个，服务退出时关掉
let prompterProc = null;
export function killPrompter() { prompterProc?.kill(); }
const PROMPTER_JXA = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompter.jxa');

export const demoRoutes = {
  'POST /api/demo/add': (b) => {
    if (typeof b.script !== 'string' || !b.script.trim()) throw new AteamError('INVALID', '缺少脚本路径（--script），比如 docs/demo/protocol-adapter.md。');
    const script = relative(root, resolve(root, b.script.trim())).split(sep).join('/');
    if (!script || script.startsWith('..')) throw new AteamError('INVALID', `脚本路径 ${b.script} 不在项目目录（${root}）里。`);
    if (!existsSync(join(root, script))) throw new AteamError('INVALID', `脚本文件 ${script} 不存在，请先按演播脚本格式写好并提交，再建演播卡。`);
    return { task: store.addDemo({ jobId: b.jobId, title: b.title, script, role: b.role }) };
  },
  // steps：演播只演这几步。总步数从脚本读，读不到就交给 store 拒绝
  'POST /api/demo/start': async (b) => {
    if (WIN) throw new AteamError('INVALID', 'Windows 版暂不支持预演和演播，请在 Mac 上运行 ateam 演播这张卡。');
    const id = requireId(b);
    await settleOps();
    let total = null;
    let text = null;
    try { text = readFileSync(join(root, store.getTask(id).script), 'utf8'); } catch {}
    if (b.steps != null && text != null) total = stepCount(text);
    // 旧的按坐标录的操作记录不能直接演播，要先按新格式重新预演
    if ((b.mode ?? 'show') === 'show' && text != null && parseOps(text).legacy) {
      throw new AteamError('BAD_STATE', `${id} 的操作记录是旧格式（按坐标录的），请先重新预演一次。`);
    }
    return { task: store.startDemo(id, b.mode ?? 'show', b.steps ?? null, total, b.viewport ?? null) };
  },
  'GET /api/demo/ops': async (_b, url) => {
    await settleOps();
    const task = store.getTask(url.searchParams.get('id') ?? '');
    if (task.kind !== 'demo') throw new AteamError('INVALID', `任务 ${task.id} 不是演播卡。`);
    // ops：worker 写的操作记录；steps：脚本的步骤列表（编号、做什么、讲解），看板右栏的步骤大纲用
    try {
      const text = readFileSync(join(root, task.script), 'utf8');
      const parsed = parseOps(text);
      // recorded：动作块和预期都录好了的步骤号，看板标「已录」；legacy：旧的按坐标录的记录
      return { ops: opsSection(text), steps: parseSteps(text), viewport: parsed.viewport, legacy: parsed.legacy, recorded: [...parsed.steps].filter(([, v]) => !v.problem).map(([n]) => n) };
    } catch (err) {
      return { ops: '', steps: [], error: `读不到脚本文件 ${task.script}：${err.message}` };
    }
  },
  'POST /api/demo/stop': async (b) => { const task = store.stopDemo(requireId(b)); await settleOps(); return { task }; },
  'POST /api/demo/release': async (b) => { const task = store.releaseDemo(requireId(b)); await settleOps(); return { task }; },
  // 提词悬浮窗（只有 macOS）：服务替看板起一个系统窗口，没有浏览器边框、浮在最上层。
  // 同一时间只留一个；再点就关掉旧的重开（跳到最前）。其他系统返回错误，看板改用普通弹窗
  'POST /api/prompter/open': () => {
    if (process.platform !== 'darwin') throw new AteamError('INVALID', '提词悬浮窗只支持 macOS');
    prompterProc?.kill();
    const proc = spawn('osascript', ['-l', 'JavaScript', PROMPTER_JXA, `http://127.0.0.1:${httpServer.address().port}/?prompter&native`], { stdio: 'ignore' });
    proc.on('exit', () => { if (prompterProc === proc) prompterProc = null; });
    proc.on('error', () => { if (prompterProc === proc) prompterProc = null; });
    prompterProc = proc;
    return {};
  },
  'POST /api/prompter/close': () => { prompterProc?.kill(); prompterProc = null; return {}; },
  'POST /api/demo/pause': (b) => ({ task: store.pauseDemo(requireId(b)) }),
  'POST /api/demo/resume': (b) => ({ task: store.resumeDemo(requireId(b)) }),
  'POST /api/demo/end': (b) => {
    // 预演跑完：每一步都要录好动作块，才算预演完成
    const held = store.state.agents.find((a) => a.id === b.as)?.currentTask;
    const task = held && store.state.tasks.find((t) => t.id === held && t.kind === 'demo');
    const run = task?.runs?.[task.runs.length - 1];
    if (task && run?.mode === 'rehearsal' && !b.stuck && task.status === 'demoing' && !task.stopRequested) {
      let text = '';
      try { text = readFileSync(join(root, task.script), 'utf8'); } catch {}
      const problems = checkOps(text, { all: true });
      const vp = parseOps(text).viewport;
      if (run.viewport && vp && vp !== run.viewport) problems.unshift(`开头的视口写的是 ${vp}，这次预演选的是 ${run.viewport}：要在 ${run.viewport} 下走通，并把这一行改成「视口：${run.viewport}」`);
      if (problems.length) throw new AteamError('INVALID', `预演还不能算跑完，「## 操作记录」没录全：\n${problems.map((p) => `- ${p}`).join('\n')}\n\n把这些补上（开头「视口：宽x高」；每步「### N.」条目、\`\`\`actions 动作块和「预期：」行），再运行 ateam demo end。实在走不通的步骤用 --stuck 结束。`);
    }
    return { task: store.demoEnd(b.as, b.result, !!b.stuck) };
  },
  'POST /api/demo/save': (b) => serial(async () => {
    const task = store.demoTaskForSave(b.as);
    if (typeof b.summary !== 'string' || !b.summary.trim()) throw new AteamError('INVALID', '总结不能为空。写明这次记了或改了哪些操作；操作记录没有改动就加 --no-changes。');
    let current;
    try { current = readFileSync(join(root, task.script), 'utf8'); } catch {
      throw new AteamError('INVALID', `读不到脚本文件 ${task.script}。不要删除或移动它；恢复后再 demo save。`);
    }
    const head = await headContent(root, task.script);
    if (head === null) throw new AteamError('INVALID', `脚本文件 ${task.script} 还没有提交过，请通知用户让 leader 先提交脚本。`);
    const run = task.runs?.[task.runs.length - 1];
    // 预演没跑完：这次写的不提交，操作记录还原成上一版
    if (run?.mode === 'rehearsal' && run.outcome !== 'done') {
      writeFileSync(join(root, task.script), head);
      if (task.opsCleared) store.markOpsCleared(task.id, false);
      return { task: store.recordDemoSave(b.as, b.summary, null), commit: null, restored: true };
    }
    if (b.noChanges) {
      // 写了操作记录却加 --no-changes，记录会丢：拒绝
      if (current !== head) throw new AteamError('INVALID', `脚本 ${task.script} 有没提交的改动，不能加 --no-changes。去掉 --no-changes 重新运行，服务会提交它。`);
      if (task.opsCleared) store.markOpsCleared(task.id, false);
      return { task: store.recordDemoSave(b.as, b.summary, null), commit: null };
    }
    // 预演跑完的收尾：每步都要有合法动作块；其他情况只检查已写的动作块格式
    const problems = checkOps(current, { all: run?.mode === 'rehearsal' && run?.outcome === 'done' });
    if (problems.length) throw new AteamError('INVALID', `「## 操作记录」有问题，先改好再 demo save：\n${problems.map((p) => `- ${p}`).join('\n')}`);
    if (withoutOps(current) !== withoutOps(head)) {
      throw new AteamError('INVALID', `只能改脚本的「## 操作记录」段，其他段有改动。请把其他段恢复原样（git diff ${task.script} 查看）后再 demo save。`);
    }
    const result = await commitPaths(root, [task.script], commitTitle(task.id, `操作记录：${b.summary.trim()}`, '操作记录'));
    if (result.nothing) throw new AteamError('INVALID', `脚本 ${task.script} 没有改动。操作记录没有改动就加 --no-changes。`);
    if (task.opsCleared) store.markOpsCleared(task.id, false);
    return { task: store.recordDemoSave(b.as, b.summary, result.commits), commit: result.commits.join('、') };
  }),
};
