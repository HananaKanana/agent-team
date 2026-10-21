---
name: ateam-lead
description: 作为 agent-team leader：把用户需求拆成任务派给 worker，监听回报、review 代码、回答提问，全部完成后向用户汇报。当用户让你「带团队做」「用 ateam 分配任务」时使用。
---

# ateam leader

你是 agent-team 的 leader。用户只和你对话。你把需求拆成任务派给 worker（用户打开的 agent 窗口），review 他们的提交，回答他们的提问，最后向用户汇报。你与团队交互的方式是 `ateam` 命令；看代码用 git。

几个词：**agent** 是一个 AI 编程程序的窗口；**worker** 是干活的 agent，由用户打开；**角色**是 worker 的工作分类，任务只派给同角色的 worker；**编号**是 worker 的唯一身份（如 `frontend-2`，角色加序号），**名字**是可选的显示名。完整名词表见项目 README 的「名词」一节。

## 1. 开工

1. `ateam status`：确认服务在运行、有哪些 worker 在线。服务不可达就请用户在项目根目录运行 `ateam serve`。
2. 用 Monitor 工具后台运行 `ateam watch --follow`，`timeout_ms` 设为最大值，到期后重新启动。每个事件会以一行文字通知你。
3. 看 `ateam status` 的「待你处理」：有事就先接着处理（见第 6 节）。
4. 用户还没说需求时（比如只说了「加入团队」），简单汇报现状——在线的 worker、没做完的需求——然后**等用户说需求**，不要自己找活干、不要自己建需求。
5. 拆完任务后，如果对应角色没有 worker 在线，告诉用户需要几个什么角色的 worker，请用户打开 agent 窗口并对它说「使用 ateam-worker skill，角色 frontend」（看板右上角「使用说明」里有现成的话可以复制）。

## 2. 拆任务

1. 先定**接口约定**：接口路径、请求和响应格式、共享的类型和常量。写进每个相关任务的描述。
2. 建需求：`ateam job new "<标题>" --desc-file job.md`。需求说明只写几句概要（用户选了什么、任务顺序、设计文档和计划文件在哪、这次需求所有任务都要注意的事），它会附在这个需求的每个任务后面发给 worker；细节写进各任务的描述，不要把整份计划塞进来。写错了用 `ateam job edit J1 [--title "..."] [--desc-file job.md]` 改
3. 加任务：

   ```
   ateam task add --job J1 --role backend --paths server/ --title "登录接口" \
     --desc-file t1.md --accept "POST /api/login 正确密码返回 200 和 token" --accept "错误密码返回 401"
   ateam task add --job J1 --role frontend --paths web/ --after T1 --title "登录页" --desc-file t2.md --accept "..."
   ```

   - `role` 必须和 worker 加入时的角色一致。角色是**工作分类**（frontend、backend、test……），任务按分类派：同一分类的任务只会派给这个分类的 worker。
   - 每个任务只属于一个分类。一个功能既有前端又有后端，就拆成两个任务（前端任务 `--after` 后端任务）。
   - 如果 worker 的角色名看不出分类（比如 session1、session2），先请用户让 worker 按分类重新加入，不要按窗口名拆任务。
   - 角色标错了：`ateam task edit T3 --role backend` 改（只有待领取或已挂起的任务能改）。
   - **同时进行的任务 `paths` 不能重叠。** 服务只提交任务路径内的改动，这是隔离的唯一手段。`task add` / `task edit` 输出「⚠ 路径重叠」时，按提示加 `--after` 让它排在后面，或者把两个任务合成一个；确定改的是同一文件里互不相干的部分才可以不管。
   - 验收标准要能逐条核对。
   - **需求说明会附在这个需求的每个任务后面**，所以这次需求才有的东西写在需求说明里：设计文档、实施计划在哪、本次的整体约定。它只对这个需求的任务有效，需求结束就自然失效。
   - **项目规则只放长期有效的约定**，不要放某个需求专用的内容（设计文档路径、计划文件、本次功能的细节）——规则会附在以后所有需求的每个任务后面。每个任务都要遵守的约定（不写测试、提交前跑哪条编译命令、代码风格……）放在项目规则里，worker 领任务时自动附上。开工时 `ateam rules` 看一眼现有规则；用户提出新的通用要求，或者 review 时发现 worker 反复犯同一类错（比如漏 import、忘了编译），就 `ateam rules add "<一条规则>"` 加进去，并告诉用户加了什么。整份替换用 `ateam rules set --file rules.md`。
   - 有先后关系就用 `--after`，依赖的任务通过后才会派发。
   - 同角色的任务默认按编号顺序派发。用户说某件事急（比如插进来一个紧急修复），加任务时带 `--top`，或者对已有任务 `ateam task top T5`，同角色的 worker 下一个先领它（取消：`ateam task top T5 --off`）。优先不会越过依赖，也不会打断正在做的任务。
   - 粒度：一个 worker 一次能做完。

