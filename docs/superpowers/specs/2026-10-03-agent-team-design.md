# agent-team 设计文档

日期：2026-10-03
状态：待用户审阅

## 1. 目标

让一个「主管 agent」（Claude Code）带领若干「工人 agent」（WorkBuddy + DeepSeek V4.1 Flash）在同一台电脑、同一个项目目录里协作开发。

- 用户只和主管对话：提需求 → 主管拆任务 → 派给工人 → 工人完成后回报 → 主管 review（不通过则打回）→ 全部通过后主管向用户汇报 → 用户测试验收。
- 工人是用户手动打开的常驻 WorkBuddy 窗口。工人随时可能因 token 用完而中途消失，用户换账号开新窗口后，新工人要能接着干，由主管负责重新安排。
- 用户通过网页看板全局查看：做了哪些工作、完成情况、review 情况。

**成功标准**

1. 一主两工（前端 + 后端）能跑完一个需求的完整闭环：拆分 → 并行开发 → 提交 → review（含至少一次打回）→ 汇报。
2. 工人中途掉线后，新开的工人能接手同一任务，并在已有改动的基础上继续，不从头做起。
3. 看板能看清每个需求、每个任务的状态，以及完整的 review 历史。

**不做的事（YAGNI）**

- 不负责启动或管理 agent 进程。工人窗口由用户手动打开。
- 看板只读，不在网页上派任务或审批。
- 不做账号和鉴权：服务只监听 127.0.0.1。
- 不做多项目：一个项目起一个服务。
- 第一版不做每任务独立 worktree：大家在同一目录工作，靠路径划分隔离（见 §6）。

## 2. 组成部分

```
用户 ──对话──▶ Claude Code（主管，加载 ateam-lead skill）
                   │  ateam 命令行
                   ▼
            ┌──────────────────────────┐
            │  ateam 服务 (Node, 零依赖) │ ◀── 浏览器看板（只读）
            │  状态：<项目>/.ateam/state.json │
            └──────────────────────────┘
                   ▲  ateam 命令行
       ┌───────────┴───────────┐
 WorkBuddy #1（frontend）  WorkBuddy #2（backend）
 （加载 ateam-worker skill）
```

| 组成 | 职责 |
|---|---|
| `ateam serve` | 在项目根目录启动服务。HTTP + 长轮询，默认端口 7700；托管看板页面；状态持久化到 `.ateam/state.json` |
| `ateam` 命令行 | 主管和工人与服务交互的**唯一**方式。输出是给大模型读的 markdown 文本 |
| `ateam-worker` skill | 教工人：加入 → 等任务 → 干活 → 写进度 → 提交 → 再等 |
| `ateam-lead` skill | 教主管：建需求 → 拆任务 → 监听事件 → review → 回答提问 → 写汇报 |
| 看板 | 单个 HTML 文件 + 原生 JS，每 3 秒拉取一次 `/api/state` |

### 2.1 代码结构

```
agent-team/
  package.json            # "bin": { "ateam": "bin/ateam.js" }，无依赖
  bin/ateam.js            # 命令行入口：解析参数，调用 HTTP 接口，输出文本
  src/store.js            # 纯逻辑：状态机、派发、租约、事件；时钟可注入；不碰网络
  src/persist.js          # 读写 state.json（先写临时文件再 rename）
  src/server.js           # HTTP 路由、长轮询挂起和唤醒、租约定时扫描、托管看板
  src/format.js           # 把任务、事件渲染成给 LLM 读的 markdown 文本
  src/git.js              # 服务端在项目根执行 git add / commit，拿到提交号
  src/dashboard.html      # 看板
  skills/ateam-lead/SKILL.md
  skills/ateam-worker/SKILL.md
```

`store.js` 不依赖网络和真实时间，这样可以在临时脚本里直接驱动它，模拟完整流程。

## 3. 数据模型

所有状态保存在一个 JSON 对象里，每次变更后整体落盘。

