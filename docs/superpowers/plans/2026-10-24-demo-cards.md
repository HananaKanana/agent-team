# 演示卡 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增「演示卡」：leader 写好仓库里的演示脚本，用户在看板上开始 / 叫停，test worker 在前台浏览器顺序演示，结束后把经验写回脚本文件并提交；演示期间全队冻结派发。

**Architecture:** 演示卡是任务的一种（`kind: 'demo'`），有自己的状态 `ready → queued → demoing → wrapping → ready`，全部逻辑在 `src/store.js`；脚本格式相关的纯函数放新文件 `src/demo.js`；server 负责读脚本文件、校验「经验段以外不能改」并提交；命令行加 `demo` 子命令；看板对演示需求显示演示卡列表。

**Tech Stack:** Node ≥ 18，ESM，零依赖；看板是单文件 `src/dashboard.html`。

**Spec:** `docs/superpowers/specs/2026-10-24-demo-cards-design.md`

## Global Constraints

- 零依赖、ESM、Node ≥ 18。
- **不写测试代码**（用户全局约定）。每个任务的验证：`node --check` 检查语法，加上在 scratchpad 里写的一次性探测脚本（直接 `import { createStore } from '<仓库>/src/store.js'` 驱动状态机），跑完删除，不进仓库。不起浏览器、不做 UI 验证；看板交给用户手工核对。
- 所有错误用 `AteamError(code, message)`，message 以中文写明下一步该做什么。
- 老状态文件兼容：没有 `kind` 的任务是普通任务，没有 `demo` 的需求是普通需求。
- 演示卡状态名固定：`ready` / `queued` / `demoing` / `wrapping`（另可 `cancelled`）。
- 演示数据前缀「演示-」；脚本四段标题固定：`## 准备`、`## 演示步骤`、`## 清理`、`## 经验`。
- 开始请求无人领取的超时：2 分钟。
- 提交信息：`[T12] 演示经验：<总结>`。
- 完成每个任务后把本计划对应的 `- [ ]` 改成 `- [x]`，和代码一起提交。

## Review Focus

1. **老数据和普通流程不受影响**：没有演示卡时，派发、review、汇报、统计行为与改动前完全一致。（Task 1 探测脚本最后一段跑一遍普通卡全流程。）
2. **冻结的边界**：只有 `queued`、或 `demoing` 且未叫停时冻结；叫停、跑完、超时撤回、worker 掉线后都必须立即解冻。（Task 1 探测覆盖这四种出口。）
3. **worker 改了经验段以外的内容**：`demo save` 必须拒绝，且文件保持未提交，提示只改「经验」段。（Task 2 探测。）
4. **演示卡混进统计**：需求进度、通过数、`ateam status`、`report`、审卡队列、路径重叠提醒都要排除演示卡。（Task 1、3、4 各自检查。）
5. **演示中 worker 用 `ask` / `submit` / `progress`**：都要报错并告诉它该用 `demo step` / `demo end`。（Task 1 探测。）

---

### Task 1: store 状态机

**Files:**
- Modify: `src/store.js`

**Interfaces:**
- Produces（导出在 store 返回对象里）：
  - `createJob({ title, description, origin, demo })`：`demo` 为真时 `job.demo = true`。
  - `addDemo({ jobId, title, script, role = 'test' }) → task`：只能加到演示需求里；`task.kind = 'demo'`、`task.script = script`、`task.paths = [script]`、`task.status = 'ready'`、`task.runs = []`。`addTask` 对演示需求报 `INVALID`。（脚本文件是否存在由 server 检查。）
  - `demoBlockers(taskId) → string[]`：开始演示的阻碍，空数组表示可以开始。按 spec 5.4 的三条，文案示例：`T130 进行中，完成后才能演示`、`T88 演示进行中`、`没有空闲的 test worker`。
  - `startDemo(taskId) → task`：有阻碍就抛 `BAD_STATE`（message 用阻碍文案拼接）；否则 `status = 'queued'`、`queuedAt = now()`，emit `demo_queued`。
  - `stopDemo(taskId) → task`：`queued` → 回 `ready`；`demoing` → `stopRequested = true`，当前 run 的 `outcome = 'stopped'`、`endedAt = now()`，emit `demo_stopped`；其他状态抛 `BAD_STATE`。
  - `demoFrozen() → task|null`：返回造成冻结的演示卡（`queued`，或 `demoing` 且没有 `stopRequested`）。
  - `demoStep(agentId, n, total, text) → { task, stopped: boolean }`：校验调用者手上是 `demoing` 的演示卡；已叫停就转 `wrapping` 并返回 `stopped: true`；否则写 `task.demoStep = { n, total, text, ts }`，不写 history（太多）。
  - `demoEnd(agentId, result) → task`：`demoing` → `wrapping`；当前 run `outcome = 'done'`、`result`、`endedAt`；emit `demo_ended`。
  - `demoTaskForSave(agentId) → task`：校验手上是 `wrapping` 的演示卡。
  - `recordDemoSave(agentId, summary, commit|null) → task`：→ `ready`；run 记 `saved`、`commit`；清掉 `demoStep`、`stopRequested`；释放 agent 的 `currentTask`；emit `demo_saved`；history 记一条 `demo_saved`。
  - `expireDemoRequests() → number`：`queued` 超过 2 分钟的回 `ready`，emit `demo_unclaimed`（文案：`没有 worker 来领演示 T12，请确认 test 窗口还在`）。
