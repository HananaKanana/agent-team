# agent-team Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做一个本地任务协调服务 `ateam`（服务 + 命令行 + 看板 + 两份 skill），让 Claude Code 主管带 WorkBuddy 工人协作开发，支持掉线接手和 review 闭环。

**Architecture:** `src/store.js` 是纯逻辑状态机（时钟可注入，不碰网络和磁盘）；`src/server.js` 用 Node 内置 `http` 把它暴露成 JSON 接口，负责长轮询、租约扫描、落盘和 git 提交；`bin/ateam.js` 是唯一的客户端，把 JSON 渲染成给大模型读的 markdown；看板是一个静态 HTML 文件，轮询 `/api/state`。

**Tech Stack:** Node ≥ 18（本机 v25），ESM，零依赖；git CLI。

**Spec:** `docs/superpowers/specs/2026-10-03-agent-team-design.md`

## Global Constraints

- 零依赖。`package.json` 里 `"type": "module"`，`"engines": { "node": ">=18" }`，`"bin": { "ateam": "bin/ateam.js" }`。
- 服务只监听 `127.0.0.1`，默认端口 `7700`。命令行从 `ATEAM_URL` 读取地址，默认 `http://127.0.0.1:7700`。
- 租约默认 15 分钟（`--lease <分钟>` 或 `ATEAM_LEASE_MIN`，允许小数）。扫描间隔为 `min(30 秒, 租约/3)`。
- `wait` 和 `watch` 默认挂起 **90 秒**。
- 打回达到 **3 次** → 任务转为 `held`。
- 看板每 **3 秒**刷新一次。
- 命令行连不上服务时重试约 60 秒（每 2 秒一次），然后输出 `错误：服务不可达，请通知用户。` 并以退出码 2 退出；业务错误退出码为 1。
- 所有错误输出以 `错误：` 开头，并写明下一步该做什么。
- ID 格式：需求 `J1`、任务 `T1`（自增）；工人 `<角色前两个字母小写>-<4位十六进制>`，例如 `fe-7f3a`。
- 提交信息格式：`[T3] <总结>`。
- 状态文件：`<项目根>/.ateam/state.json`，先写 `state.json.tmp` 再 rename。
- **不写测试代码**（用户全局约定）。每个任务的验证方式：`node --check` 检查语法，加上在临时目录（scratchpad）里写的一次性探测脚本，跑完删除，不进仓库。仓库根的 `node --test` 照常运行（目前没有测试文件）。

## Review Focus

以下情况设计文档没有专门写，但最容易在实际使用中出问题。没有测试网，所以由 Task 8 的端到端模拟逐条覆盖，并在代码审阅时重点看：

1. **任务路径在首次提交时还不存在，或者部分路径不存在**（比如 `paths: ["web/", "shared/types.ts"]` 而 `shared/` 没建）→ `git add` 报 pathspec 不匹配时，应该跳过不存在的路径，用存在的路径正常提交，而不是整个提交失败。
2. **同一个工人有两个挂起的 `wait`**（命令行重试或模型重复调用）→ 新连接替换旧连接，旧连接立即返回「暂无任务」，同一个任务不能送达两次。
3. **工人的 `wait` 连接被客户端断开**（WorkBuddy 窗口关闭、进程被杀）→ 服务在连接 `close` 时移除这个挂起，否则会被一直当作在线，永远不掉线。
4. **主管 `approve` 了一个被别人依赖的任务**，而依赖它的工人正挂在 `wait` 上 → 挂起的工人必须立即被唤醒并领到任务，不能等到 90 秒超时。
5. **服务重启时有工人正挂在 `wait` 上**（连接被重置）→ 命令行把 `ECONNRESET` 和 `ECONNREFUSED` 一样当作可重试错误，服务回来后自动重新挂起。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `package.json` | 包信息、bin、engines |
| `src/errors.js` | `AteamError` |
| `src/store.js` | 状态机：需求、任务、工人、事件；派发、租约、review |
| `src/persist.js` | `loadState` / `saveState` |
| `src/git.js` | `ensureGitRepo`、`ensureGitignore`、`commitPaths` |
| `src/server.js` | HTTP 路由、长轮询、租约定时扫描、落盘、托管看板 |
| `src/format.js` | JSON 渲染成 markdown 文本 |
| `bin/ateam.js` | 命令行：参数解析、HTTP 调用、重试、退出码 |
| `src/dashboard.html` | 看板 |
| `skills/ateam-worker/SKILL.md` | 工人 skill |
| `skills/ateam-lead/SKILL.md` | 主管 skill |
| `README.md` | 安装与使用 |

