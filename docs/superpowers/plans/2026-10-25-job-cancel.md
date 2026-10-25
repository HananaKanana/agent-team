# 作废整个需求 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** leader 在用户授权后用 `ateam job cancel J? "<原因>" --user-approved` 一次作废整个需求：需求标「已作废」，没做完的卡全部作废，已通过的卡和代码不动。

**Architecture:** store 新增 `cancelJob`，复用单卡作废的内部流程（拆出不做依赖检查的 `cancelOne`）；服务加路由，命令行加子命令；看板和命令行展示把 `cancelled` 需求当作已结束（同已验收一样收起）。

**Tech Stack:** Node ≥ 18，ESM，零依赖；单文件看板 `src/dashboard.html`。

**Spec:** `docs/superpowers/specs/2026-10-25-job-cancel-design.md`

## Global Constraints

- 零依赖、ESM、Node ≥ 18；不写测试代码，用 `node --check` + scratchpad 一次性探测脚本（跑完删除）；看板只做语法检查和代码审阅，交用户手工核对。
- 需求字段：`job.status = 'cancelled'`、`job.cancelledAt`（时间戳）、`job.cancelReason`（字符串，可空）。
- 被连带作废的卡，作废原因写 `需求作废：<原因>`（原因为空时写 `需求作废`）。
- 授权沿用现有写法：不带 `--user-approved` → 错误码 `NEEDS_USER`。
- 每完成一个任务，把本计划对应 `- [ ]` 改成 `- [x]` 和代码一起提交。

## Review Focus

1. 需求里卡之间有依赖（T2 依赖 T1，都没做完）：一次作废成功，不被单卡的依赖检查挡住。（Task 1 探测。）
2. 别的需求的卡依赖本需求未完成的卡：拒绝并列出那些卡，什么都没改。（Task 1 探测。）
3. 作废后对这个需求 `addTask` / `editJob` / `report` / `acceptJobs` / `addDemo`：全部拒绝；`addTask` 不会把状态改回 `active`。（Task 1 探测。）
4. worker 正在做的卡被连带作废：它下一次 `wait` 先收到作废通知（和单卡作废一致）；正在演播的卡运行记录记为叫停、派发恢复。（Task 1 探测。）
5. 已验收的需求、已作废的需求再作废：`BAD_STATE`。（Task 1 探测。）

---

### Task 1: store、服务、命令行

**Files:** Modify `src/store.js`、`src/server.js`、`bin/ateam.js`、`src/format.js`

**Interfaces（Produces）:**
- `cancelJob(jobId, reason = '', userApproved = false) -> { job, cancelled: Task[] }`（store 导出）。顺序：`getJob`；状态 `accepted` / `cancelled` → `BAD_STATE`；目标 = 本需求中状态不是 `approved`、`cancelled` 的卡；别的需求里未作废且 `dependsOn` 含目标的卡 → `BAD_STATE` 并列出编号；`!userApproved` → `NEEDS_USER`，信息里逐行列出目标卡「编号 标题（状态）」，并说明「请把这些列给用户，用户明确同意作废整个需求后加 --user-approved 重新运行」（目标为空时写「没有未完成的卡，只会把需求标为已作废」）；通过后对每张目标卡调 `cancelOne(task, 原因)`，需求写 `status / cancelledAt / cancelReason / updatedAt`，`emit('job_cancelled', { jobId, text })`，`changed()`。
- `cancel(taskId, reason)` 改为：原有状态检查 + 依赖检查后调用新的内部 `cancelOne(task, reason)`（原来的作废主体搬进去，行为不变）。
- 作废后的需求拒绝修改：`editJob`、`addTask`、`addDemo`、`report`、`acceptJobs` 开头检查 `job.status === 'cancelled'` → `BAD_STATE`「需求 J? 已作废」。`critiquable` 把 `cancelled` 需求和 `accepted` 一样排除。
- 路由 `POST /api/jobs/cancel`：body `{ id, text, userApproved }` → `{ job, cancelled }`。
- 命令 `ateam job cancel J1 ["<原因>"] [--user-approved]`；USAGE 加在 leader 段 `job accept` 之后。输出：`已作废需求 J1：<标题>。连带作废 n 张卡：T3、T4；已通过的卡和代码保留。正在做这些卡的 worker 下次调用 ateam 时会收到停手通知。`
- format.js：`JOB_STATUS` 加 `cancelled: '已作废'`；`formatStatus` 默认收起的需求从「已验收」扩为「已验收或已作废」（`--job` / `--all` 照常列出）；`formatJobs` 的 `filter === 'accepted'` 改为列出已验收**和**已作废，作废的行写「，<时间> 作废：<原因>」。

