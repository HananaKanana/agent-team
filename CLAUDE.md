# agent-team

本地任务协调服务 `ateam`：Claude Code 当主管，带领若干 worker（agent 窗口，目前用 WorkBuddy + DeepSeek V4.1 Flash），在同一台电脑、同一个项目目录里协作开发。主管负责拆任务、派任务、review、汇报，worker 负责领任务、干活、提交。worker 可能因为 token 用完而中途掉线，用户换账号开新窗口后，新 worker 接手继续。

## 文档

- 设计：`docs/superpowers/specs/2026-10-03-agent-team-design.md`（已经过用户审阅确认）
- 实施计划：`docs/superpowers/plans/2026-10-03-agent-team.md`（8 个任务）

## 当前进度

**以实施计划里的勾选框为准。** 每完成一个步骤，就把对应的 `- [ ]` 改成 `- [x]`，和代码一起提交。新会话接手时，先看计划里第一个没勾的步骤，从那里继续。

执行方式还没确定，开工前问用户选哪种：
- 子代理逐个执行：subagent-driven-development
- 当前会话直接执行：executing-plans（之前推荐的是这种）

## 约定

- 和用户交流用中文。
- 零依赖、ESM、Node ≥ 18。
- 不新写测试代码。每个任务用 scratchpad 里的一次性探测脚本验证，跑完删除，不进仓库（见计划中的 Global Constraints）。
- 不做浏览器或 UI 验证，看板交给用户手工核对。