---

### Task 1: 脚手架 + 状态机（需求、任务、工人、事件）

**Files:**
- Create: `package.json`, `.gitignore`（内容：`node_modules/`、`.ateam/`）, `src/errors.js`, `src/store.js`

**Interfaces:**
- Produces:
  - `class AteamError extends Error { constructor(code: string, message: string) }`。`code` 取值：`NOT_FOUND` `BAD_STATE` `LEASE_LOST` `NOT_YOURS` `INVALID`。`message` 是给模型看的中文句子，包含下一步该怎么做。
  - `createStore({ state?: object, now?: () => number, leaseMs?: number, onChange?: () => void }) → Store`
    - `state` 缺省时为空状态：`{ seq: {job:0, task:0, event:0}, jobs: [], tasks: [], agents: [], events: [] }`，字段与 spec §3 一致。
    - 每次修改状态后同步调用一次 `onChange()`。
  - `Store` 在本任务实现的方法：
    - `store.state`：原始状态对象，供序列化和 `/api/state` 使用
    - `createJob({ title, description = '' }) → job`
    - `addTask({ jobId, title, role, paths: string[], description = '', acceptance: string[] = [], dependsOn: string[] = [] }) → task`。校验：需求存在；`dependsOn` 里的任务都存在；`paths` 非空。需求状态从 `planning` 变为 `active`。写一条 `created` 历史。
    - `editTask(taskId, patch: { title?, description?, acceptance?, paths?, dependsOn? }) → task`：只允许 `pending` 或 `held` 状态；写一条 `edited` 历史。
    - `join(role) → agent`：生成 ID，状态为 `online`，发出 `worker_joined` 事件。
    - `touch(agentId) → agent`：刷新 `lastSeenAt`。工人不存在或已 `offline` 时抛 `LEASE_LOST`，提示「你的租约已失效，任务已被收回。请重新运行 ateam join --role <role>」。
    - `getTask(id) → task`（找不到抛 `NOT_FOUND`）、`getJob(id) → job`
    - `pendingActions() → task[]`：状态为 `submitted`、`asking`、`held` 的任务
    - `takeEvents() → event[]`：返回 `delivered:false` 的事件，并标记为 `true`
    - 内部辅助（不导出）：`addHistory(task, type, actor, text, commit?)`、`emit(type, fields)`

- [x] **Step 1: 写 `package.json`、`.gitignore`、`src/errors.js`**

- [x] **Step 2: 在 `src/store.js` 实现以上方法**

  工人 ID 用 `crypto.randomBytes(2).toString('hex')`，冲突时重新生成。所有时间戳都取自 `now()`。

- [x] **Step 3: 一次性探测**

  在 scratchpad 里写 `probe1.mjs`：从仓库导入 `createStore`；建需求 → 加两个任务（T2 依赖 T1）→ `join('frontend')` 得到形如 `fr-xxxx` 的 ID → `editTask` 改 T1 描述 → `takeEvents()` 返回 1 条 `worker_joined`，再调一次返回空数组 → `addTask` 用不存在的依赖时抛 `NOT_FOUND`。运行：`node probe1.mjs`，全部 `console.assert` 无输出即通过。删除 probe。

- [x] **Step 4: 提交**

```bash
git add package.json .gitignore src/errors.js src/store.js
git commit -m "feat: store skeleton (jobs, tasks, agents, events)"
```

---

### Task 2: 状态机——派发、租约、提问、提交、review

**Files:**
- Modify: `src/store.js`