- run 记录格式（`task.runs` 的元素）：`{ startedAt, by, endedAt, outcome: 'done' | 'stopped' | 'interrupted', result, saved, commit }`。
- `nextFor` 新增返回：`{ kind: 'demo', task }`（领到或重复 wait 时）、`{ kind: 'demo_stopped', task }`（叫停后第一次 wait）、`{ kind: 'demo_wrap', task, outcome }`（wrapping 中 wait）。

- [x] **Step 1: 需求标记和建演示卡**：`createJob` 收 `demo`；新增 `addDemo`；`addTask` 遇到 `job.demo` 抛 `INVALID`（「演示需求里只能放演示卡，请用 ateam demo add」），`addDemo` 遇到普通需求同样报错。`editTask` 对演示卡只允许 `ready` 时改标题和角色。

- [x] **Step 2: 开始、叫停、冻结**：实现 `demoBlockers`、`startDemo`、`stopDemo`、`demoFrozen`、`expireDemoRequests`。`demoBlockers` 的第 1 条检查普通任务（非 demo）里 `working` / `asking` / `submitted` 的；第 3 条看同角色、在线、`currentTask` 为空、非 critic 的 worker（有 `assignTo` 时只看那一个）。

- [x] **Step 3: nextFor 接入**：
  - 手上是演示卡：`demoing` 且 `stopRequested` → 转 `wrapping`，返回 `demo_stopped`；`demoing` → `demo`；`wrapping` → `demo_wrap`（outcome 取最后一个 run）。
  - 领新任务前：有同角色、`queued`、（无 `assignTo` 或指派给自己）的演示卡 → 领走：`status = 'demoing'`、`assignee`、`agent.currentTask`、`runs.push({ startedAt: now(), by: agent.id })`、history `claimed`，emit `demo_started`，返回 `demo`。
  - `demoFrozen()` 非空时，普通候选一律不领，返回 null。critic 不受影响。
  - `waitingInfo` 在冻结时带上 `frozen: { taskId, title }`，供 Task 3 输出提示。

- [x] **Step 4: 演示中的 worker 命令**：实现 `demoStep`、`demoEnd`、`demoTaskForSave`、`recordDemoSave`。`workingTaskOf`（progress / ask / submit 共用）遇到手上是演示卡时抛 `BAD_STATE`：demoing 时「演示中不能提问或提交，遇到问题自己处理或跳过这一步；每步用 ateam demo step 报告，跑完用 ateam demo end」，wrapping 时「请按收尾说明清理、写经验后用 ateam demo save 提交」。演示卡的步骤报告也算心跳（调用 `touch`）。

- [x] **Step 5: 掉线和作废**：`sweep` 里演示卡不算 `active`（不打 stale 标记），租约到期直接判掉线：`demoing` → 当前 run `outcome = 'interrupted'`、卡回 `ready`；`wrapping` → 卡回 `ready`（run 的 `saved` 保持 false）；两种都清 `assignee`、`demoStep`、`stopRequested`，emit `demo_interrupted`。`reclaim` 对演示卡同样处理。`cancel` 演示卡：`demoing` / `queued` 时先等同叫停再作废。

