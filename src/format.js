// 把任务、事件、状态渲染成给大模型读的 markdown 文本。
// worker skill 依赖 formatWait 的标题文本，修改时要同步 skills/ateam-worker/SKILL.md。
import { stepsLabel } from './demo.js';

const STATUS = {
  pending: '待领取',
  working: '进行中',
  asking: '等待答复',
  submitted: '待 review',
  approved: '已通过',
  held: '已挂起',
  cancelled: '已作废',
  // 演播卡
  ready: '待演播',
  queued: '等待开始',
  demoing: '进行中',
  wrapping: '收尾中',
};

const RUN_OUTCOME = { done: '跑完', stopped: '叫停', interrupted: '中断' };
const RUN_MODE = { rehearsal: '预演', show: '演播' };
// 演播卡的预演状态
const rehearsalFlag = (t) => (!t.rehearsedAt ? '未预演' : t.mayChange ? '已预演，页面可能有变动' : '已预演');
function runText(r) {
  const slow = r.slowSteps?.length ? `；慢档：第 ${r.slowSteps.join('、')} 步` : '';
  const only = r.steps?.length ? `（${stepsLabel(r.steps)}）` : '';
  return `${formatTime(r.startedAt)} ${RUN_MODE[r.mode] ?? '演播'}${only} ${RUN_OUTCOME[r.outcome] ?? '进行中'}${slow}`;
}

// 演播卡一行摘要：脚本、预演状态、次数、上一次的结果
function demoLine(t) {
  const runs = t.runs ?? [];
  const last = runs[runs.length - 1];
  const lastText = last ? `，上次 ${runText(last)}` : '';
  return `- ${t.id} [${STATUS[t.status] ?? t.status}，${rehearsalFlag(t)}] ${t.title}（${t.role}，脚本 ${t.script}，已运行 ${runs.length} 次${lastText}）`;
}

const JOB_STATUS = {
  planning: '规划中',
  active: '进行中',
  awaiting_acceptance: '待用户验收',
  accepted: '已验收',
  cancelled: '已作废',
};

const pad = (n) => String(n).padStart(2, '0');

export function formatTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ago(ts, now = Date.now()) {
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 60) return `${sec} 秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  return `${Math.floor(sec / 3600)} 小时前`;
}

function statusLabel(status) {
  return STATUS[status] ? `${status}（${STATUS[status]}）` : status;
}

function oneLine(text) {
  return String(text ?? '').replace(/\s*\n\s*/g, ' / ');
}

export function formatTask(task) {
  if (task.kind === 'demo') return formatDemoTask(task);
  const lines = [];
  lines.push(`- 状态：${statusLabel(task.status)}`);
  lines.push(`- 角色：${task.role}`);
  lines.push(`- 处理人：${task.assignee ?? '无'}`);
  lines.push(`- 允许改动的路径：${task.paths.map((p) => `\`${p}\``).join('、')}（只改这些路径；路径外的改动不会被提交）`);
  lines.push(`- 依赖：${task.dependsOn.length ? task.dependsOn.join('、') : '无'}`);
  lines.push(`- 打回次数：${task.rejectCount}`);
  lines.push('');
  lines.push('## 验收标准');
  lines.push('');
  if (task.acceptance.length) task.acceptance.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
  else lines.push('（未填写）');
  lines.push('');
  lines.push('## 描述');
  lines.push('');
  lines.push(task.description?.trim() || '（无）');
  lines.push('');
  lines.push('## 提交');
  lines.push('');
  if (task.commits.length) task.commits.forEach((c) => lines.push(`- ${c}`));
  else lines.push('（暂无）');
  lines.push('');
  if (task.critiques?.length) {
    lines.push('## 审卡意见');
    lines.push('');
    for (const c of task.critiques) {
      const basis = c.basis ? `（依据：${oneLine(c.basis)}）` : '';
      const reply = c.reply ? `；leader${c.replyKind === 'agree' ? '同意' : c.replyKind === 'dispute' ? '不同意' : ''}：${oneLine(c.reply)}` : '';
      const ruling = c.ruling ? `；用户决定：${oneLine(c.ruling)}` : '';
      const done = c.doneText ? `；已改：${oneLine(c.doneText)}` : '';
      const because = c.because ? `（重新审：${c.because}）` : '';
      const replyBasis = c.replyBasis ? `（依据：${oneLine(c.replyBasis)}）` : '';
      lines.push(`- #${c.id} [${CRITIQUE_STATUS[c.status] ?? c.status}] ${c.by}${because}：${oneLine(c.text)}${basis}${reply}${replyBasis}${ruling}${done}`);
    }
    lines.push('');
  }
  lines.push('## 历史');
  lines.push('');
  for (const h of task.history) {
    const commit = h.commit ? `（提交 ${h.commit}）` : '';
    lines.push(`- ${formatTime(h.ts)} [${h.type}] ${h.actor}：${oneLine(h.text)}${commit}`);
  }
  return lines.join('\n');
}