**Interfaces:**
- Consumes: Task 1 的 `createStore`、`AteamError`
- Produces（`Store` 的新方法）:
  - `nextFor(agentId) → { kind: 'task'|'handoff'|'resume'|'rejected'|'answer', task, delivery?: {kind, text} } | null`：先 `touch`，再按 spec §4.1 的四条优先级处理。
    - 规则 1：任务分配给我且有 `pendingDelivery` → kind 取 `pendingDelivery.kind`（`rejected` 或 `answer`），送达后清空。
    - 规则 2：已分配给我且状态为 `working` → `resume`。
    - 规则 3：领取新任务 → `handoff=true` 时 kind 为 `handoff`（同时带上残留的 `pendingDelivery` 放在 `delivery` 里，然后清空），否则为 `task`。领取时 `handoff` 置回 `false`，写 `claimed` 历史，发出 `claimed` 事件（事件 text 注明是否接手）。
    - 工人处于 `asking` 或没有可派发任务时 → 返回 `null`。
  - `progress(agentId, text)`：任务必须属于我且状态为 `working`；写 `progress` 历史。
  - `ask(agentId, text)`：`working` → `asking`；写 `asked` 历史；发出 `question` 事件。
  - `taskForSubmit(agentId) → task`：校验任务属于我且状态为 `working`，供 server 在执行 git 之前调用。
  - `recordSubmit(agentId, summary, commit: string|null) → task`：再校验一次；`commit` 不为空时追加到 `commits`；状态变为 `submitted`；写 `submitted` 历史；发出 `submitted` 事件。
  - `approve(taskId, note = '')`：只允许 `submitted` 或 `held` 状态；变为 `approved`；工人的 `currentTask` 清空；写 `approved` 历史。
  - `reject(taskId, text)`：只允许 `submitted`；`rejectCount++`；写 `rejected` 历史。然后：
    - 若 `rejectCount >= 3` → 变为 `held`，工人的 `currentTask` 清空，发出 `task_held` 事件。
    - 否则若原工人在线 → 变为 `working`，`pendingDelivery = {kind:'rejected', text}`。
    - 否则 → 变为 `pending`，`handoff=true`，`assignee=null`，`pendingDelivery` 同上。
  - `answer(taskId, text)`：允许 `asking`（→ `working`），或 `pending && handoff`（状态不变）；`pendingDelivery = {kind:'answer', text}`；写 `answered` 历史。
  - `release(taskId)`：`held` → `pending`；`rejectCount = 0`；`assignee = null`；写 `released` 历史。
  - `report(jobId, markdown)`：该需求所有任务都必须是 `approved`，否则抛 `BAD_STATE`，并列出未通过的任务编号；需求状态变为 `awaiting_acceptance`。
  - `sweep(isWaiting: (agentId) => boolean) → number`：把超时且不在挂起中的在线工人标记为 `offline`。若其持有的任务状态为 `working` 或 `asking` → 变为 `pending`，`handoff=true`，`assignee=null`，写 `handoff` 历史。发出 `worker_offline` 事件，事件 text 注明被收回的任务编号。返回本次标记为掉线的工人数量。
  - 依赖判断：`dependsOn` 里的任务全部 `approved` 才可领取。

- [x] **Step 1: 实现以上方法**

  工人「持有的任务」以 `agent.currentTask` 为准，并与 `task.assignee` 保持双向一致：领取时双方都设置，任务通过、挂起、收回时双方都清空。

  补充两条规则：
  - 规则 3（领取新任务）只在 `agent.currentTask` 为空时才生效。所以交付后处于 `submitted` 的工人会一直挂起等待 review 结果，返工自然会派回给他本人。
  - `sweep` 把工人标记为掉线时，总是清空 `agent.currentTask`。对于 `submitted` 状态的任务，`assignee` 保持不变；如果之后被打回，就按「原工人已掉线」的分支处理，进入 handoff。