```js
{
  seq: { job: 2, task: 7, event: 31 },
  jobs: [{
    id: "J1", title, description,
    status: "planning" | "active" | "awaiting_acceptance",
    report: null | "markdown",
    createdAt, updatedAt
  }],
  tasks: [{
    id: "T3", jobId: "J1", title,
    role: "frontend",              // 自由字符串，与工人 join 时的角色匹配
    paths: ["web/"],               // 允许改动的路径；submit 只提交这些路径
    description: "markdown",       // 含接口约定
    acceptance: ["...", "..."],    // 验收标准
    dependsOn: ["T1"],             // 依赖的任务全部 approved 后才可领取
    status: "pending" | "working" | "asking" | "submitted" | "approved" | "held",
    assignee: null | "fe-7f3a",
    handoff: false,                // true = 上一任工人掉线，此任务等待接手
    rejectCount: 0,
    commits: ["a1b2c3d", ...],     // 历次提交
    pendingDelivery: null | { kind: "rejected" | "answer", text },  // 待送达给 assignee 的消息
    history: [{ ts, type, actor, text, commit? }]
  }],
  agents: [{
    id: "fe-7f3a", role: "frontend",
    status: "online" | "offline",
    currentTask: null | "T3",
    joinedAt, lastSeenAt
  }],
  events: [{ id, ts, type, taskId?, agentId?, text, delivered: false }]
}
```

`history.type` 的取值：`created` `claimed` `progress` `asked` `answered` `submitted` `approved` `rejected` `handoff` `held` `released` `edited`。看板上的任务时间线直接渲染 `history`。

## 4. 任务生命周期

```
              依赖全部 approved
  pending ────────────────────▶ working ──submit──▶ submitted ──approve──▶ approved
    ▲                            │  ▲                 │
    │ 租约过期（handoff=true）    │  │ 答复送达         │ reject
    └────────────────────────────┘  │                 ▼
                     ask ▼          │        原工人在线 → working（带打回意见）
                       asking ──answer        原工人掉线 → pending（handoff=true）
                                              第 3 次打回 → held（等主管处理）
```

需求状态：没有任务时为 `planning`，有任务时为 `active`，主管提交汇报后为 `awaiting_acceptance`。只有该需求下所有任务都 `approved`，才能提交汇报。

### 4.1 派发规则（工人调用 `wait` 时）

按优先级：

1. 有分配给我、并且带有 `pendingDelivery` 的任务（打回意见或提问答复）→ 送达，清空 `pendingDelivery`，状态为 `working`。
2. 已经分配给我、状态为 `working` 的任务（比如工人重复调用了 `wait`）→ 重新返回这个任务的完整内容。
3. 我的角色下、`pending`、依赖都已满足的任务：先给 `handoff=true` 的，再按编号从小到大 → 领取，`assignee=我`，状态为 `working`。如果该任务带有 `pendingDelivery`（上一任没收到的打回意见或答复），一并送达后清空。
4. 都没有 → 挂起，直到有可派发的任务或超时（默认 90 秒，可用 `--timeout` 改；见 §10.1）。超时返回「暂无任务，请立即再次调用 ateam wait」。

一个工人同一时间只持有一个任务。工人处于 `asking` 时调用 `wait`，会一直挂起，直到答复送达。

### 4.2 租约与掉线

- 工人每次调用 `ateam ... --as ID` 都会刷新 `lastSeenAt`。`wait` 挂起期间，连接存在也视为在线。
- **不用后台进程发心跳**：token 用完时窗口停了，后台进程还会继续报活，那样就检测不到掉线。
- 服务每 30 秒扫描一次：`lastSeenAt` 超过租约时长（默认 15 分钟，可用 `--lease` 或 `ATEAM_LEASE_MIN` 改），并且没有挂起中的 `wait` 连接 → 工人标记为 `offline`。
  - 如果它持有任务：任务转为 `pending`，`handoff=true`，`assignee=null`，`pendingDelivery` 保留（接手的工人会收到），写一条 `handoff` 历史，并发出 `worker_offline` 事件。
- 掉线的工人再调用任何命令：返回「你的租约已失效，任务已被收回。请重新运行 ateam join」。
- 接手的工人领到 `handoff` 任务时，输出里会有醒目的「接手任务」提示，并附上完整历史，要求它先看 `git log` 和 `git status` 了解现状。