- [x] **Step 6: 排除统计**：`overlapsFor`、`report`（演示需求直接报错「演示需求没有汇报」）、`acceptJobs`（跳过演示需求）、`pendingActions`、`critiquable`、`checkIdle` 的待办判断都排除 `kind === 'demo'` 或演示需求。

- [x] **Step 7: 探测验证**：在 scratchpad 写一次性脚本，用 `createStore({ now: () => clock })` 驱动：
  - 有一张普通卡 working 时 `demoBlockers` 非空；通过后可以开始。
  - `startDemo` 后普通 worker `nextFor` 返回 null 且 `waitingInfo(...).frozen` 存在；test worker 领到 `demo`。
  - 四种出口各跑一次后 `demoFrozen()` 为 null：跑完（`demoEnd`）、叫停（`stopDemo` 后 `demoStep` 返回 `stopped: true`）、超时（clock + 121 秒后 `expireDemoRequests()` 返回 1）、掉线（clock 超过租约后 `sweep(() => false)`）。
  - 演示中 `progress` / `ask` 抛 `BAD_STATE`。
  - `recordDemoSave` 后卡为 `ready`、`runs.length` 正确，可以再次 `startDemo`。
  - 最后不建演示卡跑一遍普通卡 add → nextFor → recordSubmit → approve，结果与改动前一致。
  Run: `node --check src/store.js && node <scratchpad>/probe-demo-store.mjs`
  Expected: 脚本打印全部断言通过；之后删除脚本。

- [x] **Step 8: Commit**

```bash
git add src/store.js docs/superpowers/plans/2026-10-24-demo-cards.md
git commit -m "store: demo cards — ready/queued/demoing/wrapping, dispatch freeze, stop, timeout, offline handling"
```

---

### Task 2: 脚本解析与 server 接口

**Files:**
- Create: `src/demo.js`
- Modify: `src/git.js`、`src/server.js`

**Interfaces:**
- Consumes: Task 1 的全部 store 函数。
- Produces:
  - `src/demo.js`：`export function withoutExperience(markdown: string): string` —— 去掉 `## 经验` 标题到下一个 `## ` 标题（或文末）之间的内容，返回其余部分，用于比较；`export function stepCount(markdown: string): number` —— `## 演示步骤` 段里以 `数字.` 开头的行数。
  - `src/git.js`：`export async function headContent(root: string, path: string): Promise<string | null>` —— 该文件在所属仓库 HEAD 里的内容（`git show HEAD:<相对仓库根的路径>`），没有则 null；多仓库按 `groupByRepo` 的方式找仓库。
  - 路由（body 均为 JSON）：
    - `POST /api/demo/add` `{ jobId, title, script, role? }` → `{ task }`；`script` 规范化成相对项目根的路径，文件不存在报 `INVALID`（「脚本文件 <路径> 不存在，请先写好并提交」）。
    - `POST /api/demo/start` `{ id }` → `{ task }`；`POST /api/demo/stop` `{ id }` → `{ task }`。
    - `POST /api/demo/step` `{ as, n, total, text }` → `{ task, stopped }`。
    - `POST /api/demo/end` `{ as, result }` → `{ task }`。
    - `POST /api/demo/save` `{ as, summary, noChanges? }` → `{ task, commit }`（走 `serial`）。
  - `POST /api/jobs` 透传 `demo`。
  - `GET /api/state` 增加 `demoBlockers: { [taskId]: string[] }`（只含 `ready` 的演示卡）。
  - wait 结果 `kind` 为 `demo` / `demo_wrap` 时附 `script: { path, text, steps }`（读文件；读不到时 `text` 为空并带 `error`）。

- [x] **Step 1: 写 `src/demo.js` 两个纯函数**。

- [x] **Step 2: `headContent`**（`src/git.js`）。

- [x] **Step 3: 路由**：按上面的接口加到 `routes`。`demo/save`：`noChanges` 时直接 `recordDemoSave(as, summary, null)`；否则读工作区文件和 `headContent`，`withoutExperience` 结果不同就抛 `INVALID`（「只能改脚本的『## 经验』段，其他段有改动。请把其他段恢复原样（git diff <路径> 查看）后再 demo save」）；相同就 `commitPaths(root, [script], \`[${task.id}] 演示经验：${summary}\`)`，`nothing` 时报错提示加 `--no-changes`。