- [x] **Step 1:** 实现。
- [x] **Step 2:** scratchpad 探测（`createStore` 驱动）：J1 有 T1（approved）、T2（pending）、T3（pending，依赖 T2）、T4（worker 正在做）；不带授权 `cancelJob('J1','x')` 抛 `NEEDS_USER` 且信息含 T2、T3、T4，不含 T1，状态都没变；J2 的 T5 依赖 T2 时带授权也抛 `BAD_STATE` 含 T5；去掉 T5 依赖后带授权成功：T1 仍 approved，T2–T4 cancelled、`cancelReason === '需求作废：x'`，J1 `status === 'cancelled'`；做 T4 的 worker 下一次 `nextFor` 返回 `kind === 'cancelled'`；之后 `addTask`、`editJob`、`report`、`acceptJobs` 对 J1 都抛 `BAD_STATE`；再 `cancelJob` 抛 `BAD_STATE`；演播需求里 demoing 的卡作废后 `demoFrozen()` 为假、最后一场 `outcome === 'stopped'`。
  Run: `node --check src/store.js src/server.js src/format.js bin/ateam.js && node <scratchpad>/probe-job-cancel.mjs` → `ALL PASS`，删除脚本。
- [x] **Step 3: Commit** `store/server/cli: cancel a whole job (ateam job cancel, user-approved)`

### Task 2: 看板

**Files:** Modify `src/dashboard.html`

- `JOB_STATUS` 加 `cancelled: '已作废'`，`JOB_LOZENGE` 加 `cancelled: 'cancelled'`。
- 左侧需求列表（`renderNav` 里 `open` / `done` 的划分）：`open` 排除 `cancelled`；新增 `cancelledJobs` 分组，放在「已验收」分组之后，样式和折叠方式同「已验收」（折叠状态单独记，键 `ateam.cancelledJobsOpen`，默认收起），标题「已作废（n）」；行内状态显示「已作废」。
- 需求页头部：`job.status === 'cancelled'` 时，在说明上方加一行提示（`.job-cancelled`，浅色、左边一条 `--cancelled` 色条）：「<时间> 作废<：原因>。已通过的卡和代码保留，没做完的卡已作废。」
- `attentionItems` 等「需要你处理」的来源：跳过 `cancelled` 需求的事项（检查现有对 `accepted` 的排除处，同样排除 `cancelled`）。
- 概览卡的耗时：`cancelled` 时按 `cancelledAt` 截止，标签「到作废」。

- [x] **Step 1:** 实现。
- [x] **Step 2:** 语法检查 `node -e "…new Function(…)"` → `syntax ok`；代码审阅：没有 `cancelled` 需求时页面不变。
- [x] **Step 3: Commit** `dashboard: cancelled jobs — own collapsed group, notice on the job page`

### Task 3: skill 与核对清单

**Files:** Modify `skills/ateam-lead/SKILL.md`、`docs/manual-checklist.md`

- leader skill：命令表 / 相关章节加 `ateam job cancel`：只有用户明确要求作废某个需求时才用，不要自己提出；先不带 `--user-approved` 运行一次，把输出列出的卡给用户看，用户同意后加 `--user-approved` 再运行；已通过的卡和代码会保留。
- 核对清单追加：不带授权被拒并列出卡；带授权后需求进「已作废」分组、页面有作废提示；正在做的 worker 收到停手通知；已通过的卡仍在；作废后 `ateam task add --job` 被拒。
- [ ] **Step 1:** 实现。
- [ ] **Step 2: Commit** `skills: job cancel; checklist`
