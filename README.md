# agent-team（ateam）

本地任务协调服务：Claude Code 当主管，带领若干 WorkBuddy 工人 agent，在同一台电脑、同一个项目目录里协作开发。

- 你只和主管对话：提需求 → 主管拆任务、派给工人 → 工人开发并提交 → 主管 review（不通过就打回）→ 全部通过后主管向你汇报 → 你测试验收。
- 工人随时可能因为 token 用完而掉线。你换账号开一个新窗口，新工人会接手同一个任务，在已有改动上继续。
- 浏览器看板可以随时查看每个需求、每个任务的进度和 review 历史。

零依赖，需要 Node ≥ 18 和 git。

## 安装

```bash
cd agent-team
npm link                     # 之后在任何目录都能运行 ateam

# 主管 skill（Claude Code）
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/ateam-lead" ~/.claude/skills/ateam-lead

# 工人 skill（WorkBuddy）
mkdir -p ~/.workbuddy/skills
ln -s "$PWD/skills/ateam-worker" ~/.workbuddy/skills/ateam-worker
```

## 启动

在要开发的项目根目录（必须是 git 仓库）启动服务：

```bash
cd 你的项目
ateam serve                  # 默认端口 7700，租约 15 分钟
```

状态保存在 `项目/.ateam/state.json`，并自动加进 `.gitignore`。服务重启后状态不丢。

看板：浏览器打开 <http://127.0.0.1:7700>。

## 开工

1. 打开几个 WorkBuddy 窗口，分别对它们说：「使用 ateam-worker skill，角色 frontend」「使用 ateam-worker skill，角色 backend」。
2. 对 Claude Code 说：「使用 ateam-lead skill，需求是……」。
3. 主管会拆任务、派发、review，最后在对话里给你汇报，看板上也会显示汇报。

## 换号接手

工人窗口因为 token 用完停下后，超过租约时长（默认 15 分钟）没有动静，服务会把它标记为掉线，它手上的任务退回待领取。

你只需要换个账号，开一个新的 WorkBuddy 窗口，同样说「使用 ateam-worker skill，角色 frontend」。新工人会收到「⚠ 接手任务」，带着完整的历史和打回意见，在已有改动的基础上继续。

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `ATEAM_URL` | 命令行连接的服务地址。换端口时要同时设置 | `http://127.0.0.1:7700` |
| `ATEAM_LEASE_MIN` | 租约时长（分钟），超过这么久没动静的工人判定为掉线。`--lease` 优先 | `15` |

## 命令一览

运行 `ateam help` 查看全部命令。设计细节见 `docs/superpowers/specs/2026-10-03-agent-team-design.md`。