- [x] **Step 4: 接入定时和推送**：租约扫描定时器里同时调用 `store.expireDemoRequests()`；`demo/stop` 后如果演示 worker 正挂在 wait 上，立即 `finishWaiter` 返回 `demo_stopped`（调用 `store.nextFor`）。`RULES_KINDS` 加上 `demo`、`demo_wrap`，让演示时也带项目规则；在 `withRules` 里附 `script`。

- [x] **Step 5: 探测验证**：scratchpad 里建一个临时 git 仓库，起 `ateam serve`（临时端口），用 `fetch` 走一遍：建演示需求 → 写脚本文件并提交 → `demo/add` → join test worker → `demo/start` → wait 拿到含 `script.text` 的结果 → `demo/step` → `demo/end` → 改「演示步骤」段后 `demo/save` 被拒、恢复后只改「经验」段 `demo/save` 成功并出现 `[T1] 演示经验：` 提交。
  Run: `node --check src/demo.js src/git.js src/server.js && node <scratchpad>/probe-demo-server.mjs`
  Expected: 全部断言通过；关服务、删临时目录和脚本。

- [x] **Step 6: Commit**

```bash
git add src/demo.js src/git.js src/server.js docs/superpowers/plans/2026-10-24-demo-cards.md
git commit -m "server: demo routes, script attached to wait, experience-only save check"
```

---

### Task 3: 命令行与输出

**Files:**
- Modify: `bin/ateam.js`、`src/format.js`

**Interfaces:**
- Consumes: Task 2 的路由和 wait 结果里的 `script`、`waiting.frozen`。
- Produces（命令）：
  - `ateam job new "<标题>" --demo`（`demo` 加进 `BOOLEAN_FLAGS`）
  - `ateam demo add --job J5 --title "..." --script docs/demo/x.md [--role test]`
  - `ateam demo step --as <编号> 3/12 "<这一步做什么>"`
  - `ateam demo end --as <编号> "<结果>"`
  - `ateam demo save --as <编号> "<经验总结>" [--no-changes]`
  - USAGE 里分别加到 worker / leader 两组。

- [x] **Step 1: 命令**：按上面加到 `commands`。`demo step` 的 `3/12` 解析成 `n`、`total`，格式不对报「格式是 3/12」。`demo step` 返回 `stopped: true` 时输出 `# 演示已叫停`（同 Step 2 的文案）并以 0 退出。

- [x] **Step 2: `formatWait` 新增三种输出**：
  - `# 演示 T12：<标题>`：脚本路径、脚本全文、演示规则（照 spec 5.6 逐条：先读准备和经验段；前台浏览器；不提问，出问题自己处理或跳过并记下；每步开始先 `ateam demo step --as <编号> <n>/<总数> "<说明>"`；停留时间照脚本；`{时间}` 替换成当前时间；造的数据用「演示-」前缀；全部跑完 `ateam demo end --as <编号> "<结果：哪些步顺利、哪些跳过及原因>"`）。
  - `# 演示已叫停 T12`：立刻停手、停在当前页面、不清理；接着按收尾第 2、3 步写经验并 `demo save`。
  - `# 演示收尾 T12`：outcome 为 done 时先执行「清理」段（只删「演示-」前缀且标了【清理】的数据）；然后把经验追加到「## 经验」段（只记怎么操作更稳、同类经验更新原条目、不改其他三段）；`ateam demo save --as <编号> "<记了哪些经验>"`，没有新经验加 `--no-changes`。
  - `waitingLines` 在 `waiting.frozen` 时加一行：`正在演示 <T12 标题>，演示结束后继续派发。`
- [x] **Step 3: `formatStatus` / `formatJob` / `formatJobs`**：演示需求标「[演示]」，不显示「已通过 x/y」，改为列出演示卡：`- T12 [待演示] 协议适配全流程（脚本 docs/demo/x.md，已演示 3 次，上次 10-24 15:02 跑完）`。状态中文：ready 待演示、queued 等待开始、demoing 演示中、wrapping 收尾中。`formatTask` 对演示卡显示脚本路径和最近 3 次演示记录。
- [x] **Step 4: 探测验证**：在 scratchpad 里 `import { formatWait, formatStatus } from '<仓库>/src/format.js'`，喂构造好的结果对象，确认三种标题和冻结提示出现、演示需求不出现「已通过」。
  Run: `node --check bin/ateam.js src/format.js && node <scratchpad>/probe-demo-format.mjs`
  Expected: 断言通过；删除脚本。
- [x] **Step 5: Commit**