- [x] **Step 2: 一次性探测**

  在 scratchpad 里写 `probe2.mjs`，用 `let t = 0; now = () => t` 注入时钟，`leaseMs = 1000`。依次验证：
  1. fe 领到 T1（`task`）
  2. 再调 `nextFor` 得到 `resume`
  3. `ask` 后 `nextFor` 返回 `null`
  4. `answer` 后 `nextFor` 得到 `answer`
  5. `recordSubmit` 后 `reject`，`nextFor` 得到 `rejected`
  6. 第 2、3 次打回后状态为 `held`；`release` 后为 `pending`，`rejectCount` 为 0
  7. `t += 2000; sweep(() => false)` 返回 1，任务状态为 `pending` 且 `handoff`；旧 ID 调 `nextFor` 抛 `LEASE_LOST`
  8. 新工人 `nextFor` 得到 `handoff`
  9. 依赖 T1 的 T2 在 T1 `approve` 之前不可领取，之后可以领取
  10. `report` 在还有未通过的任务时抛 `BAD_STATE`
  11. `sweep(() => true)` 不会让挂起中的工人掉线

  运行：`node probe2.mjs`，无断言失败即通过。删除 probe。

- [x] **Step 3: 提交**

```bash
git commit -am "feat: store dispatch, lease, review state machine"
```

---

### Task 3: 持久化与 git

**Files:**
- Create: `src/persist.js`, `src/git.js`

**Interfaces:**
- Produces:
  - `loadState(dir: string) → object | null`：读取 `<dir>/state.json`，文件不存在时返回 `null`。
  - `saveState(dir: string, state: object) → void`：同步写 `state.json.tmp`，然后 `renameSync` 成 `state.json`；目录不存在时先创建。
  - `ensureGitRepo(root) → Promise<void>`：`git rev-parse --show-toplevel` 失败时抛出 `Error('当前目录不是 git 仓库。请先运行 git init。')`。
  - `ensureGitignore(root) → void`：`.gitignore` 里没有 `.ateam/` 这一行时追加。
  - `commitPaths(root, paths: string[], message: string) → Promise<{ sha: string } | { nothing: true }>`：
    1. 逐个路径执行 `git add -A -- <p>`；报 pathspec 不匹配时跳过这个路径（Review Focus #1）。
    2. 用 `git diff --cached --quiet -- <有效路径...>` 判断有没有改动，退出码 0 表示没有 → 返回 `{nothing:true}`。
    3. `git commit -m <message> -- <有效路径...>`，然后 `git rev-parse --short HEAD`。
    4. 任何一步报 `index.lock` 时等 500 毫秒重试，最多 3 次。
  - 全部使用 `child_process.execFile`（不经过 shell），`cwd: root`。

- [x] **Step 1: 实现两个文件**

- [x] **Step 2: 一次性探测**

  在 scratchpad 里 `git init` 一个临时仓库，先做一次初始提交。然后验证：
  1. 新建 `web/a.js`，同时 `server/b.js` 已经 `git add`，调用 `commitPaths(root, ['web/', 'nope/'], '[T1] x')` → 返回 sha；`git show --stat HEAD` 只包含 `web/a.js`；`server/b.js` 仍在暂存区
  2. 再调一次返回 `{nothing:true}`
  3. `saveState` / `loadState` 能往返读写
  4. `ensureGitignore` 调用两次只追加一行

  删除 probe 和临时仓库。

- [x] **Step 3: 提交**

```bash
git add src/persist.js src/git.js
git commit -m "feat: state persistence and path-scoped git commit"
```

---

### Task 4: HTTP 服务

**Files:**
- Create: `src/server.js`

**Interfaces:**
- Consumes: `createStore`、`AteamError`、`loadState`/`saveState`、`ensureGitRepo`/`ensureGitignore`/`commitPaths`
- Produces: `startServer({ root: string, port = 7700, leaseMin = 15 }) → Promise<http.Server>`
  - 启动时：`ensureGitRepo(root)` → `ensureGitignore(root)` → `loadState(root/.ateam)` → `createStore({ state, leaseMs, onChange })`，其中 `onChange` 负责 `saveState` 并唤醒挂起的请求。
  - 端口被占用（`EADDRINUSE`）时，reject 一个 `Error('端口 7700 被占用。请用 --port 换一个端口，并设置 ATEAM_URL=http://127.0.0.1:<端口>')`。