function formatDemoTask(task) {
  const lines = [
    `- 类型：演播卡`,
    `- 状态：${statusLabel(task.status)}，${rehearsalFlag(task)}`,
    `- 角色：${task.role}`,
    `- 处理人：${task.assignee ?? '无'}`,
    `- 脚本：\`${task.script}\``,
    '',
    '## 最近的运行',
    '',
  ];
  const runs = (task.runs ?? []).slice(-3).reverse();
  if (!runs.length) lines.push('（还没运行过）');
  for (const r of runs) {
    const saved = r.saved ? `；操作记录${r.commit ? `已提交 ${r.commit}` : '没有改动'}` : '';
    lines.push(`- ${runText(r)} ${r.by}${r.result ? `：${oneLine(r.result)}` : ''}${saved}`);
  }
  lines.push('', '## 历史', '');
  for (const h of task.history) {
    const commit = h.commit ? `（提交 ${h.commit}）` : '';
    lines.push(`- ${formatTime(h.ts)} [${h.type}] ${h.actor}：${oneLine(h.text)}${commit}`);
  }
  return lines.join('\n');
}

const DELIVERY_LABEL = { rejected: '打回意见', answer: 'leader 答复', note: 'leader 补充说明' };

const CRITIQUE_STATUS = {
  open: '等 leader 回复', proposed: 'leader 同意，等用户确认', disputed: 'leader 不同意，等用户裁决',
  redo: '用户已决定，等 leader 照做', resolved: '已处理', closed: '用户决定不改',
  overruled: '用户维持原样', // 旧数据
};

function footer(agentId) {
  return [
    '',
    '',
    '---',
    '**现在就开始做。** 不要先停下来向用户汇报「领到了任务」，也不要问用户要不要开始；直接读代码、改代码。',
    '做完提交后立即回到 ateam wait，整个过程中不要结束本轮回复。',
    '',
    `进度：ateam progress --as ${agentId} "..."`,
    `完成：ateam submit --as ${agentId} "<做了什么、怎么验证的>"`,
  ].join('\n');
}

function deliverySection(delivery) {
  if (!delivery) return '';
  return `\n\n## 未送达的消息\n\n**${DELIVERY_LABEL[delivery.kind] ?? delivery.kind}**：\n\n${delivery.text}`;
}

const HOLDING_REASON = {
  submitted: '已提交，等 leader review',
  asking: '已提问，等 leader 答复',
};

function waitingLines(waiting) {
  if (!waiting) return [];
  if (waiting.frozen) return [`正在演播 ${waiting.frozen.taskId} ${waiting.frozen.title}，派发已暂停，结束后继续派发。`];
  if (waiting.holding) {
    const why = HOLDING_REASON[waiting.holding.status] ?? waiting.holding.status;
    const lines = [`你手上的任务 ${waiting.holding.id} ${why}。`];
    if (waiting.leaving) lines.push('leader 安排你做完这个任务（通过）后下线，到时会收到「# 已下线」。在那之前照常等待和修改。');
    return lines;
  }
  if (waiting.critic && !waiting.leaveAsked) return ['所有的卡都审过了，等 leader 加新卡或改卡。'];
  if (waiting.leaveAsked) {
    return ['你已经空闲了一段时间，系统已替你向 leader 申请下线。leader 同意的话你会收到「# 已下线」；在那之前照常等待，也可能会派新任务过来。'];
  }
  if (!waiting.blocked?.length) return ['你这个角色目前没有待领取的任务，等 leader 派新任务。'];
  return [
    '你这个角色的任务都在等依赖完成：',
    ...waiting.blocked.map((t) => `- ${t.id} ${t.title}：等 ${t.waitingFor.map((d) => `${d.id}（${STATUS[d.status] ?? d.status}）`).join('、')}`),
  ];
}