```bash
git add bin/ateam.js src/format.js docs/superpowers/plans/2026-10-24-demo-cards.md
git commit -m "cli: demo commands and wait/status output for demo cards"
```

---

### Task 4: 看板

**Files:**
- Modify: `src/dashboard.html`

**Interfaces:**
- Consumes: `state.jobs[].demo`、`state.tasks[]` 的 `kind/script/runs/demoStep/stopRequested/queuedAt`、`GET /api/state` 的 `demoBlockers`、`POST /api/demo/start`、`POST /api/demo/stop`。

- [x] **Step 1: 需求列表**：演示需求在侧栏带「演示」小标签，不画进度条，显示「N 张演示卡」。所有统计（顶部进度、已通过、review 次数、一次通过率、需要你处理、待你验收）排除 `kind === 'demo'` 和演示需求。
- [x] **Step 2: 演示需求页**：不画七列看板，改为演示卡列表（沿用 `.card` 和抽屉样式）。每行：标题、脚本路径、状态 lozenge（待演示 / 等待开始 / 演示中 / 收尾中）、已演示次数、上次演示时间和结果；右侧按钮：ready 时「开始演示」（`demoBlockers[id]` 非空时置灰，`title` 写阻碍，多条用「；」连接），queued / demoing 时「停止演示」。演示中显示「第 3/12 步：新建装备」和演示时长（沿用 `.since` 每秒走的计时）。
- [x] **Step 3: 全局横幅**：有演示卡处于 queued 或 demoing（未叫停）时，看板顶部显示横幅「演示中：<标题>，派发已暂停」（queued 时为「等待 worker 开始演示：<标题>」），带「停止演示」按钮。沿用现有 banner 样式。
- [x] **Step 4: 演示卡抽屉**：详情项显示角色、处理人、脚本路径、演示次数；保留「指派给」选择器（ready 时可用）；主体是演示历史表：开始时间、演示者、结果（跑完 / 叫停 / 中断）、说明、是否已记经验及提交号，最新在上。
- [x] **Step 5: 自查**：抽出 `<script>` 用 `new Function` 做语法检查（同之前的做法），代码审阅一遍普通需求页面没有被演示分支影响。
  Run: `node -e "const s=require('fs').readFileSync('src/dashboard.html','utf8');new Function([...s.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n'));console.log('syntax ok')"`
  Expected: `syntax ok`
- [x] **Step 6: Commit**

```bash
git add src/dashboard.html docs/superpowers/plans/2026-10-24-demo-cards.md
git commit -m "dashboard: demo jobs — demo card list, start/stop, live step, freeze banner, run history"
```

---

### Task 5: skill 与手工核对清单

**Files:**
- Modify: `skills/ateam-lead/SKILL.md`、`skills/ateam-worker/SKILL.md`、`docs/manual-checklist.md`

- [x] **Step 1: ateam-lead**：新增「演示卡」一节，按 spec 5.10：先和用户定步骤、每步停留、每份数据保留还是清理；按 spec 5.2 的格式写 `docs/demo/<名字>.md` 并自己提交；`ateam job new --demo`、`ateam demo add`；用户要改演示内容时改前三段并提交，演示中、收尾中不要改；事件表加 `demo_queued` `demo_started` `demo_ended` `demo_stopped` `demo_saved` `demo_unclaimed` `demo_interrupted`，均为了解即可。命令列表加 `job new --demo`、`demo add`。
- [x] **Step 2: ateam-worker**：主循环表加 `# 演示`、`# 演示已叫停`、`# 演示收尾` 三行；第 3 节「按角色的做法」test 条目后补一句：领到演示卡时按 `# 演示` 里的规则做，演示中不提问、不提交，只用 `demo step` / `demo end` / `demo save`。
- [x] **Step 3: 手工核对清单**：在 `docs/manual-checklist.md` 末尾加「演示卡」一节，给用户或测试任务逐条核对：开始按钮置灰及提示、开始后普通 worker 领不到卡、看板当前步实时更新、叫停后 worker 停在当前页且横幅消失、跑完后清理和经验提交、经验段以外的改动被拒、再次演示读到了上次的经验、2 分钟无人领自动撤回。
- [x] **Step 4: Commit**

```bash
git add skills docs/manual-checklist.md docs/superpowers/plans/2026-10-24-demo-cards.md
git commit -m "skills: demo cards for leader and worker; manual checklist"
```