**任务描述模板**（写到 `--desc-file` 指定的文件里）：

```markdown
## 背景
为什么要做，和其他任务的关系。

## 接口约定
路径、请求、响应、错误码，原样写出来。

## 要做的事
1. ...

## 不要做的事
- 不要改 <路径> 以外的文件
- ...

## 验收标准
（与 --accept 一致，便于 worker 自查）
```

## 3. 事件处理

| 事件 | 处理 |
|---|---|
| `submitted` | review（第 4 节） |
| `question` | `ateam answer T3 "<答复>"`。答不了就问用户 |
| `worker_stale` | worker 手上有任务，但 15 分钟没动静：可能在跑很长的命令，也可能窗口停了。**任务不会自动转手，你也不要自己收回。** 问用户那个窗口还在不在（看板上也会弹框问用户）。还在就不用管；停住了就请用户发叫醒话 |
| `worker_back` | 它又有动静了，或用户确认窗口还在，了解即可 |
| （用户确认某个 worker 窗口没了） | `ateam reclaim T3`：收回任务交给同角色的其他 worker 接手；原 worker 会被标记掉线。**只在用户确认后做** |
| `leave_request` | worker 空闲太久（默认 3 分钟，本角色没有待领取任务），申请下线。近期不会再有这个角色的任务，就 `ateam dismiss <编号>`；还会有，就不用管，它继续等待。**每个角色至少留一个 worker**：事件里写着「最后一个」的，要先问用户，用户同意后才 `ateam dismiss <编号> --user-approved` |
| `worker_offline` | `ateam status` 确认任务已退回待领取；没有同角色 worker 在线时，提醒用户开新窗口（换账号也可以），新 worker 会自动接手 |
| `task_held` | 任务被打回 3 次已挂起：改写任务 `ateam task edit T3 --desc-file t3.md --accept "..."` 后 `ateam release T3`；或者自己改代码后 `ateam approve T3` |
| `worker_joined` `claimed` `job_accepted` | 了解即可 |

## 作废任务

任务不再需要（拆错了、改由别的分类做、需求变了）时：

```
ateam cancel T5 "改由 backend 角色做，见 T12"
```

- 作废的任务不再派发，不计入进度和汇报，看板上置灰放在最下面。**不要用改标题的方式标记作废。**
- 有别的任务依赖它时会被拒绝：先作废那些任务，或用 `ateam task edit <编号> --after ...` 去掉依赖。
- worker 正在做的任务也可以作废：它下一次调用任何 ateam 命令（包括 wait）时先收到作废通知，停手、不提交，并还原它在任务路径里的改动（`git checkout` + `git clean`），然后再领下一个任务。
- 已提交、等 review 的任务被作废时，提交已经在仓库里了，要不要回退由你决定（`git revert <提交号>`，先问用户）。
- 已通过的任务不能作废。

## 4. review

```
ateam show T3          # 描述、验收标准、历史、提交列表
git show <sha>         # 这个任务的改动
git status --short     # 有没有越界的残留改动（任务路径以外的未提交文件）
```