// round：这是第几次空等。下一条命令带上递增的 --round，让每次调用的命令和输出都不一样，
// 避免 agent 平台把「同一条命令连续重复」判成死循环而强制停下。
export function formatWait(result, agentId, waiting, round = 0) {
  if (!result) {
    const why = waitingLines(waiting);
    const next = round + 1;
    const d = new Date();
    return [
      `暂无任务（第 ${next} 轮等待，${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}）。`,
      `请立即运行下一轮：ateam wait --as ${agentId} --round ${next}`,
      '',
      ...(why.length ? [...why, ''] : []),
      '这是正常的等待，不是工作结束：leader 随时可能派任务、打回或答复。',
      '不要结束本轮，不要向用户总结或提问，原样运行上面那条带 --round 的命令（轮次号每次都不同，这是正常的）。只有用户明确叫你停下时才停。',
    ].join('\n');
  }
  if (result.kind === 'critique_list') {
    return formatCritiqueList(result.tasks, agentId, result.jobs);
  }
  if (result.kind === 'cancelled') {
    return `# 任务 ${result.task?.id ?? ''} 已作废\n\n${result.text}`;
  }
  if (result.kind === 'demo' || result.kind === 'demo_stopped' || result.kind === 'demo_wrap') {
    return formatDemoWait(result, agentId);
  }
  if (result.kind === 'dismissed') {
    return [
      '# 已下线',
      '',
      'leader 安排你下线，工作结束。',
      '',
      '现在请停止：不要再调用 ateam 命令，也不要重新 join。用一两句话告诉用户「已下线」就可以结束本轮了。',
    ].join('\n');
  }
  const { kind, task, delivery } = result;
  const title = `${task.id}：${task.title}`;
  let out;
  switch (kind) {
    case 'task':
      out = `# 新任务 ${title}\n\n${formatTask(task)}${deliverySection(delivery)}`;
      break;
    case 'resume':
      out = `# 继续任务 ${title}\n\n${formatTask(task)}${deliverySection(delivery)}`;
      break;
    case 'handoff':
      out = `# ⚠ 接手任务 ${title}\n\n`
        + '上一位 worker 中途掉线。先阅读下方历史，再在任务路径所在的 git 仓库里运行 git log --oneline -5 和 git status 了解现状（多仓库时用 git -C <仓库目录> ...），在已有改动基础上继续，不要从头做起。\n\n'
        + `${formatTask(task)}${deliverySection(delivery)}`;
      break;
    case 'own':
      out = `# 继续任务 ${title}（你掉线前在做的）\n\n`
        + '你刚才被判定掉线，这个任务退回过待领取，没人接手，现在还给你。先在任务路径所在的仓库里运行 git status，确认改动还和你离开时一样，再接着做。\n\n'
        + `${formatTask(task)}${deliverySection(delivery)}`;
      break;
    case 'rejected':
      out = `# 打回 ${task.id}（第 ${task.rejectCount} 次）\n\n`
        + `## 修改意见\n\n${delivery?.text ?? ''}\n\n逐条修改后再次提交。\n\n`
        + `## 任务 ${title}\n\n${formatTask(task)}`;
      break;
    case 'answer':
      out = `# 答复 ${task.id}\n\n${delivery?.text ?? ''}\n\n按答复继续完成任务 ${title}。`;
      break;
    default:
      out = `# ${kind} ${title}\n\n${formatTask(task)}`;
  }
  if (result.job) {
    out += `\n\n## 所属需求 ${result.job.id}：${result.job.title}\n\n${result.job.description}`;
  }
  if (result.rules) {
    out += `\n\n## 项目规则（每个任务都必须遵守）\n\n${result.rules}`;
  }
  return out + footer(agentId);
}

