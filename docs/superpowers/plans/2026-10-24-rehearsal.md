# 演播卡预演 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 演示卡改名演播卡；分预演（慢，写逐步操作记录）和演播（按记录快速执行，关键节点核对，对不上切慢档，走不通停住）；新代码通过 review 后提示「页面可能有变动」。

**Architecture:** 在现有演示卡状态机上加运行类型 `mode`（`rehearsal` / `show`）和卡级标记 `rehearsedAt` / `mayChange`；脚本的 worker 可写段从「## 经验」改为「## 操作记录」（兼容旧名）；文字层统一改名，内部 `demo` 命名不动。

**Tech Stack:** Node ≥ 18，ESM，零依赖；单文件看板 `src/dashboard.html`。

**Spec:** `docs/superpowers/specs/2026-10-24-rehearsal-design.md`（前置 `2026-10-24-demo-cards-design.md`）

## Global Constraints

- 零依赖、ESM、Node ≥ 18；不写测试代码，用 `node --check` + scratchpad 一次性探测脚本（跑完删除）；看板只做语法检查和代码审阅。
- 面向用户 / worker 的文字：演示卡→演播卡、演示需求→演播需求、开始演示→开始演播、停止演示→停止演播、演示中→演播中（预演时显示「预演中」）。内部名不改：命令 `ateam demo ...`、`kind: 'demo'`、`job.demo`、事件名 `demo_*`、目录 `docs/demo/`。脚本里的固定段名「## 演示步骤」不改（已有脚本在用）。
- 运行类型字段：`run.mode = 'rehearsal' | 'show'`；卡字段 `task.rehearsedAt`（数字时间戳或缺省）、`task.mayChange`（布尔）。
- worker 可写段：`## 操作记录`；旧脚本的 `## 经验` 同样视为可写段。
- 每完成一个任务，把本计划对应 `- [ ]` 改成 `- [x]` 和代码一起提交。

## Review Focus

1. 老数据：已有演示卡没有 `rehearsedAt`、runs 没有 `mode`——应显示「未预演」，只能预演；老 run 在历史里按「演播」显示。（Task 1 探测。）
2. 未预演的卡被 API 直接 `start mode=show`：必须拒绝。（Task 1 探测。）
3. 预演中途停下：不设 `rehearsedAt`，但收尾照常提交已走通部分。（Task 1 探测。）
4. approve 一张普通卡后，所有已预演演播卡 `mayChange = true`；之后重新预演跑完清除。（Task 1 探测。）
5. `demo save` 允许只改「## 操作记录」或旧「## 经验」段，改「## 演示步骤」仍拒绝。（Task 2 探测。）

---

### Task 1: store

**Files:** Modify `src/store.js`

**Interfaces（Produces）:**
- `startDemo(taskId, mode = 'show')`：`mode` 只能是 `rehearsal` / `show`，否则 `INVALID`；`show` 且 `!task.rehearsedAt` 时 `BAD_STATE`「演播卡 T? 还没预演过，请先开始预演」。记 `task.pendingMode = mode`，`claimDemo` 时写入 `run.mode`。
- `demoBlockers(taskId)` 不变（模式检查在 `startDemo`）。
- `demoStep(agentId, n, total, text, cue, slow = false)`：`slow` 为真时 `task.demoStep.slow = true`，并把 `n` 记进当前 run 的 `slowSteps`（去重数组）。
- `demoEnd(agentId, result, stuck = false)`：`stuck` 为真时 run `outcome = 'interrupted'`、`task.mayChange = true`；否则 `outcome = 'done'`，且 run 为 `rehearsal` 时 `task.rehearsedAt = now()`、`task.mayChange = false`。两者都进入 wrapping。收尾指令的 outcome 照此传出（interrupted 也不清理）。
- `approve`：普通卡通过后，所有 `kind === 'demo'` 且有 `rehearsedAt` 的卡设 `mayChange = true`（已为 true 不重复写）。
- 所有面向人的文案按 Global Constraints 改名。

- [x] **Step 1:** 实现上述改动；`closeRun` 的 label 改为「预演/演播 跑完 / 被叫停 / 中断」按 run.mode 区分。
- [x] **Step 2:** scratchpad 探测（`createStore` 驱动）：未预演 `startDemo(id,'show')` 抛错；预演跑完后 `rehearsedAt` 有值、`mayChange` false；approve 普通卡后 `mayChange` true；演播 `demoStep(..., true)` 后 run.slowSteps 含该步；`demoEnd(..., true)` → outcome interrupted、mayChange true；预演叫停后 `rehearsedAt` 不变；老卡（删掉 rehearsedAt）只能预演。
  Run: `node --check src/store.js && node <scratchpad>/probe-rehearsal-store.mjs` → `ALL PASS`，删除脚本。
- [x] **Step 3: Commit** `store: rehearsal vs show runs, rehearsedAt/mayChange, slow steps, stuck end`

### Task 2: 脚本解析与 server

**Files:** Modify `src/demo.js`、`src/server.js`

**Interfaces:**
- `demo.js`：`withoutExperience` 改名 `withoutOps(markdown)`——去掉标题为「操作记录」或「经验」的段；新增 `opsSection(markdown): string`——返回该段正文（不含标题），没有则空串。
- 路由：`POST /api/demo/start` 透传 `mode`；`POST /api/demo/step` 透传 `slow`；`POST /api/demo/end` 透传 `stuck`；新增 `GET /api/demo/ops?id=T?` → `{ ops: string }`（读脚本文件，读不到返回空串和 `error`）。`demo/save` 用 `withoutOps`，报错文案改为「只能改脚本的『## 操作记录』段」。
- wait 结果的 `script` 增加 `mode`（当前 run 的 mode）和 `hasOps`（操作记录段非空）。

