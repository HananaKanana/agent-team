# 演播选步骤 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 已预演的演播卡开始演播时可以「从第 N 步开始」或「只演选中的几步」；预演不能选步骤。

**Architecture:** 开始演播时把选中的步骤编号交给服务，挂在卡上（`pendingSteps`），worker 领取时写进运行记录 `run.steps`；`demo step` 更新 `run.lastStep`。worker 指令、收尾清理、看板进度都读 `run.steps`。看板在点「开始演播」时弹窗选择。

**Tech Stack:** Node ≥ 18，ESM，零依赖；单文件看板 `src/dashboard.html`。

**Spec:** `docs/superpowers/specs/2026-10-25-demo-step-selection-design.md`

## Global Constraints

- 零依赖、ESM、Node ≥ 18；不写测试代码，用 `node --check` + scratchpad 一次性探测脚本（跑完删除）；看板只做语法检查和代码审阅，交用户手工核对。
- 字段：`run.steps`（升序去重整数数组；缺省 = 完整演播）、`run.lastStep`（整数）、`task.pendingSteps`（开始到领取之间暂存）。
- 选中全部步骤时不记 `steps`。预演传了步骤一律拒绝：「预演要从头完整走，不能选步骤」。
- 部分演播：不执行「## 准备」段；只做选中的步骤；步骤编号用原编号（`12/21`）。
- 清理：`outcome === 'done'` 且（完整演播或选中步骤包含最后一步）才清理；否则不清理。
- 老数据：run 没有 `steps` / `lastStep` 按完整演播处理。
- 每完成一个任务，把本计划对应 `- [ ]` 改成 `- [x]` 和代码一起提交。

## Review Focus

1. 选中的步骤含越界编号、重复、非整数、空数组：`startDemo` 拒绝（空、越界、非整数）或去重排序（重复）。（Task 1 探测。）
2. 选中全部步骤：等同完整演播，`run.steps` 不存在，收尾照常清理。（Task 1 探测。）
3. 部分演播跑完但不含最后一步：收尾指令不清理；含最后一步：清理。（Task 2 探测。）
4. 部分演播里 worker 报了没选中的步骤：`demoStep` 拒绝，错误信息列出本场步骤。（Task 1 探测。）
5. 读不到脚本（总步数未知）时传了步骤：服务拒绝并说明原因，不进入排队。（Task 2 探测。）

---

### Task 1: store

**Files:** Modify `src/store.js`（`startDemo`、`claimDemo`、`demoStep`、wrapping 结果 `demo_wrap`）

**Interfaces（Produces）:**
- `startDemo(taskId, mode = 'show', steps = null, totalSteps = null)`：`steps` 为数组时校验——`mode === 'rehearsal'` → `INVALID`「预演要从头完整走，不能选步骤」；`totalSteps` 不是正整数 → `INVALID`「读不到脚本的步数，不能选步骤」；去重升序后为空、或含非整数、或越出 1…totalSteps → `INVALID`（说明合法范围）；长度等于 totalSteps → 视为完整演播。有效时 `task.pendingSteps = steps`。
- `claimDemo`：`task.pendingSteps` 存在时写进 `run.steps` 并删掉；`addHistory` 文案在部分演播时加「（第 x–y 步 / 选 n 步）」。
- `demoStep`：成功时 `run.lastStep = n`；`run.steps` 存在且不含 `n` → `INVALID`「这一场只演第 …步，第 n 步不在其中」。
- 新导出辅助 `stepsLabel(steps): string`：连续区间写「第 12–21 步」，否则「第 3、5、7 步」；`null` 返回空串。供 format.js 使用（放 `src/demo.js`，store 和 format 都从那里引）。
- wrapping 结果：`{ kind: 'demo_wrap', task, outcome, steps }`，`steps` = 最后一场的 `run.steps ?? null`。

- [x] **Step 1:** 在 `src/demo.js` 加 `stepsLabel`；实现 store 改动。
- [x] **Step 2:** scratchpad 探测（`createStore` 驱动，先预演跑完一张卡）：`startDemo(id,'rehearsal',[2])` 抛 INVALID；`startDemo(id,'show',[],21)`、`[0]`、`[22]`、`[1.5]` 抛 INVALID；`[5,3,3]` → 领取后 `run.steps` 为 `[3,5]`；选 1…21 全部 → `run.steps` 不存在；部分演播 `demoStep(…, 4, 21, …)` 抛 INVALID，`demoStep(…, 5, 21, …)` 后 `run.lastStep === 5`；`stepsLabel([12,13,14])==='第 12–14 步'`、`stepsLabel([3,5,7])==='第 3、5、7 步'`。
  Run: `node --check src/store.js src/demo.js && node <scratchpad>/probe-steps-store.mjs` → `ALL PASS`，删除脚本。
- [x] **Step 3: Commit** `store: show runs can select steps (run.steps, run.lastStep)`

### Task 2: server、worker 指令、命令行展示

**Files:** Modify `src/server.js`、`src/format.js`