### 4.3 打回上限

`reject` 时 `rejectCount` 加 1。达到 3 次时，任务转为 `held`，不再自动派发，并发出 `task_held` 事件。主管可以选择：

- `ateam task edit T3 ...`：改写描述或验收标准，然后 `ateam release T3` 重新放回 `pending`，`rejectCount` 清零。
- 主管自己改代码后直接 `ateam approve T3`。

## 5. 命令行

通用约定：

- 服务地址取自 `ATEAM_URL`，默认 `http://127.0.0.1:7700`。
- 输出是 markdown 文本。出错时以 `错误：` 开头，并且写明下一步该做什么。
- 退出码：成功为 0；业务错误为 1；服务不可达为 2（会先自动重试约 60 秒）。

### 5.1 服务

| 命令 | 说明 |
|---|---|
| `ateam serve [--port 7700] [--lease 15]` | 在当前目录（项目根）启动服务，状态写到 `./.ateam/`，并自动把 `.ateam/` 加进 `.gitignore` |

### 5.2 工人

| 命令 | 说明 |
|---|---|
| `ateam join --role <role>` | 返回工人编号，比如 `fe-7f3a`，前缀取角色的前两个字母 |
| `ateam wait --as ID [--timeout 90]` | 按 §4.1 返回内容 |
| `ateam progress --as ID "<笔记>"` | 写进度笔记，同时刷新心跳 |
| `ateam ask --as ID "<问题>"` | 任务转为 `asking`，发出 `question` 事件 |
| `ateam submit --as ID "<总结>" [--no-changes]` | 见下文 |

**`submit` 的行为**：由**服务**在项目根目录（`serve` 启动时的目录）执行

```
git add -A -- <paths...>
git commit -m "[T3] <总结>" -- <paths...>
```

带路径的 `git commit` 只提交这些路径，即使别的工人在暂存区里放了东西，也不会被一起提交。提交完成后，把提交号记到任务上，任务转为 `submitted`，发出 `submitted` 事件。

- 指定路径下没有任何改动时报错。如果确实不需要改代码（比如只是回答问题后确认无需改动），可以加 `--no-changes`。
- 服务单进程按顺序处理请求，两个工人的提交自然排队，不会互相冲突。如果主管恰好也在执行 git 命令导致 `index.lock` 冲突，服务会短暂等待后重试，最多 3 次。
- 由服务来提交，而不是让工人自己敲 git 命令：一是**强制**路径隔离，二是工人的工作目录不一定是项目根目录，三是减少模型出错。

### 5.3 主管

| 命令 | 说明 |
|---|---|
| `ateam job new "<标题>" [--desc-file f.md]` | 新建需求，返回 `J1` |
| `ateam task add --job J1 --role backend --paths server/ [--after T1,T2] --title "..." --desc-file t.md --accept "..." --accept "..."` | 添加任务，返回 `T3` |
| `ateam task edit T3 [--desc-file ...] [--accept ...] [--paths ...]` | 修改任务，只允许在 `pending` 或 `held` 状态下修改 |
| `ateam release T3` | 把 `held` 的任务放回 `pending` |
| `ateam watch [--timeout 90]` | 挂起，直到有未送达的事件，然后一次性返回全部并标记为已送达 |
| `ateam watch --follow` | 一直运行，每个事件输出一行，用于 Claude Code 的 Monitor 后台监听 |
| `ateam approve T3 ["<备注>"]` | 通过 |
| `ateam reject T3 "<修改意见>"` | 打回（规则见 §4、§4.3） |
| `ateam answer T3 "<答复>"` | 回答提问。答复存入 `pendingDelivery`；`asking` 的任务转为 `working`。如果提问者已掉线（任务为 `pending` 且 `handoff=true`），答复同样存入 `pendingDelivery`，交给接手的工人 |
| `ateam status [--job J1]` | 全局概况：工人在线情况、各任务状态，以及置顶的「待你处理」列表（`submitted`、`asking`、`held` 的任务） |
| `ateam show T3` | 任务详情、完整历史、提交列表 |
| `ateam report --job J1 --file report.md` | 提交汇报，需求转为 `awaiting_acceptance` |