**接口定义**：请求和响应都是 JSON。成功返回 `{ ok: true, ... }`；`AteamError` 返回 HTTP 400，内容为 `{ ok: false, code, message }`；其他异常返回 500，内容为 `{ ok:false, code:'INTERNAL', message }`。

| 方法 路径 | 请求体 | 响应 |
|---|---|---|
| `POST /api/join` | `{role}` | `{agent}` |
| `POST /api/wait` | `{as, timeout?}` | `{result}`（即 `nextFor` 的结果）或 `{result:null}` |
| `POST /api/progress` | `{as, text}` | `{task}` |
| `POST /api/ask` | `{as, text}` | `{task}` |
| `POST /api/submit` | `{as, summary, noChanges?}` | `{task, commit}` |
| `POST /api/jobs` | `{title, description?}` | `{job}` |
| `POST /api/tasks` | `{jobId, title, role, paths, description?, acceptance?, dependsOn?}` | `{task}` |
| `POST /api/tasks/edit` | `{id, ...patch}` | `{task}` |
| `POST /api/approve` / `reject` / `answer` / `release` | `{id, text?}` | `{task}` |
| `POST /api/report` | `{jobId, report}` | `{job}` |
| `POST /api/watch` | `{timeout?}` | `{events}` |
| `GET /api/state` | — | `{state, pending: task[]}` |
| `GET /api/task?id=T3` | — | `{task}` |
| `GET /` | — | `src/dashboard.html` |

**长轮询**：
- `waiters: Map<agentId, {res, timer}>`。`/api/wait` 先立即调用 `nextFor`，结果不为空就直接返回；否则挂起。
  - 同一个工人已经有挂起时，旧的立即以 `{result:null}` 返回（Review Focus #2）。
  - 在 `res.on('close')` 时移除挂起（Review Focus #3）。
  - 超时（`timeout` 秒，默认 90，上限 110）后，先 `touch`，再返回 `{result:null}`。
- `watchers: Set<{res, timer}>`。`/api/watch` 有未送达的事件就立即返回；否则挂起，超时后返回 `{events:[]}`。
- `onChange` 时：先 `saveState`；然后对每个挂起的工人尝试 `nextFor`，不为空就返回（Review Focus #4）；最后如果有未送达的事件，就用 `takeEvents()` 的结果返回给**所有**挂起的 watcher。注意：唤醒过程本身也会触发 `onChange`，要用一个重入标记避免递归。
- `submit` 流程：`taskForSubmit` → 若 `noChanges` 则 `commit=null`；否则 `commitPaths(root, task.paths, '[T3] '+summary)`，结果为 `nothing` 时抛 `INVALID`，提示「指定路径下没有改动；如确实无需改代码，请加 --no-changes」→ `recordSubmit`。
- 定时扫描：`setInterval(() => store.sweep(id => waiters.has(id)), min(30000, leaseMs/3))`，并 `unref()`。

- [x] **Step 1: 实现 `src/server.js`**

  路由用一个 `{ 'POST /api/join': handler, ... }` 对象分发。请求体最大 1MB，JSON 解析失败返回 `INVALID`。

- [x] **Step 2: 一次性探测**

  在 scratchpad 里写 `probe4.mjs`：在临时 git 仓库上 `startServer({ root, port: 7799, leaseMin: 0.05 })`，用 `fetch` 验证：
  1. 两个工人加入；fe 挂起 `wait`；主管建需求和任务后，fe 的 `wait` 在 1 秒内返回任务（不必等超时）
  2. 主管 `watch` 能收到 `claimed`
  3. 写文件后 `submit` 返回 sha
  4. 同一个工人并发两个 `wait`，第一个立即得到 `null`
  5. 用 `AbortController` 中止一个 `wait` 后，等待超过租约时长，该工人变为 `offline`
  6. 重启服务（关掉再 `startServer`）后 `/api/state` 内容一致

  删除 probe。

- [x] **Step 3: 提交**

```bash
git add src/server.js
git commit -m "feat: http server with long-poll wait/watch and lease sweep"
```

---