// 演播卡的指令：预演 / 演播、被叫停、收尾。标题文本 skill 里有引用
const OPS_FORMAT = [
  '操作记录写在脚本的「## 操作记录」段。最开头一行「视口：<宽>x<高>」（就是这次调好的视口）。然后按「## 演示步骤」的编号每步一条，标题写「### <编号>. <简述>」，下面三样都要有：',
  '- **工具：** 一行，写动作块是给哪个浏览器工具用的（比如「工具：browser-cdp」）。',
  '- **动作块：** 一个 ```actions 代码块，用你当前浏览器工具的命令格式，把这一步的点击、输入、按键、等待写全，**下次演播要能一次执行完**（比如一串连续执行的命令）。按元素找目标（选择器、按钮文字、角色 + 名字），**不要录坐标**；名称里的 {时间} 照原样写。',
  '- **预期：** 一行，这一步做完页面上应该看到什么，要能用工具确定地核对（比如「出现提示『保存成功』」「表格第一行是『演示-雷达 {时间}』」「地址变成 /equip/list」），不写「页面正常」这种看不出对错的话。**录的时候实际核对一次**，确认对得上。',
  '- 造数据、跳转页面、提交表单这类「做错了后面全错」的步骤，标题末尾加【核对】。',
  '- 例：',
  '    ### 3. 新建装备【核对】',
  '    工具：browser-cdp',
  '    ```actions',
  '    <这一步的命令，一次执行完>',
  '    ```',
  '    预期：列表第一行出现「演示-现场气象站 {时间}」，右上角提示「保存成功」',
  '- 预演跑完时服务会检查：开头有视口行，每个演示步骤都有「### N.」条目、```actions 动作块和「预期：」行，缺了 demo end 会被拒绝并列出问题。',
];
// 视口：预演和演播都由 worker 用自己的浏览器工具调到目标尺寸
const viewportRule = (vp, agentId) => `**先调视口**：用你的浏览器工具把页面视口（以页面里的 innerWidth / innerHeight 为准）调到 **${vp}**：先读页面视口和窗口的尺寸，按差值设**真实窗口**大小，再读一次确认。只改页面视口、不改窗口的做法不行（页面会以为自己比窗口宽，内容溢出到窗口外）。调不了（比如屏幕不够大）就停住：ateam demo end --as ${agentId} --stuck "视口调不到 ${vp}：<原因>"。`;
function formatDemoWait(result, agentId) {
  const { kind, task, script } = result;
  const mode = script?.mode ?? task.runs?.[task.runs.length - 1]?.mode ?? 'show';
  const rehearsal = mode === 'rehearsal';
  const word = rehearsal ? '预演' : '演播';
  const title = `${task.id}：${task.title}`;
  const scriptBlock = script
    ? (script.error ? `\n\n**${script.error}**。请通知用户。` : `\n\n## 脚本 \`${script.path}\`（共 ${script.steps} 步）\n\n${script.text.trim()}`)
    : '';
  const save = `ateam demo save --as ${agentId} "<记了或改了哪些操作>"`;
  const commitLines = [
    '**只改「## 操作记录」段，不要改「## 准备」「## 演示步骤」「## 清理」三段**，改了会被拒绝提交。',
    `然后运行 ${save}，服务只提交这个脚本文件。操作记录没有改动就加 --no-changes。提交后回到 ateam wait。`,
  ];
  const report = `每开始一步，先报告：ateam demo step --as ${agentId} <第几步>/<总步数> "<这一步做什么>"。步数用脚本里的编号（用户的提词按这个编号取讲解），不要自己重新编号。`;
  const common = [
    '浏览器必须在前台、用户看得见。遵守项目规则和用户的浏览器规则，不用 headless / 后台浏览器。',
    '名称里的 {时间} 换成当前时间；演播造的数据都用「演示-」开头。',
    '**不要提问，不要停下来等人。**',
    '**视口调好之后，整场不再改窗口大小、不缩放页面**（用户看的就是这个尺寸）。内容显示不全、按钮在下面看不到：滚动去找，在弹窗、抽屉里就滚它自己的滚动区域；用浏览器工具点击时一般会自动滚到元素那里。滚动也到不了才算这一步走不通，按走不通处理，不要拉大窗口。',
    `如果 demo step 的输出是「# ${word}已叫停」：立刻停手，停在当前页面，按那条输出做。`,
    '如果 demo step 的输出是「# 演播已暂停」：用户在讲解，这一步先别做。不操作浏览器、不截图，原样运行输出里给的那条命令等待；用户点继续后它返回「已记录」，再接着做这一步（这是唯一可以停下来等的情况）。',
  ];
  let out;
  if (kind === 'demo' && rehearsal) {
    out = [
      `# 预演 ${title}`,
      '',
      '这是**预演**，不对客户。目的是把每一步走通，并把**具体怎么操作**写进脚本的「## 操作记录」段，之后的演播照着它快速执行。慢没关系，要准。',
      '',
      '## 预演规则',
      '',
      ...[
        viewportRule(script?.viewport ?? '1600x800', agentId),
        script?.legacy
          ? '先按「## 准备」段检查状态（有上次残留的「演示-」数据，按准备段处理）。**「## 操作记录」里是旧格式（按坐标录的），作废**：这次按下面的新格式整段重写。'
          : '先按「## 准备」段检查状态（有上次残留的「演示-」数据，按准备段处理）。「## 操作记录」里已有内容（以前预演过），可以参考，但这次要重新走一遍、核实并改正。',
        report,
        '每一步都确认走通了（预期对得上），再做下一步。每步之间按脚本写的秒数停留。',
        '**每走通一步，就马上把这一步写进「## 操作记录」**（不要等到最后，中途停下也要留下已走通的）：',
        ...OPS_FORMAT.map((l) => `   ${l}`),
        ...common,
        `某一步怎么也走不通（功能没了、页面报错、数据不对）：把已走通的写好，停在当前页面，ateam demo end --as ${agentId} --stuck "<卡在第几步、为什么>"。`,
        `全部走通：ateam demo end --as ${agentId} "<结果>"，然后按收到的「# 预演收尾」做。`,
      ].map(((n) => (l) => (l.startsWith('   ') ? l : `${++n}. ${l}`))(0)),
    ].join('\n') + scriptBlock;
  } else if (kind === 'demo') {
    const only = script?.only?.length ? script.only : null;
    out = [
      `# 演播 ${title}`,
      '',
      only
        ? `用户正在给客户现场演播，**这一场只演${stepsLabel(only)}**，你在用户前台的浏览器里按脚本顺序操作这几步，用户在旁边讲解。**要快**：照「## 操作记录」直接做，不要每步都截图、琢磨。`
        : '用户正在给客户现场演播，你在用户前台的浏览器里按脚本**从头到尾顺序操作**，用户在旁边讲解。**要快**：照「## 操作记录」直接做，不要每步都截图、琢磨。',
      '',
      ...(only ? [
        '## 只演部分步骤',
        '',
        `- 这一场只演${stepsLabel(only)}。没列出的步骤**完全不做**，也不要 demo step。`,
        '- **不要执行「## 准备」段**：准备段会清掉上一场留下的「演示-」数据，而这些数据正是接着演要用的。只调好视口（见下面的规则），再确认当前页面能接上第一步。',
        '- 跳过的步骤留下的数据和页面由用户保证。某一步要用的数据不在、页面接不上，就按对不上处理：这一步切慢档；慢档也走不通就停住，--stuck 的说明里写清缺了什么。',
        `- demo step 照样用脚本里的原编号和总步数（比如 ${only[0]}/${script.steps}）。`,
        `- 选中的最后一步（第 ${only[only.length - 1]} 步）跑完就 demo end。`,
        '',
      ] : []),
      '## 演播规则',
      '',
      ...[
        script && !script.hasOps
          ? '⚠ 这张卡的「## 操作记录」是空的（还没预演写过）。这次只能按预演的方式慢慢走，并把每步写进操作记录；提醒用户以后先预演。'
          : `先通读「## 操作记录」${only ? '' : '，按「## 准备」段检查状态'}。`,
        viewportRule(script?.viewport ?? '1600x800', agentId),
        report,
        '**快档（默认）**：报到后把这一步的动作块**一次执行完**（{时间} 换成当前时间），然后**核对「预期：」**。对得上就进下一步，不截图、不琢磨；脚本写了要停几秒的，核对完再停。',
        '**核对**：标了【核对】的步骤，核对预期之外再截一张图自己看一眼。其他步骤不截图。',
        `**慢档**：动作报错、找不到元素、或预期对不上，这一步切慢档：看页面、找元素、想办法把这一步走通，这一步的 demo step 加 --slow（比如 ateam demo step --as ${agentId} 3/12 "新建装备" --slow），把新的动作块和预期写回「## 操作记录」，走通后回到快档继续。`,
        `**停住**：慢档也走不通（功能没了、页面报错、数据不对），停在当前页面，ateam demo end --as ${agentId} --stuck "<卡在第几步、为什么>"。`,
        ...common,
        `全部跑完：ateam demo end --as ${agentId} "<结果：哪些步走了慢档、为什么>"，然后按收到的「# 演播收尾」做。`,
      ].map((l, i) => `${i + 1}. ${l}`),
    ].join('\n') + scriptBlock;
  } else if (kind === 'demo_stopped') {
    out = [
      `# ${word}已叫停 ${title}`,
      '',
      `用户叫停了${word}。**立刻停手，停在当前页面，不要再操作浏览器，也不要清理数据**（客户可能还在看）。`,
      '',
      rehearsal ? '把这次已经走通的步骤写进「## 操作记录」（格式见下）。' : '这次走了慢档的步骤，把新做法更新进「## 操作记录」；没有就不用改。',
      ...(rehearsal ? OPS_FORMAT : []),
      ...commitLines,
    ].join('\n') + scriptBlock;
  } else {
    const done = result.outcome === 'done';
    const only = result.steps?.length ? result.steps : null;
    // 部分演播：跑到了最后一步才清理整场的数据；只演了中间几步就不清理，留给下一场接着用
    const reachedEnd = !only || (script?.steps > 0 && only.includes(script.steps));
    out = [
      `# ${word}收尾 ${title}`,
      '',
      done && !reachedEnd
        ? `这一场只演了${stepsLabel(only)}，没跑到最后一步，**不要清理数据**，留给下一场接着用。`
        : done
        ? `${word}已经跑完。先执行脚本的「## 清理」段：只删名称以「演示-」开头、且标了【数据：清理】的数据，别的一概不动。${only ? '这一场是从中间开始演的，有的数据这一场没造过，找不到就跳过。' : ''}`
        : `这次${word}${result.outcome === 'interrupted' ? '没走通，停住了' : '被叫停了'}，**不要清理数据**，残留留给下次的「## 准备」段处理。`,
      '',
      rehearsal
        ? (done ? '确认「## 操作记录」每一步都写全了（格式见下），有遗漏补上。' : '确认已走通的步骤都写进了「## 操作记录」（格式见下）。')
        : '把走了慢档的步骤的新做法和新动作块更新进「## 操作记录」（覆盖原来那条，动作块格式见预演规则）；没有走慢档就不用改，直接 --no-changes。',
      ...(rehearsal ? OPS_FORMAT : []),
      ...commitLines,
    ].join('\n') + scriptBlock;
  }
  if (result.rules) out += `\n\n## 项目规则（每个任务都必须遵守）\n\n${result.rules}`;
  return `${out}\n\n---\n**现在就开始。** 不要先向用户汇报，也不要问用户要不要开始。整个过程中不要结束本轮回复，做完回到 ateam wait --as ${agentId}。`;
}

