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
};

const JOB_STATUS = {
  planning: '规划中',
  active: '进行中',
  awaiting_acceptance: '待用户验收',
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
  lines.push('## 历史');
  lines.push('');
  for (const h of task.history) {
    const commit = h.commit ? `（提交 ${h.commit}）` : '';
    lines.push(`- ${formatTime(h.ts)} [${h.type}] ${h.actor}：${oneLine(h.text)}${commit}`);
  }
  return lines.join('\n');
}

const DELIVERY_LABEL = { rejected: '打回意见', answer: 'leader 答复' };

function footer(agentId) {
  return [
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
  if (waiting.holding) {
    const why = HOLDING_REASON[waiting.holding.status] ?? waiting.holding.status;
    const lines = [`你手上的任务 ${waiting.holding.id} ${why}。`];
    if (waiting.dismissing) lines.push('leader 已安排你下线：这个任务结束后（通过、作废或被收回）你就下线，不会再领新任务。在那之前继续正常等待。');
    return lines;
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
      out = `# 继续任务 ${title}\n\n${formatTask(task)}`;
      break;
    case 'handoff':
      out = `# ⚠ 接手任务 ${title}\n\n`
        + '上一位 worker 中途掉线。先阅读下方历史，再运行 git log --oneline -5 和 git status 了解现状，在已有改动基础上继续，不要从头做起。\n\n'
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
  return out + footer(agentId);
}

const EVENT_HINT = {
  question: (e) => `回答：ateam answer ${e.taskId} "<答复>"`,
  submitted: (e) => `review：ateam show ${e.taskId}，然后 ateam approve ${e.taskId} 或 ateam reject ${e.taskId} "<修改意见>"`,
  task_held: (e) => `处理：ateam task edit ${e.taskId} ... 后 ateam release ${e.taskId}，或自己修改后 ateam approve ${e.taskId}`,
  worker_offline: (e) => (e.taskId ? `任务 ${e.taskId} 已退回待领取；用 ateam status 确认，需要时提醒用户开新的 worker 窗口` : ''),
};

export function formatEventLine(e) {
  const subject = [e.taskId, e.agentId].filter(Boolean).join(' ');
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
  held: (t) => `已打回 3 次：ateam task edit ${t.id} ... 后 ateam release ${t.id}，或自己修改后 ateam approve ${t.id}`,
};

export function formatStatus(state, pending, jobId, root) {
  const now = Date.now();
  const jobs = jobId ? state.jobs.filter((j) => j.id === jobId) : state.jobs;
  const jobIds = new Set(jobs.map((j) => j.id));
  const lines = ['# ateam 状态', ''];
  if (root) lines.push(`项目目录：${root}`, '');

  const mine = pending.filter((t) => jobIds.has(t.jobId));
  lines.push(`## 待你处理（${mine.length}）`, '');
  if (mine.length) {
    for (const t of mine) lines.push(`- ${t.id} [${t.status}] ${t.title} —— ${PENDING_HINT[t.status]?.(t) ?? ''}`);
  } else {
    lines.push('（无）');
  }
  const undelivered = state.events.filter((e) => !e.delivered).length;
  if (undelivered) lines.push('', `另有 ${undelivered} 条未读事件：ateam watch`);

  lines.push('', '## worker', '');
  const agents = state.agents.filter((a) => !a.hidden);
  if (agents.length) {
    for (const a of agents) {
      const online = a.status === 'online' ? (a.dismiss ? '在线（已安排下线）' : '在线') : (a.dismissed ? '已下线' : '掉线');
      const task = a.currentTask ? `，当前任务 ${a.currentTask}` : '，空闲';
      const who = a.name ? `${a.name}（${a.id}）` : a.id;
      lines.push(`- ${who}，角色 ${a.role}，${online}${task}，上次心跳 ${ago(a.lastSeenAt, now)}`);
    }
  } else {
    lines.push('（还没有 worker 加入）');
  }

  lines.push('', '## 需求', '');
  if (!jobs.length) lines.push(jobId ? `（找不到需求 ${jobId}）` : '（还没有需求）');
  for (const j of jobs) {
    const tasks = state.tasks.filter((t) => t.jobId === j.id);
    const live = tasks.filter((t) => t.status !== 'cancelled');
    const done = live.filter((t) => t.status === 'approved').length;
    lines.push(`### ${j.id} ${j.title} [${JOB_STATUS[j.status] ?? j.status}] 已通过 ${done}/${live.length}`, '');
    for (const t of live) {
      const named = state.agents.find((a) => a.id === t.assignee)?.name;
      const who = t.assignee ? `，${named ? `${named}（${t.assignee}）` : t.assignee}` : '';
      const flags = [t.handoff ? '待接手' : '', t.rejectCount ? `打回 ${t.rejectCount} 次` : ''].filter(Boolean).join('，');
      lines.push(`- ${t.id} [${statusLabel(t.status)}] ${t.title}（${t.role}${who}）${flags ? ` ${flags}` : ''}`);
    }
    const cancelled = tasks.filter((t) => t.status === 'cancelled');
    if (cancelled.length) lines.push(`- 已作废：${cancelled.map((t) => t.id).join('、')}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function formatError(code, message) {
  if (code === 'INTERNAL') return `错误：服务内部错误：${message}。请通知用户。`;
  return `错误：${message}`;
}