### Task 5: 命令行与输出格式

**Files:**
- Create: `src/format.js`, `bin/ateam.js`（首行 `#!/usr/bin/env node`，并 `chmod +x`）

**Interfaces:**
- Consumes: `startServer`（`ateam serve` 使用）；Task 4 的 HTTP 接口
- Produces（`format.js`）:
  - `formatWait(result, agentId) → string`
  - `formatTask(task) → string`
  - `formatEvents(events) → string`
  - `formatEventLine(event) → string`（单行，供 `--follow` 使用）
  - `formatStatus(state, pending, jobId?) → string`
  - `formatError(code, message) → string`

**命令**：与 spec §5 完全一致。参数解析规则：
- 第一个参数是子命令；`task add`、`task edit`、`job new` 是两段式子命令。
- `--flag value` 形式；`--accept` 可以重复出现，结果收集成数组；`--paths` 和 `--after` 按逗号拆分。
- 布尔开关：`--follow`、`--no-changes`。
- `--desc-file` 和 `--file` 相对于当前工作目录读取。
- 剩下的第一个位置参数作为 text、summary 或 title。

**`formatWait` 的输出**（工人 skill 依赖这些标题，必须一字不差）：

- `null` → `暂无任务。请立即再次运行：ateam wait --as <ID>`
- `task` → `# 新任务 <ID>：<标题>`，后接 `formatTask` 正文
- `resume` → `# 继续任务 <ID>：<标题>`，后接正文
- `handoff` → `# ⚠ 接手任务 <ID>：<标题>`，然后一段说明「上一位工人中途掉线。先阅读下方历史，再运行 git log --oneline -5 和 git status 了解现状，在已有改动基础上继续，不要从头做起。」，后接正文（含完整历史）。如果带有 `delivery`，再附一节「未送达的消息」。
- `rejected` → `# 打回 <ID>（第 n 次）`，后接修改意见原文和任务正文
- `answer` → `# 答复 <ID>`，后接答复原文
- 每种有任务的输出最后都加两行：`进度：ateam progress --as <ID> "..."`、`完成：ateam submit --as <ID> "<做了什么、怎么验证的>"`

**`formatTask` 正文**包含：角色、允许改动的路径、依赖、验收标准（编号列表）、描述、提交列表、历史（每条一行：`时间 [类型] 执行者：内容`）。

**网络重试**：`fetch` 抛出且 `cause.code` 属于 `ECONNREFUSED`、`ECONNRESET`、`UND_ERR_SOCKET` 时，每 2 秒重试一次，累计约 60 秒（Review Focus #5）。超过后输出 `错误：服务不可达，请通知用户。`，退出码 2。

**`watch --follow`**：循环调用 `/api/watch`，每个事件输出一行 `formatEventLine`，永不退出；服务不可达时同样按 2 处理。

**`serve`**：`startServer({ root: process.cwd(), port: --port ?? 7700, leaseMin: --lease ?? ATEAM_LEASE_MIN ?? 15 })`，启动后输出 `ateam 服务已启动：http://127.0.0.1:<port>（看板同地址）`。

- [x] **Step 1: 实现 `src/format.js`**
- [x] **Step 2: 实现 `bin/ateam.js`**
- [x] **Step 3: 一次性探测**

  在临时 git 仓库里后台运行 `node <repo>/bin/ateam.js serve --port 7798 --lease 0.05`，设置 `ATEAM_URL=http://127.0.0.1:7798`，然后用命令行依次执行：
  - `join` → `job new` → `task add`（带两个 `--accept`）→ `wait`（输出以 `# 新任务` 开头）→ `progress` → `submit` 但没有改动（输出以 `错误：` 开头，退出码 1）→ 写文件后再 `submit` → `status`（「待你处理」列表里有该任务）→ `reject` → `wait`（输出以 `# 打回` 开头）
  - 停掉服务后执行 `ateam status`，大约 60 秒后退出码为 2

  这一步可以把重试时长临时调短来加快探测，但探测完要恢复成 60 秒。删除临时文件。

- [x] **Step 4: 提交**