**Interfaces:**
- Consumes: Task 1 的 `startDemo(taskId, mode, steps, totalSteps)`、`stepsLabel`、`demo_wrap.steps`。
- `POST /api/demo/start`：body 可带 `steps`（数组）。带了就读脚本 `stepCount(text)` 作为 `totalSteps` 传入；读不到脚本时 `totalSteps = null`（由 store 拒绝）。
- wait 结果 `out.script.steps` 已是总步数；新增 `out.script.only = run.steps ?? null`。
- `formatDemoWait`，`# 演播`（非预演）且 `script.only` 存在时，在演播规则最前面插一段（措辞照 spec 5.2）：这一场只演 `stepsLabel(only)`，没列出的步骤完全不做也不 `demo step`；**不执行「## 准备」段**，只核对视口并截图确认页面能接上第一步；跳过的步骤留下的数据由用户保证，缺数据 / 接不上按对不上处理（慢档 → `--stuck` 写清缺了什么）；`demo step` 用原编号和总步数；选中的最后一步跑完就 `demo end`。并把原来「先通读操作记录，按「## 准备」段检查状态」一句改为部分演播时不提准备段。
- 收尾 `# 演播收尾`：`outcome === 'done'` 且 `steps` 存在且不含总步数（最后一步）→ 写「这一场只演了 <stepsLabel>，没跑到最后一步，不清理，数据留给下一场接着用」，替换原来的清理句；包含最后一步 → 原清理句后补「有的数据这一场没造过，找不到就跳过」。总步数从 wrap 结果附带的 `script.steps` 取（server 在 demo_wrap 时也附 script，现状已附）。
- `formatDemoTask` / `demoLine` 的运行记录：run 有 `steps` 时附 `stepsLabel(run.steps)`。

- [x] **Step 1:** 实现。
- [x] **Step 2:** scratchpad 探测（临时 git 仓库 + 真服务，脚本 5 步）：预演跑完后 `start {mode:'show', steps:[3,4]}` → wait 输出含「第 3–4 步」「不执行「## 准备」段」；`start {mode:'rehearsal', steps:[2]}` 返回错误；脚本文件改名后 `start {steps:[2]}` 返回「读不到脚本的步数」；部分演播 `demo end` 后 wait 的收尾输出含「不清理」；`steps:[4,5]` 跑完收尾含「找不到就跳过」且不含「不清理」。
  Run: `node --check src/server.js src/format.js && node <scratchpad>/probe-steps-server.mjs <scratchpad>` → `ALL PASS`，删除脚本和临时目录。
- [x] **Step 3: Commit** `server/cli: show runs with selected steps — worker rules skip prep, cleanup only when the last step ran`

### Task 3: 看板

**Files:** Modify `src/dashboard.html`

**Interfaces:**
- Consumes: `run.steps`、`run.lastStep`、`opsCache.get(id).steps`（`/api/demo/ops` 已返回的步骤列表 `{ n, text, … }`）；`POST /api/demo/start` 的 `steps`。
- `demoAction('start', t, mode, steps)`：body 带 `steps`（缺省不带）。
- 「开始演播」按钮改为打开弹窗 `openShowDialog(t)`；「开始预演」「重新预演」不变。弹窗用现有 `.modal-back` / `.modal` / `modalHead` 样式，新容器 `<div class="modal-back" id="show-dialog" …>`。
- 弹窗内容（spec 5.4）：单选「从头完整演播」/「从第 N 步开始」（`<select>`，选项文字「N. 这一步做什么」）/「只演选中的几步」（复选框列表 + 全选 / 全不选）。默认：上一场 outcome 为 `interrupted` 或 `stopped` 且有 `lastStep` → 选项 2，N = lastStep，选项文字「从第 N 步继续（上一场停在这里）」；否则选项 1。`t.mayChange` 时显示「页面可能有变动，建议先重新预演」。确认按钮文字：「开始演播」/「从第 N 步开始演播（N–M）」/「演播选中的 k 步」，k=0 时禁用。开始失败时错误显示在弹窗内，不关窗。步骤列表区 `max-height` 内滚动。脚本步骤还没加载（opsCache 无 steps）时先请求再渲染。
- 进行中（取最后一场 `run.steps`）：`stepsBar` 没选中的格子加类 `skip`（浅色虚线样式）；提词区、提词小窗、悬浮窗的步骤头在部分演播时追加「本场 i/k」（i = 当前步在 `run.steps` 中的序号）；`stepOutline` 没选中的步骤加类 `skip` 变灰并标「本场跳过」。
- 运行记录表（`stagePanels` 的 `.demo-runs`）：run 有 `steps` 时说明列前加 `第 12–21 步` / `选 4 步：3、5、7、8`（看板内自写一个同规则的 `stepsLabel`）。

- [x] **Step 1:** 实现。
- [x] **Step 2:** 语法检查 `node -e "…new Function(…)"` → `syntax ok`；代码审阅：未预演卡不出弹窗，预演按钮路径不变，提词窗（`PROMPTER_ONLY`）无报错。
- [x] **Step 3: Commit** `dashboard: start-show dialog (from step N / selected steps), skipped steps dimmed in bar and outline, 本场 progress`

### Task 4: skill 与核对清单

**Files:** Modify `skills/ateam-worker/SKILL.md`、`skills/ateam-lead/SKILL.md`、`docs/manual-checklist.md`

- worker：主循环表 `# 演播` 一行补「部分演播（指令里列了这一场的步骤）只做列出的步骤，不执行「## 准备」段」。
- leader：演播卡一节补「演播可以从某一步开始或只演几步，在看板点『开始演播』的弹窗里选；预演总是完整跑」。
- 核对清单：追加 spec 第 7 节 7 条，接在现有编号后。
- [x] **Step 1:** 实现。
- [x] **Step 2: Commit** `skills: demo step selection; checklist`
