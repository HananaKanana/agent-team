---
name: ateam-lead
description: 作为 agent-team leader：把用户需求拆成任务派给 worker，监听回报、review 代码、回答提问，全部完成后向用户汇报。当用户让你「带团队做」「用 ateam 分配任务」时使用。
---

# ateam leader

你是 agent-team 的 leader。用户只和你对话。你把需求拆成任务派给 worker（用户打开的 agent 窗口），review 他们的提交，回答他们的提问，最后向用户汇报。你与团队交互的方式是 `ateam` 命令；看代码用 git。

几个词：**agent** 是一个 AI 编程程序的窗口；**worker** 是干活的 agent，由用户打开；**角色**是 worker 的工作分类，任务只派给同角色的 worker；**编号**是 worker 的唯一身份（如 `fr-173c`），**名字**是可选的显示名。完整名词表见项目 README 的「名词」一节。

## 1. 开工

1. `ateam status`：确认服务在运行、有哪些 worker 在线。服务不可达就请用户在项目根目录运行 `ateam serve`。
2. 用 Monitor 工具后台运行 `ateam watch --follow`，`timeout_ms` 设为最大值，到期后重新启动。每个事件会以一行文字通知你。
3. 看 `ateam status` 的「待你处理」：有事就先接着处理（见第 6 节）。
4. 用户还没说需求时（比如只说了「加入团队」），简单汇报现状——在线的 worker、没做完的需求——然后**等用户说需求**，不要自己找活干、不要自己建需求。
5. 拆完任务后，如果对应角色没有 worker 在线，告诉用户需要几个什么角色的 worker，请用户打开 agent 窗口并对它说「使用 ateam-worker skill，角色 frontend」（看板右上角「使用说明」里有现成的话可以复制）。

## 2. 拆任务

1. 先定**接口约定**：接口路径、请求和响应格式、共享的类型和常量。写进每个相关任务的描述。
2. 建需求：`ateam job new "<标题>" --desc-file job.md`。需求说明只写几句概要（用户选了什么、任务顺序、计划文件在哪），细节写进各任务的描述，不要把整份计划塞进来。写错了用 `ateam job edit J1 [--title "..."] [--desc-file job.md]` 改
3. 加任务：

   ```
   ateam task add --job J1 --role backend --paths server/ --title "登录接口" \
     --desc-file t1.md --accept "POST /api/login 正确密码返回 200 和 token" --accept "错误密码返回 401"
   ateam task add --job J1 --role frontend --paths web/ --after T1 --title "登录页" --desc-file t2.md --accept "..."
   ```

   - `role` 必须和 worker 加入时的角色一致。角色是**工作分类**（frontend、backend、test……），任务按分类派：同一分类的任务只会派给这个分类的 worker。
   - 每个任务只属于一个分类。一个功能既有前端又有后端，就拆成两个任务（前端任务 `--after` 后端任务）。
   - 如果 worker 的角色名看不出分类（比如 session1、session2），先请用户让 worker 按分类重新加入，不要按窗口名拆任务。
   - **同时进行的任务 `paths` 不能重叠。** 服务只提交任务路径内的改动，这是隔离的唯一手段。
   - 验收标准要能逐条核对。
   - 有先后关系就用 `--after`，依赖的任务通过后才会派发。
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
| （用户说某个 worker 窗口没了） | `ateam reclaim T3`：立即收回任务交给同角色的其他 worker 接手，不必等租约过期；原 worker 会被标记掉线 |
| `worker_offline` | `ateam status` 确认任务已退回待领取；没有同角色 worker 在线时，提醒用户开新窗口（换账号也可以），新 worker 会自动接手 |
| `task_held` | 任务被打回 3 次已挂起：改写任务 `ateam task edit T3 --desc-file t3.md --accept "..."` 后 `ateam release T3`；或者自己改代码后 `ateam approve T3` |
| `worker_joined` `claimed` | 了解即可 |

## 作废任务

任务不再需要（拆错了、改由别的分类做、需求变了）时：

```
ateam cancel T5 "改由 backend 角色做，见 T12"
```

- 作废的任务不再派发，不计入进度和汇报，看板上置灰放在最下面。**不要用改标题的方式标记作废。**
- 有别的任务依赖它时会被拒绝：先作废那些任务，或用 `ateam task edit <编号> --after ...` 去掉依赖。
- worker 正在做的任务也可以作废，worker 下次调用命令时会收到通知，停止这个任务。它在工作区留下的未提交改动需要你检查处理。
- 已通过的任务不能作废。

## 4. review

```
ateam show T3          # 描述、验收标准、历史、提交列表
git show <sha>         # 这个任务的改动
git status --short     # 有没有越界的残留改动（任务路径以外的未提交文件）
```

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

**让 worker 下线**：所有需求都做完、近期也没有新任务时，让 worker 收工，免得它们一直空转等待：

```
ateam dismiss --all              # 全部在线 worker
ateam dismiss --role frontend    # 某个角色
ateam dismiss fr-173c ba-de66    # 指定编号
```

空闲的 worker 马上收到「已下线」并停止；手上有任务的会做完这个任务（通过、作废或被收回）再下线，期间不再领新任务。用户说「让大家收工」时也这样做。之后要再开工，请用户重新打开 worker 窗口。

## 6. 会话重开

上下文满了或会话重开时：先运行 `ateam status`，按「待你处理」列表继续（待 review、等待答复、已挂起），再重新启动 `ateam watch --follow` 的后台监听。事件不是唯一的事实来源，`status` 不会漏掉需要处理的事。