// 给审卡 worker 的待审清单
function formatCritiqueList(tasks, agentId, jobs = []) {
  const lines = [`# 待审的卡（${tasks.length} 张）`, ''];
  lines.push('**你只读不写：不要修改、新建、删除项目里的任何文件，也不要运行会改文件的命令（git、npm install、构建、格式化、代码生成都不行）。** 你的改动没人提交，会混进别的 worker 的提交里。发现代码问题就写进审卡意见，由 leader 派人改。', '');
  lines.push('逐张审：对照所属需求的说明、设计文档、同需求的其他卡，以及现有代码，找卡本身的问题。');
  lines.push('看全部的卡（包括审过的，用来查冲突）：ateam cards，或 ateam cards --job J1。', '');
  for (const j of jobs) {
    if (!j.origin?.trim() && !j.description?.trim()) continue;
    lines.push(`## 需求 ${j.id} ${j.title}`, '');
    if (j.origin?.trim()) lines.push('### 用户原话（以它为准）', '', j.origin.trim(), '');
    if (j.description?.trim()) lines.push('### 需求说明', '', j.description.trim(), '');
  }
  for (const t of tasks) {
    lines.push(`## ${t.id}：${t.title}（需求 ${t.jobId}${t.edited ? '，leader 改过，再审一次' : ''}）`, '', formatTask(t), '');
  }
  lines.push('---');
  lines.push(`没问题：ateam critique --as ${agentId} ok T1 T2 ...（可以一次标多张）`);
  lines.push(`有问题：ateam critique --as ${agentId} issue T1 "<问题在哪、为什么是问题、建议怎么改>" --basis "<依据：用户原话的哪一句、设计文档哪一段、代码哪个文件第几行、命令的实际输出>"`);
  lines.push('没有依据、只是「我觉得」的意见不要提。');
  lines.push(`发现和已经审过的旧卡冲突：对旧卡也提 issue，加上 --because "和 T12 冲突"（会记进历史）`);
  lines.push(`全部标完后运行 ateam wait --as ${agentId} 等新卡。不要结束本轮回复。`);
  return lines.join('\n');
}

