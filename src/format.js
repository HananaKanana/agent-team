// 把任务、事件、状态渲染成给大模型读的 markdown 文本。
// worker skill 依赖 formatWait 的标题文本，修改时要同步 skills/ateam-worker/SKILL.md。

const STATUS = {
  pending: '待领取',
  working: '进行中',
  asking: '等待答复',
  submitted: '待 review',
  approved: '已通过',
  held: '已挂起',
  cancelled: '已作废',
  // 演示卡
  ready: '待演示',
  queued: '等待开始',
  demoing: '演示中',
  wrapping: '收尾中',
};

const RUN_OUTCOME = { done: '跑完', stopped: '叫停', interrupted: '中断' };

// 演示卡一行摘要：脚本、演示次数、上一次的结果
function demoLine(t) {
  const runs = t.runs ?? [];
  const last = runs[runs.length - 1];
  const lastText = last ? `，上次 ${formatTime(last.startedAt)} ${RUN_OUTCOME[last.outcome] ?? '进行中'}` : '';
  return `- ${t.id} [${STATUS[t.status] ?? t.status}] ${t.title}（${t.role}，脚本 ${t.script}，已演示 ${runs.length} 次${lastText}）`;
}

const JOB_STATUS = {
  planning: '规划中',
  active: '进行中',
  awaiting_acceptance: '待用户验收',
  accepted: '已验收',
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
    `- 类型：演示卡`,
    `- 状态：${statusLabel(task.status)}`,
    `- 角色：${task.role}`,
    `- 处理人：${task.assignee ?? '无'}`,
    `- 脚本：\`${task.script}\``,
    '',
    '## 最近的演示',
    '',
  ];
  const runs = (task.runs ?? []).slice(-3).reverse();
  if (!runs.length) lines.push('（还没演示过）');
  for (const r of runs) {
    const saved = r.saved ? `；经验${r.commit ? `已提交 ${r.commit}` : '：无新内容'}` : '';
    lines.push(`- ${formatTime(r.startedAt)} ${r.by} ${RUN_OUTCOME[r.outcome] ?? '进行中'}${r.result ? `：${oneLine(r.result)}` : ''}${saved}`);
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
  if (waiting.frozen) return [`正在演示 ${waiting.frozen.taskId} ${waiting.frozen.title}，派发已暂停，演示结束后继续派发。`];
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

// 演示卡的三种指令：开始演示、被叫停、收尾。标题文本 skill 里有引用
function formatDemoWait(result, agentId) {
  const { kind, task, script } = result;
  const title = `${task.id}：${task.title}`;
  const scriptBlock = script
    ? (script.error ? `\n\n**${script.error}**。请通知用户。` : `\n\n## 脚本 \`${script.path}\`（共 ${script.steps} 步）\n\n${script.text.trim()}`)
    : '';
  const save = `ateam demo save --as ${agentId} "<记了哪些经验>"`;
  const experience = [
    `把这次的经验追加到脚本 \`${task.script}\` 的「## 经验」段：只记怎么操作更稳（等多久、先点哪里、哪个弹窗要先关）；已有的同类经验就更新那一条，不要重复记。`,
    '**不要改「## 准备」「## 演示步骤」「## 清理」三段**，改了会被拒绝提交。',
    `然后运行 ${save}，服务只提交这个脚本文件。没有新经验就加 --no-changes。`,
    '提交后回到 ateam wait。',
  ];
  let out;
  if (kind === 'demo') {
    out = [
      `# 演示 ${title}`,
      '',
      '用户正在给客户现场演示，你在用户前台的浏览器里按下面的脚本**从头到尾顺序操作**，用户在旁边讲解。',
      '',
      '## 演示规则',
      '',
      '1. 先读「## 经验」段，照着经验操作；再按「## 准备」段检查状态（有上次残留的「演示-」数据，按准备段处理）。',
      '2. 浏览器必须在前台、用户看得见。遵守项目规则和用户的浏览器规则，不用 headless / 后台浏览器。',
      `3. 每开始一步，先报告：ateam demo step --as ${agentId} <第几步>/<总步数> "<这一步做什么>"。步数用脚本里的编号（用户的提词按这个编号取讲解），不要自己重新编号。看板会实时显示。`,
      '4. 每步之间按脚本写的秒数停留，让客户看清楚。',
      '5. 名称里的 {时间} 换成当前时间；演示造的数据都用「演示-」开头。',
      '6. **不要提问，不要停下来等人。** 页面慢、弹窗挡住这类小问题自己处理后继续；真走不下去就跳过这一步，记下来，继续下一步。',
      `7. 如果 demo step 的输出是「# 演示已叫停」：立刻停手，停在当前页面，按那条输出做。`,
      `8. 全部跑完：ateam demo end --as ${agentId} "<结果：哪些步顺利，哪些跳过、为什么>"，然后按收到的「# 演示收尾」做。`,
    ].join('\n') + scriptBlock;
  } else if (kind === 'demo_stopped') {
    out = [
      `# 演示已叫停 ${title}`,
      '',
      '用户叫停了演示。**立刻停手，停在当前页面，不要再操作浏览器，也不要清理数据**（客户可能还在看）。',
      '',
      ...experience,
    ].join('\n') + scriptBlock;
  } else {
    const done = result.outcome === 'done';
    out = [
      `# 演示收尾 ${title}`,
      '',
      done
        ? '演示已经跑完，客户看完了。先执行脚本的「## 清理」段：只删名称以「演示-」开头、且标了【数据：清理】的数据，别的一概不动。'
        : '这次演示被叫停了，**不要清理数据**，残留留给下次演示的「## 准备」段处理。',
      '',
      ...experience,
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
  const jobs = jobId ? state.jobs.filter((j) => j.id === jobId) : state.jobs.filter((j) => !accepted.includes(j));
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
  if (!jobs.length) lines.push(jobId ? `（找不到需求 ${jobId}）` : (accepted.length ? '（没有未验收的需求）' : '（还没有需求）'));
  for (const j of jobs) {
    const tasks = state.tasks.filter((t) => t.jobId === j.id);
    const live = tasks.filter((t) => t.status !== 'cancelled');
    if (j.demo) {
      lines.push(`### ${j.id} ${j.title} [演示] 演示卡 ${live.length} 张`, '', ...live.map(demoLine), '');
      continue;
    }
    const done = live.filter((t) => t.status === 'approved').length;
    lines.push(`### ${j.id} ${j.title} [${JOB_STATUS[j.status] ?? j.status}] 已通过 ${done}/${live.length}`, '');
    for (const t of live) {
      const named = state.agents.find((a) => a.id === t.assignee)?.name;
      const who = t.assignee ? `，${named ? `${named}（${t.assignee}）` : t.assignee}` : '';
      const flags = [t.assignTo && (t.status === 'pending' || t.status === 'held') ? `用户指派给 ${t.assignTo}` : '', t.priority && t.status === 'pending' ? '优先' : '', t.handoff ? '待接手' : '', t.rejectCount ? `打回 ${t.rejectCount} 次` : ''].filter(Boolean).join('，');
      lines.push(`- ${t.id} [${statusLabel(t.status)}] ${t.title}（${t.role}${who}）${flags ? ` ${flags}` : ''}`);
    }
    const cancelled = tasks.filter((t) => t.status === 'cancelled');
    if (cancelled.length) lines.push(`- 已作废：${cancelled.map((t) => t.id).join('、')}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

// 需求列表：每个需求一行，用来翻看历史（status 默认不列已验收的需求）。
// filter：'accepted' 只看已验收，'all' 全部；keyword 在标题、说明、汇报、任务标题里查找。
export function formatJobs(state, { filter = 'accepted', keyword = '' } = {}) {
  let jobs = state.jobs.slice().reverse();
  if (filter === 'accepted') jobs = jobs.filter((j) => j.status === 'accepted');
  const kw = keyword.trim().toLowerCase();
  if (kw) {
    jobs = jobs.filter((j) => [j.title, j.description, j.report,
      ...state.tasks.filter((t) => t.jobId === j.id).map((t) => t.title)]
      .some((text) => String(text ?? '').toLowerCase().includes(kw)));
  }
  const what = filter === 'accepted' ? '已验收的需求' : '需求';
  const head = `# ${what}（${jobs.length}）${kw ? `，包含「${keyword.trim()}」` : ''}`;
  if (!jobs.length) return `${head}\n\n（没有）`;
  const lines = [head, ''];
  for (const j of jobs) {
    const tasks = state.tasks.filter((t) => t.jobId === j.id && t.status !== 'cancelled');
    const when = j.status === 'accepted' && j.acceptedAt ? `，${formatTime(j.acceptedAt)} 验收` : '';
    lines.push(j.demo
      ? `- ${j.id} ${j.title} [演示] 演示卡 ${tasks.length} 张`
      : `- ${j.id} ${j.title} [${JOB_STATUS[j.status] ?? j.status}${when}] 任务 ${tasks.length} 个`);
  }
  lines.push('', '看某个需求的说明、任务、提交和汇报：ateam job show J1');
  return lines.join('\n');
}

// 一个需求的完整档案：说明、任务（含提交号）、汇报
export function formatJob(state, job) {
  const tasks = state.tasks.filter((t) => t.jobId === job.id);
  const lines = [`# ${job.id} ${job.title}`, ''];
  lines.push(`- 状态：${job.demo ? '演示需求' : JOB_STATUS[job.status] ?? job.status}`);
  if (job.createdAt) lines.push(`- 创建：${formatTime(job.createdAt)}`);
  if (job.acceptedAt) lines.push(`- 验收：${formatTime(job.acceptedAt)}`);
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