```bash
git add src/format.js bin/ateam.js
git commit -m "feat: ateam CLI and LLM-oriented output formatting"
```

---

### Task 6: 看板

**Files:**
- Create: `src/dashboard.html`

**Interfaces:**
- Consumes: `GET /api/state` → `{state, pending}`

页面内容（spec §8）：
- **工人栏**：在线工人正常显示，掉线工人显示为灰色；「上次心跳 N 分钟前」。
- **需求列表**：进度条（`approved` 数 / 总数）；review 统计：
  - review 次数 = 所有任务的 `approved` 和 `rejected` 历史条数之和
  - 一次通过率 = `rejectCount === 0` 的已通过任务数 / 已通过任务数
  - 打回次数 = `rejected` 历史条数
- **任务看板**，选中需求后显示，分 7 列：待领取 / 进行中 / 返工中（`working && rejectCount>0`）/ 等待答复 / 待 review / 已通过 / 已挂起。卡片显示：编号、标题、角色、处理人、打回次数；有过 `handoff` 历史的任务带「接手」标记。
- **任务详情**：点击卡片打开抽屉，显示描述、验收标准、依赖、提交列表、`history` 时间线。
- **汇报**：需求状态为 `awaiting_acceptance` 时，在需求视图顶部渲染汇报。只需一个约 30 行的极简 markdown 渲染：支持 `#`、`##`、`###`、`-`、`1.`、代码块、行内代码、粗体，**先转义 HTML 再渲染**。

技术约束：
- 原生 JS，不引入任何外部资源。
- 每 3 秒 `fetch` 一次；刷新后保留当前选中的需求和打开的抽屉。
- 颜色定义为 `:root` 变量，用 `prefers-color-scheme: dark` 适配深色模式。
- 窄屏时任务看板改为纵向堆叠。
- 用户写的文本一律用 `textContent` 插入，或者转义后再插入，防止注入。

- [x] **Step 1: 实现 `src/dashboard.html`**
- [x] **Step 2: 一次性探测**

  启动服务，用 Task 5 的命令行造一些数据：1 个需求、3 个任务，分别处于已通过、返工中、待领取（handoff）；再提交一份汇报（另建一个全部通过的需求）。然后：
  - `curl -s localhost:<port>/ | head` 确认返回了 HTML
  - `node -e` 读取 HTML 中的 `<script>`，用 `new Function` 做语法检查

  **不做浏览器验证**（用户全局约定）。看板的视觉效果列入 Task 8 的手工核对清单。删除临时数据。

- [x] **Step 3: 提交**

```bash
git add src/dashboard.html
git commit -m "feat: read-only dashboard"
```

---

### Task 7: Skills 与 README

**Files:**
- Create: `skills/ateam-worker/SKILL.md`, `skills/ateam-lead/SKILL.md`, `README.md`

**Interfaces:**
- Consumes: Task 5 的命令名称和 `formatWait` 的标题文本（skill 按这些标题识别情况）。

**`ateam-worker/SKILL.md`**
- frontmatter：
  - `name: ateam-worker`
  - `description: 作为 agent-team 的工人加入团队、领取并完成开发任务。当用户让你「加入 ateam」「作为前端/后端工人」「连接 agent-team 接任务」时使用。`
- 正文覆盖 spec §7.1 的 9 条，另加：
  - 「看到哪个标题就做什么」的对照表：`# 新任务`、`# 继续任务`、`# ⚠ 接手任务`、`# 打回`、`# 答复`、`暂无任务`、`错误：`
  - 所有 `ateam` 命令都直接前台运行，不要加后台参数，不要设置超时参数，因为命令自身会在 90 秒内返回（spec §10.1）
  - 不要自己执行 `git commit`
  - 角色由用户在开场时告知；没告知就先问用户

**`ateam-lead/SKILL.md`**
- frontmatter：
  - `name: ateam-lead`
  - `description: 作为 agent-team 主管：把用户需求拆成任务派给工人 agent，监听回报、review 代码、回答提问，全部完成后向用户汇报。当用户让你「带团队做」「用 ateam 分配任务」时使用。`