// ateam cards：全部能审的卡
export function formatCards(cards, { todo = false } = {}) {
  if (!cards.length) return todo ? '没有待审的卡。' : '没有可审的卡（已作废的卡和已验收需求里的卡不审）。';
  const lines = [`# ${todo ? '待审的卡' : '全部的卡'}（${cards.length} 张）`, ''];
  for (const t of cards) {
    const mark = t.reviewed ? '已审' : (t.edited ? '改过，待再审' : '待审');
    lines.push(`## ${t.id}：${t.title}（需求 ${t.jobId}，${mark}）`, '', formatTask(t), '');
  }
  return lines.join('\n').trimEnd();
}

const EVENT_HINT = {
  critique: (e) => `先不要改卡。ateam show ${e.taskId} 看意见和依据，想清楚后回复，都要带依据：同意就 ateam critique agree ${e.taskId} "<打算怎么改>" --basis "<依据>"，不同意就 ateam critique dispute ${e.taskId} "<理由>" --basis "<依据>"。由用户在看板上决定`,
  critique_ruling: (e) => `用户已决定，照做：待领取/已挂起的卡 ateam task edit ${e.taskId} ... 改；进行中的 ateam note ${e.taskId} "<补充说明>" 告诉 worker；已完成的加修复任务。做完 ateam critique done ${e.taskId} "<改了什么>"`,
  question: (e) => `回答：ateam answer ${e.taskId} "<答复>"`,
  submitted: (e) => `review：ateam show ${e.taskId}，然后 ateam approve ${e.taskId} 或 ateam reject ${e.taskId} "<修改意见>"`,
  task_held: (e) => `处理：ateam task edit ${e.taskId} ... 后 ateam release ${e.taskId}，或自己修改后 ateam approve ${e.taskId}`,
  leave_request: (e) => (e.last
    ? `它是 ${e.role} 角色最后一个 worker，下线需要你和用户都同意：近期不会再有 ${e.role} 任务的话，先问用户，用户同意后 ateam dismiss ${e.agentId} --user-approved；要留着就不用管，它会继续等待`
    : `近期不会再有 ${e.role} 任务的话：ateam dismiss ${e.agentId}；要留着就不用管，它会继续等待`),
  worker_stale: (e) => `不要自己收回。问用户 ${e.agentId} 的窗口还在不在（看板上也会弹框问用户）：还在就不用管；用户确认窗口没了，才 ateam reclaim ${e.taskId}`,
  worker_offline: (e) => (e.taskId ? `任务 ${e.taskId} 已退回待领取；用 ateam status 确认，需要时提醒用户开新的 worker 窗口` : ''),
};

export function formatEventLine(e) {
  const subject = [e.jobId, e.taskId, e.agentId].filter(Boolean).join(' ');
  return `${formatTime(e.ts)} [${e.type}]${subject ? ` ${subject}` : ''}：${oneLine(e.text)}`;
}

export function formatEvents(events) {
  if (!events.length) return '暂无新事件。请再次运行：ateam watch';
  const lines = [`# 新事件（${events.length} 条）`, ''];
  for (const e of events) {
    lines.push(`- ${formatEventLine(e)}`);
    const hint = EVENT_HINT[e.type]?.(e);
    if (hint) lines.push(`  - ${hint}`);
  }
  return lines.join('\n');
}

const PENDING_HINT = {
  submitted: (t) => `review：ateam show ${t.id}`,
  asking: (t) => {
    const q = [...t.history].reverse().find((h) => h.type === 'asked');
    return `问题：${oneLine(q?.text ?? '')} —— 回答：ateam answer ${t.id} "<答复>"`;
  },
  held: (t) => `已打回 ${t.rejectCount} 次，挂起：ateam task edit ${t.id} ... 后 ateam release ${t.id}，或自己修改后 ateam approve ${t.id}`,
};