事件类型：`worker_joined` `worker_offline` `claimed`（包括接手）`question` `submitted` `task_held`。

**事件不是唯一的事实来源**：`watch` 返回事件后就把它们标记为已送达。如果主管会话因为上下文满了而重开，可以用 `ateam status` 里的「待你处理」列表恢复，所以不会漏掉任何需要处理的事。

## 6. 代码隔离

- 所有 agent 在同一个项目目录下工作。主管拆任务时，保证同时进行的任务 `paths` 互不重叠，典型做法是前端 `web/`、后端 `server/`。
- `submit` 只提交任务 `paths` 内的改动（§5.2），所以每个提交都只属于一个任务，主管用 `git show <sha>` review 时看到的就是这个任务的改动。
- 越界改动（工人改了 `paths` 以外的文件）不会被提交，会留在工作区。主管 review 时用 `git status` 能发现。skill 里明令禁止越界。
- 以后如果需要更强的隔离，可以给任务加一个 `workdir` 字段，指向独立的 worktree，协议不用变。

## 7. Skills

### 7.1 ateam-worker（给 WorkBuddy）

要点：

1. 运行 `ateam join --role <用户告诉你的角色>`，记住编号，之后每条命令都带 `--as`。
2. 主循环：`ateam wait` → 根据返回内容行动 → 回到 `wait`。**永远不要主动结束**。收到「暂无任务」时立即再次调用。
3. 拿到任务：读描述、验收标准和接口约定；只改 `paths` 内的文件；每完成一小步就 `ateam progress`，比如每改完一个文件。
4. 拿到「接手任务」：先读历史笔记和打回意见，再看 `git log --oneline -5` 和 `git status`，确认现状后再继续。
5. 拿到打回意见：逐条修改，然后再次 `submit`。
6. 不确定的地方用 `ateam ask` 提问，然后 `wait` 等答复。不要猜。
7. 完成后 `ateam submit "<做了什么、怎么验证的>"`。不要自己执行 git commit。
8. 收到「租约已失效」：重新 `join`。
9. 服务不可达（退出码 2）：告诉用户，然后停下。

### 7.2 ateam-lead（给 Claude Code）

要点：

1. **开工**：确认服务在运行（`ateam status`），确认工人在线情况。用 Monitor 启动 `ateam watch --follow` 进行后台监听。
2. **拆任务**：
   - 先定接口约定（接口路径、请求和响应格式），写进相关任务的描述。
   - 每个任务都要写明 `role`、`paths`（同时进行的任务不能重叠）、可以逐条核对的验收标准，以及必要的依赖。
   - 粒度控制在一个工人一次能做完。
3. **review**：`ateam show T3` → `git show <sha>` → 逐条核对验收标准 → 跑项目已有的测试 → 用 `git status` 检查有没有越界的残留改动 → `approve` 或 `reject`。打回意见要具体到文件和问题。
4. **事件处理**：`question` → `answer`；`worker_offline` → 在 `ateam status` 里确认任务已退回，需要时提醒用户开新窗口；`task_held` → 改写任务或自己修。
5. **收尾**：所有任务通过后，写汇报（做了什么、每个任务 review 了几轮、已知问题、请用户重点测试的地方），然后 `ateam report`，并在对话里告诉用户。
6. **会话重开**：先运行 `ateam status`，按「待你处理」列表继续。

### 7.3 安装

- 在本项目目录运行 `npm link`，之后全局都能用 `ateam` 命令。
- 把 `skills/ateam-lead/` 复制或软链到 `~/.claude/skills/`。
- 把 `skills/ateam-worker/` 复制或软链到 `~/.workbuddy/skills/ateam-worker/`（WorkBuddy 用户级 skill 目录，格式与 Claude Code 相同：`SKILL.md` = YAML frontmatter（`name`、`description`）+ Markdown 正文）。

## 8. 看板

`GET /` 返回 `dashboard.html`，页面每 3 秒拉取一次 `GET /api/state`（完整状态快照）。