- [x] **Step 1:** 实现。
- [x] **Step 2:** scratchpad 探测（临时 git 仓库 + 真服务）：只改「## 操作记录」能 save；只改旧「## 经验」也能；改「## 演示步骤」被拒；`/api/demo/ops` 返回段内容；未预演 start show 返回错误；预演 start → wait 拿到 `script.mode === 'rehearsal'`。
  Run: `node --check src/demo.js src/server.js && node <scratchpad>/probe-rehearsal-server.mjs <scratchpad>` → `ALL PASS`，删除脚本和临时目录。
- [x] **Step 3: Commit** `server: rehearsal/show start, slow/stuck flags, ops section endpoint`

### Task 3: 命令行与 worker 指令

**Files:** Modify `bin/ateam.js`、`src/format.js`

- `ateam demo step --as <编号> 3/12 "<说明>" [--slow]`、`ateam demo end --as <编号> "<结果>" [--stuck]`（`slow`、`stuck` 加入 `BOOLEAN_FLAGS`）。USAGE、所有输出文案改名。
- `formatDemoWait` 按 `script.mode` 分两套规则：
  - **预演**（标题 `# 预演 T?：…`）：慢慢走，每步截图确认；每步走通后在「## 操作记录」段写一条（格式照 spec 5.2：怎么找到元素、做什么、等到什么；造数据 / 跳转 / 提交表单的步骤标【核对】并写「核对：」）；中途走不通也先把已走通的写下来再 `demo end --stuck`；跑完 `demo end`。
  - **演播**（标题 `# 演播 T?：…`）：先通读「## 操作记录」；按记录逐条直接操作，**不截图**，只在【核对】步截图对照；某步找不到元素或核对不符 → 这一步切慢档走通，`demo step` 带 `--slow`，记下新做法；慢档也走不通 → 停在当前页面 `demo end --stuck "<卡在第几步、为什么>"`；操作记录为空时按预演方式做并提醒。
  - 收尾 `# 演播收尾`/`# 预演收尾`：预演跑完写全操作记录；预演中断写已走通部分；演播只更新走了慢档的步骤，没有就 `--no-changes`；interrupted / stopped 不清理。
  - 叫停标题 `# 演播已叫停` / `# 预演已叫停`。
- `demoLine` / `formatDemoTask`：显示「未预演 / 已预演 / 页面可能有变动」，runs 显示类型和慢档步骤。

- [ ] **Step 1:** 实现。
- [ ] **Step 2:** scratchpad 探测：rehearsal / show 两种 wait 输出标题和关键句（「不截图」「--slow」「--stuck」「## 操作记录」）；`formatStatus` 里演播需求显示「[演播]」；未预演卡显示「未预演」。
  Run: `node --check bin/ateam.js src/format.js && node <scratchpad>/probe-rehearsal-format.mjs` → `ALL PASS`，删除。
- [ ] **Step 3: Commit** `cli: rehearsal and fast show instructions, --slow/--stuck, renamed to 演播`

### Task 4: 看板

**Files:** Modify `src/dashboard.html`

- 全部文案改名（演示→演播；进行中按 run.mode 显示「预演中 / 演播中」）。
- 演播卡行：标记 lozenge「未预演」/「已预演」/「页面可能有变动」；按钮：未预演只有「开始预演」（primary）；已预演有「开始演播」（primary）和「重新预演」（普通）；`mayChange` 时演播按钮 title 和行内提示「页面可能有变动，建议先重新预演」。两个按钮都调 `/api/demo/start` 带 `mode`，都受 `demoBlockers` 约束。
- 提词区：`demoStep.slow` 时在小字行加「慢档」tag。
- 抽屉：新增「操作记录」区，打开抽屉时 `GET /api/demo/ops?id=` 取一次，`renderMarkdown` 渲染（缓存到下次 state 变化）；运行记录表加「类型」列，演播行在说明后附「慢档：第 x、y 步」。
- 横幅：「预演中 / 演播中：<标题>」。

- [ ] **Step 1:** 实现。
- [ ] **Step 2:** 语法检查 `node -e "...new Function(...)"` → `syntax ok`；代码审阅普通需求页面不受影响。
- [ ] **Step 3: Commit** `dashboard: 演播卡 — rehearse/show buttons, rehearsal flags, ops record panel, slow-step marks`

### Task 5: skill 与核对清单

**Files:** Modify `skills/ateam-lead/SKILL.md`、`skills/ateam-worker/SKILL.md`、`docs/manual-checklist.md`

- leader：章节改名「演播卡」；脚本模板「## 经验」换成「## 操作记录」（留空，worker 写）；建卡后告诉用户先点「开始预演」，预演跑完再演播；新代码通过后卡会提示可能有变动；事件说明改名。
- worker：主循环表改为 `# 预演` / `# 演播` / `# 预演已叫停` / `# 演播已叫停` / `# 预演收尾` / `# 演播收尾`；test 条目改名。
- 核对清单「演示卡」一节改名，并补：未预演只能预演；预演写出逐步操作记录；演播不逐步截图、明显更快；改坏一步时慢档走通并更新记录；新代码通过后出现「页面可能有变动」。
- [ ] **Step 1:** 实现。
- [ ] **Step 2: Commit** `skills: 演播卡 rehearsal flow; checklist`