// 默认不列出已验收的需求（只给编号），免得需求越积越多、撑满 leader 的上下文；--job 或 --all 时照常列出
export function formatStatus(state, pending, jobId, root, repos, showAll = false) {
  const now = Date.now();
  const accepted = jobId || showAll ? [] : state.jobs.filter((j) => j.status === 'accepted');
  const cancelledJobs = jobId || showAll ? [] : state.jobs.filter((j) => j.status === 'cancelled');
  const jobs = jobId ? state.jobs.filter((j) => j.id === jobId) : state.jobs.filter((j) => !accepted.includes(j) && !cancelledJobs.includes(j));
  const jobIds = new Set(jobs.map((j) => j.id));
  const lines = ['# ateam 状态', ''];
  if (root) lines.push(`项目目录：${root}`, '');
  if (state.stale) lines.push('⚠ ateam 的代码已更新，服务还在跑旧代码：请提醒用户重启 ateam serve（Ctrl+C 后重新运行）。', '');
  if (repos?.length) lines.push(`多仓库模式，包含 git 仓库：${repos.join('、')}。提交号形如「仓库@提交号」，review 用 git -C <仓库> show <提交号>`, '');

  const mine = pending.filter((t) => jobIds.has(t.jobId));
  lines.push(`## 待你处理（${mine.length}）`, '');
  if (mine.length) {
    for (const t of mine) lines.push(`- ${t.id} [${t.status}] ${t.title} —— ${PENDING_HINT[t.status]?.(t) ?? ''}`);
  } else {
    lines.push('（无）');
  }
  // 依赖已作废的卡：永远等不到依赖完成，不会被派发（老数据才会出现），要 leader 去掉这个依赖
  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  const deadDeps = state.tasks.filter((t) => jobIds.has(t.jobId) && (t.status === 'pending' || t.status === 'held')
    && t.dependsOn.some((d) => byId.get(d)?.status === 'cancelled'));
  if (deadDeps.length) {
    lines.push('', `## 依赖已作废的卡（${deadDeps.length}），永远不会被派发`, '');
    for (const t of deadDeps) {
      const dead = t.dependsOn.filter((d) => byId.get(d)?.status === 'cancelled');
      const keep = t.dependsOn.filter((d) => !dead.includes(d));
      lines.push(`- ${t.id} [${t.status}] ${t.title}：依赖的 ${dead.join('、')} 已作废 —— 去掉这个依赖：ateam task edit ${t.id} --after "${keep.join(',')}"（这张卡也不要了就 ateam cancel ${t.id}）`);
    }
  }
  const critiqued = state.tasks.filter((t) => (t.critiques ?? []).some((c) => c.status === 'open' || c.status === 'redo'));
  if (critiqued.length) {
    lines.push('', `## 审卡意见待你处理（${critiqued.length}）`, '');
    for (const t of critiqued) {
      const redo = t.critiques.filter((c) => c.status === 'redo');
      if (redo.length) {
        lines.push(`- ${t.id} [${t.status}] ${t.title}（用户已决定，照做）：${redo.map((c) => oneLine(c.instruction)).join('；')} —— 做完 ateam critique done ${t.id} "<改了什么>"`);
      } else {
        const open = t.critiques.filter((c) => c.status === 'open');
        lines.push(`- ${t.id} [${t.status}] ${t.title}（等你回复，先别改卡）：${open.map((c) => oneLine(c.text)).join('；')} —— ateam critique agree ${t.id} "<打算怎么改>" --basis "<依据>" 或 dispute ${t.id} "<理由>" --basis "<依据>"`);
      }
    }
  }
  const awaitingUser = state.tasks.filter((t) => (t.critiques ?? []).some((c) => c.status === 'proposed' || c.status === 'disputed'));
  if (awaitingUser.length) lines.push('', `另有 ${awaitingUser.length} 张卡的审卡意见在等用户决定：${awaitingUser.map((t) => t.id).join('、')}（不用你做什么）`);
  const undelivered = state.events.filter((e) => !e.delivered).length;
  if (undelivered) lines.push('', `另有 ${undelivered} 条未读事件：ateam watch`);

  lines.push('', '## worker', '');
  const agents = state.agents.filter((a) => !a.hidden);
  if (agents.length) {
    for (const a of agents) {
      const online = a.status === 'online' ? (a.stale ? '在线，但很久没动静（可能停了，等用户确认）' : '在线') : (a.dismissed ? '已下线' : '掉线');
      const task = (a.currentTask ? `，当前任务 ${a.currentTask}` : '，空闲') + (a.dismiss ? '，做完后下线' : '');
      const who = a.name ? `${a.name}（${a.id}）` : a.id;
      lines.push(`- ${who}，角色 ${a.role}，${online}${task}，上次心跳 ${ago(a.lastSeenAt, now)}`);
    }
  } else {
    lines.push('（还没有 worker 加入）');
  }

  lines.push('', '## 需求', '');
  if (accepted.length) lines.push(`已验收 ${accepted.length} 个，不再列出：${accepted.map((j) => j.id).join('、')}（翻看历史：ateam jobs，单个需求：ateam job show J1）`, '');
  if (cancelledJobs.length) lines.push(`已作废 ${cancelledJobs.length} 个，不再列出：${cancelledJobs.map((j) => j.id).join('、')}`, '');
  if (!jobs.length) lines.push(jobId ? `（找不到需求 ${jobId}）` : (accepted.length || cancelledJobs.length ? '（没有进行中的需求）' : '（还没有需求）'));
  for (const j of jobs) {
    const tasks = state.tasks.filter((t) => t.jobId === j.id);
    const live = tasks.filter((t) => t.status !== 'cancelled');
    if (j.demo) {
      lines.push(`### ${j.id} ${j.title} [演播] 演播卡 ${live.length} 张`, '', ...live.map(demoLine), '');
      continue;
    }
    const done = live.filter((t) => t.status === 'approved').length;
    const hold = j.onHold ? ` 【暂停领取${j.onHold.reason ? `：${j.onHold.reason}` : ''}，待领取的卡不派发；ateam job hold ${j.id} --off 恢复】` : '';
    lines.push(`### ${j.id} ${j.title} [${JOB_STATUS[j.status] ?? j.status}] 已通过 ${done}/${live.length}${hold}`, '');
    for (const t of live) {
      const named = state.agents.find((a) => a.id === t.assignee)?.name;
      const who = t.assignee ? `，${named ? `${named}（${t.assignee}）` : t.assignee}` : '';
      const flags = [t.assignTo && (t.status === 'pending' || t.status === 'held') ? `用户指派给 ${t.assignTo}` : '', t.priority && t.status === 'pending' ? '优先' : '', t.onHold && (t.status === 'pending' || t.status === 'held') ? `暂停领取${t.onHold.reason ? `（${t.onHold.reason}）` : ''}` : '', t.handoff ? '待接手' : '', t.rejectCount ? `打回 ${t.rejectCount} 次` : ''].filter(Boolean).join('，');
      lines.push(`- ${t.id} [${statusLabel(t.status)}] ${t.title}（${t.role}${who}）${flags ? ` ${flags}` : ''}`);
    }
    const cancelled = tasks.filter((t) => t.status === 'cancelled');
    if (cancelled.length) lines.push(`- 已作废：${cancelled.map((t) => t.id).join('、')}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

// 需求列表：每个需求一行，用来翻看历史（status 默认不列已验收的需求）。
// filter：'accepted' 只看已结束的（已验收、已作废），'all' 全部；keyword 在标题、说明、汇报、任务标题里查找。
export function formatJobs(state, { filter = 'accepted', keyword = '' } = {}) {
  let jobs = state.jobs.slice().reverse();
  if (filter === 'accepted') jobs = jobs.filter((j) => j.status === 'accepted' || j.status === 'cancelled');
  const kw = keyword.trim().toLowerCase();
  if (kw) {
    jobs = jobs.filter((j) => [j.title, j.description, j.report,
      ...state.tasks.filter((t) => t.jobId === j.id).map((t) => t.title)]
      .some((text) => String(text ?? '').toLowerCase().includes(kw)));
  }
  const what = filter === 'accepted' ? '已结束的需求（已验收、已作废）' : '需求';
  const head = `# ${what}（${jobs.length}）${kw ? `，包含「${keyword.trim()}」` : ''}`;
  if (!jobs.length) return `${head}\n\n（没有）`;
  const lines = [head, ''];
  for (const j of jobs) {
    const tasks = state.tasks.filter((t) => t.jobId === j.id && t.status !== 'cancelled');
    const when = j.status === 'accepted' && j.acceptedAt ? `，${formatTime(j.acceptedAt)} 验收`
      : j.status === 'cancelled' && j.cancelledAt ? `，${formatTime(j.cancelledAt)} 作废${j.cancelReason ? `：${j.cancelReason}` : ''}` : '';
    lines.push(j.demo
      ? `- ${j.id} ${j.title} [演播] 演播卡 ${tasks.length} 张`
      : `- ${j.id} ${j.title} [${JOB_STATUS[j.status] ?? j.status}${when}] 任务 ${tasks.length} 个`);
  }
  lines.push('', '看某个需求的说明、任务、提交和汇报：ateam job show J1');
  return lines.join('\n');
}

// 一个需求的完整档案：说明、任务（含提交号）、汇报
export function formatJob(state, job) {
  const tasks = state.tasks.filter((t) => t.jobId === job.id);
  const lines = [`# ${job.id} ${job.title}`, ''];
  lines.push(`- 状态：${job.demo ? '演播需求' : JOB_STATUS[job.status] ?? job.status}`);
  if (job.createdAt) lines.push(`- 创建：${formatTime(job.createdAt)}`);
  if (job.acceptedAt) lines.push(`- 验收：${formatTime(job.acceptedAt)}`);
  if (job.cancelledAt) lines.push(`- 作废：${formatTime(job.cancelledAt)}${job.cancelReason ? `，原因：${job.cancelReason}` : ''}`);
  lines.push('', '## 用户原话', '', job.origin?.trim() || '（没有存）');
  lines.push('', '## 说明', '', job.description?.trim() || '（无）', '', '## 任务', '');
  if (!tasks.length) lines.push('（无）');
  for (const t of tasks) {
    if (t.kind === 'demo') { lines.push(demoLine(t)); continue; }
    const commits = t.commits.length ? `，提交 ${t.commits.join('、')}` : '';
    lines.push(`- ${t.id} [${statusLabel(t.status)}] ${t.title}（${t.role}，路径 ${t.paths.join('、')}${commits}）`);
  }
  lines.push('', '任务详情和历史：ateam show T1', '', '## 汇报', '', job.report?.trim() || '（还没有汇报）');
  const crit = tasks.flatMap((t) => (t.critiques ?? []).map((c) => ({ t, c })));
  if (crit.length) {
    lines.push('', '## 审卡改动', '');
    for (const { t, c } of crit) {
      lines.push(`- ${t.id} #${c.id} [${CRITIQUE_STATUS[c.status] ?? c.status}]：${oneLine(c.text)}${c.ruling ? ` → ${oneLine(c.ruling)}` : ''}${c.doneText ? ` → 已改：${oneLine(c.doneText)}` : ''}`);
    }
  }
  return lines.join('\n');
}

export function formatError(code, message) {
  if (code === 'INTERNAL') return `错误：服务内部错误：${message}。请通知用户。`;
  return `错误：${message}`;
}