- 正文覆盖 spec §7.2 的 6 条，另加：
  - 用 Monitor 工具运行 `ateam watch --follow` 做后台监听（`timeout_ms` 设为最大值，到期后重新启动）
  - 写任务描述的模板：背景、接口约定、要做的事、不要做的事、验收标准
  - review 用的具体命令：`ateam show T3`、`git show <sha>`、`git status --short`
  - 汇报模板

**`README.md`**：说明它是什么；安装（`npm link`、两份 skill 的软链命令）；启动（`cd 项目 && ateam serve`）；开工流程（开几个 WorkBuddy 窗口，对它们说「使用 ateam-worker skill，角色 frontend」；对 Claude Code 说「使用 ateam-lead skill，需求是……」）；换号接手的操作；看板地址；环境变量 `ATEAM_URL`、`ATEAM_LEASE_MIN`。

- [x] **Step 1: 写两份 SKILL.md 和 README.md**
- [x] **Step 2: 核对**

  逐条检查 skill 里出现的每个命令和每个标题，都必须和 `bin/ateam.js`、`src/format.js` 的实际实现一致：`grep` 出 skill 中所有 `ateam ` 开头的命令，与命令行的子命令列表对比。

- [x] **Step 3: 提交**

```bash
git add skills README.md
git commit -m "docs: worker/lead skills and README"
```

---

### Task 8: 端到端模拟 + 手工核对清单

**Files:**
- Create: `docs/manual-checklist.md`
- 一次性脚本放在 scratchpad，不进仓库

- [ ] **Step 1: 端到端模拟**

  在 scratchpad 写 `e2e.sh`：新建临时 git 仓库，运行 `ateam serve --lease 0.1`；用 3 个 shell 角色（主管、fe、be）只通过 `ateam` 命令行完成以下流程：
  1. 建需求，加任务：T1 后端；T2 前端，依赖 T1。T2 的 `paths` 包含一个不存在的目录（Review Focus #1）
  2. be 领 T1、写文件、提交；主管打回；be 收到 `# 打回` 后修改再提交；主管通过
  3. fe 此前一直挂在 `wait` 上，应在 T1 通过后立刻领到 T2（Review Focus #4）
  4. fe 提问；主管回答；fe 收到 `# 答复`
  5. fe 停止调用命令，等待超过租约时长；`ateam status` 显示 T2 退回待领取；新工人 `join` 后 `wait` 得到 `# ⚠ 接手任务`
  6. 新工人提交；主管通过；`report` 成功
  7. 另建一个任务，连续打回 3 次后状态为 `held`
  8. 在 fe 挂起 `wait` 时重启服务，`wait` 自动重连，不报错（Review Focus #5）
  9. `git log --oneline` 里每个提交都以 `[T` 开头，且只包含对应任务的路径

  每一步用 `grep -q` 检查输出，失败就打印出来。跑通后删除脚本和临时仓库。

- [ ] **Step 2: 运行既有测试**

  Run: `node --test`
  Expected: 退出码 0（目前没有测试文件）

- [ ] **Step 3: 写 `docs/manual-checklist.md`**（交给用户）

  1. `npm link` 后，在任意目录能运行 `ateam`
  2. 两份 skill 已软链；WorkBuddy 能识别 `ateam-worker`，Claude Code 能识别 `ateam-lead`
  3. 在真实项目里运行 `ateam serve`，浏览器打开看板
  4. 开 2 个 WorkBuddy 窗口（前端、后端），它们加入后看板显示 2 个在线工人
  5. 对 Claude Code 提一个小需求，看到任务拆分、派发、并行开发
  6. 看板上能看到进度笔记实时增加、review 打回和通过、review 统计
  7. 关掉一个 WorkBuddy 窗口（模拟 token 用完），约 15 分钟后看板显示掉线、任务退回；开新窗口加入后，它接手并继续
  8. 收到 Claude Code 的最终汇报，看板上显示汇报内容
  9. 看板在深色模式和窄屏下显示正常

- [ ] **Step 4: 提交**

```bash
git add docs/manual-checklist.md
git commit -m "docs: manual verification checklist"
```