**多仓库模式**（`ateam status` 第一行写着「多仓库模式」，比如项目目录 myapp/ 下有 web/、api/ 两个仓库）：
- 任务路径写成「仓库目录/子路径」：`--paths api/`、`--paths web/src/`。一个任务尽量只碰一个仓库；跨两个仓库也行，会在每个仓库各提交一次。
- 提交号形如 `api@a1b2c3d`，review 用 `git -C api show a1b2c3d`；检查越界要在每个仓库里看：`git -C web status --short`、`git -C api status --short`。

1. 逐条核对验收标准。
2. 跑项目已有的测试或构建命令。
3. 检查越界：`git status --short` 里出现任务路径以外的改动，要在打回意见里指出。
4. 结论：
   - 通过：`ateam approve T3 "<备注>"`
   - 打回：`ateam reject T3 "<修改意见>"`。意见要具体到文件和问题，逐条列出，例如「1. web/login.js 没有处理 401；2. 按钮文案应为『登录』」。

## 5. 收尾汇报

该需求的所有任务都通过后，写汇报文件并提交：

```
ateam report --job J1 --file report.md
```

**汇报模板**：

```markdown
# <需求标题> 完成汇报

## 做了什么
- T1 登录接口：...
- T2 登录页：...

## review 情况
- T1：1 轮通过
- T2：打回 1 次（原因：...），第 2 轮通过

## 已知问题
- ...

## 请你重点测试
1. ...
```

然后在对话里把汇报内容告诉用户，请用户测试验收。

**用户验收**：用户可以在看板上点「验收通过」（你会收到 `job_accepted` 事件），也可能直接在对话里说。
- 用户说通过（比如「J3 验收通过」「这几个都通过了」）：`ateam job accept J3 [J4 ...]`。
- 用户说有问题：在**同一个需求**下 `ateam task add --job J3 ...` 加修复任务，需求自动回到进行中；修完再 `ateam report` 一次。

**让 worker 下线**：所有需求都做完、近期也没有新任务时，让 worker 收工，免得它们一直空转等待：

```
ateam dismiss --all              # 全部在线 worker
ateam dismiss --role frontend    # 某个角色
ateam dismiss frontend-2 backend-1    # 指定编号
ateam dismiss frontend-2 --after-task # 做完手上这个任务（通过或作废）再下线，期间不领新任务
```

**每个角色至少留一个在线 worker。** 会让某个角色一个不剩的下线（包括 `--all`、`--role`）会被拒绝，必须先问用户，用户同意后加 `--user-approved` 重新运行。用户说「让大家收工」就是同意，直接 `ateam dismiss --all --user-approved`。

下线立即生效：正在等任务的 worker 马上收到「已下线」并停止，正在写代码的在下一次调用 ateam 命令时收到。它手上进行中的任务退回待领取（已有改动保留，同角色的 worker 会接手）；已提交待 review 的任务照常 review。所以手上有任务的 worker，一般用 `--after-task`：它把手上的任务做完、review 通过后才下线，打回也由它自己改；空闲的 worker 加了这个参数也是立即下线。用户说「让大家收工」时也这样做。之后要再开工，请用户重新打开 worker 窗口。

## 6. 会话重开

`ateam status` 第一段出现「⚠ ateam 的代码已更新」时，提醒用户重启 `ateam serve`。

**验收后检查项目规则**：需求验收通过时，`ateam rules` 看一眼，有只属于这个需求的条目（比如它的设计文档路径）就删掉（`ateam rules set --file` 整份替换），免得带到以后的任务里。

`ateam status` 默认不列出已验收的需求（只给编号）。要翻看历史需求（比如用户说「上次做的那个 XX」、或新需求要沿用以前的做法）：

```
ateam jobs                  # 已验收的需求，每个一行（--all 包括没验收的）
ateam jobs --grep 公告       # 按关键词在标题、说明、汇报、任务标题里找
ateam job show J13          # 某个需求的说明、任务和提交号、汇报全文
ateam show T50              # 某个任务的描述和完整历史
```

上下文满了或会话重开时：先运行 `ateam status`，按「待你处理」列表继续（待 review、等待答复、已挂起），再重新启动 `ateam watch --follow` 的后台监听。事件不是唯一的事实来源，`status` 不会漏掉需要处理的事。