- **工人栏**：编号、角色、在线或掉线（掉线显示为灰色）、当前任务、上次心跳是多久前。
- **需求列表**：标题、状态、进度条（已通过数 / 总数）、review 统计（review 总次数、一次通过率、打回次数）。
- **任务看板**（选中某个需求后）：按 待领取 / 进行中 / 返工中（`working` 且 `rejectCount>0`）/ 等待答复 / 待 review / 已通过 / 已挂起 分列。卡片上显示角色、处理人、打回次数，接手过的任务带「接手」标记。
- **任务详情**（点开卡片）：描述、验收标准、依赖、提交列表，以及按时间排列的 `history`（进度、提问答复、交付、review 结论和意见、交接）。
- **汇报**：需求进入 `awaiting_acceptance` 后，在需求页顶部渲染汇报内容（简单的 markdown 渲染：标题、列表、代码块）。

## 9. 出错处理

| 情况 | 处理 |
|---|---|
| 服务重启 | 启动时读取 `state.json`。所有工人的 `lastSeenAt` 不变，租约照常计算；挂起的 `wait` 连接断开后，命令行会自动重试并重新挂起 |
| 写盘中途崩溃 | 先写 `state.json.tmp` 再 rename，保证落盘是原子操作 |
| 服务不可达 | 命令行重试约 60 秒，之后退出码为 2，并输出「服务不可达，请通知用户」 |
| 操作不合法 | 比如提交不属于自己的任务、对 `pending` 任务执行 approve。返回明确的错误，并说明当前状态和正确做法 |
| 项目目录不是 git 仓库 | `serve` 报错退出，提示先运行 `git init`（`submit` 依赖 git） |
| 端口被占用 | `serve` 报错退出，提示用 `--port` 换端口，并设置 `ATEAM_URL` |
| 两个工人同时提交 | 服务按顺序执行 git，自然排队（§5.2） |
| 并发请求 | 单进程按顺序处理，不存在重复派发 |
| 主管会话重开 | `ateam status` 的「待你处理」列表 + 未送达的事件 |

## 10. 已确认事项（WorkBuddy 环境）

### 10.1 命令超时

WorkBuddy 的 bash 工具：前台命令默认超时 120 秒（`BASH_DEFAULT_TIMEOUT_MS`）；显式传 timeout 最多可到 600 秒（`BASH_MAX_TIMEOUT_MS`）。超时后，命令会被自动转为后台任务，工人拿不到输出；或者在不支持后台时被 SIGTERM 杀掉（退出码 137）。

因此 `wait` 和 `watch` 的默认挂起时间定为 **90 秒**，保证不依赖模型每次都正确传 timeout 参数，也能稳定拿到结果。命令行内部的「服务不可达重试」只在连不上服务时触发，不会和挂起时间叠加。

### 10.2 Skill 目录与格式

用户级目录为 `~/.workbuddy/skills/<name>/SKILL.md`；另有项目级目录 `<workspace>/.workbuddy/skills/`。frontmatter 里 `name`、`description` 必填。`agent_created: true` 只有模型自己创建的 skill 才需要，用户手动安装的不需要。

### 10.3 Shell 执行

WorkBuddy 有 bash 工具，可以直接运行 `ateam` 命令，不需要包一层 MCP。工人的工作目录不一定是项目根目录，git 操作统一由服务执行（§5.2）。

## 11. 测试与验证

遵循用户的全局约定：**不新写测试代码**。

- **代码审阅**：顺着调用链推演状态机的每一条转移路径。
- **一次性模拟**：在临时目录里写脚本，直接驱动 `store.js`（注入时钟），再加上一个真实服务进程配合 `ateam` 命令行，模拟一主两工：派任务 → 领取 → 提交 → 打回 → 再提交 → 通过；工人掉线 → 接手；提问 → 答复；连续 3 次打回 → held。跑完删除，不进仓库。
- **手工核对清单**（交给用户）：真实的 WorkBuddy 窗口加入、等任务、提交；关掉一个窗口，模拟 token 用完，换新窗口接手；看板上各个视图显示正确；最终汇报显示正确。
