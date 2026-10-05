// 把任务、事件、状态渲染成给大模型读的 markdown 文本。
// 工人 skill 依赖 formatWait 的标题文本，修改时要同步 skills/ateam-worker/SKILL.md。

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

const DELIVERY_LABEL = { rejected: '打回意见', answer: '主管答复' };

function footer(agentId) {
  return [
    '',
    '---',
    `进度：ateam progress --as ${agentId} "..."`,
    `完成：ateam submit --as ${agentId} "<做了什么、怎么验证的>"`,
  ].join('\n');
}

function deliverySection(delivery) {
  if (!delivery) return '';
  return `\n\n## 未送达的消息\n\n**${DELIVERY_LABEL[delivery.kind] ?? delivery.kind}**：\n\n${delivery.text}`;
}

export function formatWait(result, agentId) {
  if (!result) {
    return [
      `暂无任务。请立即再次运行：ateam wait --as ${agentId}`,
      '',
      '这是正常的等待，不是工作结束：主管随时可能派任务、打回或答复。',
      '不要结束本轮，不要向用户总结或提问，直接再次运行上面的命令。只有用户明确叫你停下时才停。',
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
        + '上一位工人中途掉线。先阅读下方历史，再运行 git log --oneline -5 和 git status 了解现状，在已有改动基础上继续，不要从头做起。\n\n'
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
  worker_offline: (e) => (e.taskId ? `任务 ${e.taskId} 已退回待领取；用 ateam status 确认，需要时提醒用户开新的工人窗口` : ''),
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

  lines.push('', '## 工人', '');
  if (state.agents.length) {
    for (const a of state.agents) {
      const online = a.status === 'online' ? '在线' : '掉线';
      const task = a.currentTask ? `，当前任务 ${a.currentTask}` : '，空闲';
      lines.push(`- ${a.id}（${a.role}）${online}${task}，上次心跳 ${ago(a.lastSeenAt, now)}`);
    }
  } else {
    lines.push('（还没有工人加入）');
  }

  lines.push('', '## 需求', '');
  if (!jobs.length) lines.push(jobId ? `（找不到需求 ${jobId}）` : '（还没有需求）');
  for (const j of jobs) {
    const tasks = state.tasks.filter((t) => t.jobId === j.id);
    const live = tasks.filter((t) => t.status !== 'cancelled');
    const done = live.filter((t) => t.status === 'approved').length;
    lines.push(`### ${j.id} ${j.title} [${JOB_STATUS[j.status] ?? j.status}] 已通过 ${done}/${live.length}`, '');
    for (const t of live) {
      const who = t.assignee ? `，${t.assignee}` : '';
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
