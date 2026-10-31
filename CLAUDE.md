# agent-team

本地任务协调服务 `ateam`：Claude Code 当 leader，带领若干 worker（agent 窗口，目前用 DeepSeek Harness 或 WorkBuddy；test worker 用 DeepSeek Harness 的 dsh-cdp 插件操作浏览器，见 `skills/browser-cdp-setup`），在同一台电脑、同一个项目目录里协作开发。leader 负责拆任务、派任务、review、汇报，worker 负责领任务、干活、提交。worker 可能因为 token 用完而中途掉线，用户换账号开新窗口后，新 worker 接手继续。

## 文档

- 使用说明：`README.md`
- 手工核对清单：`docs/manual-checklist.md`，按功能分组。新条目放进对应的 `## 功能` 组并在组内编号，不要追加到文件末尾
- 工具后 hook：`docs/worker-hook-setup.md`
- 各功能的设计和计划：`docs/superpowers/specs/`、`docs/superpowers/plans/`。这些是当时的记录，现状以代码和 README 为准

## 当前进度

最初的实施计划已经完成，项目处于持续迭代中，按用户当前的要求改。没有待接手的计划步骤。

## 约定

- 和用户交流用中文。
- 零依赖、ESM、Node ≥ 18。
- 直接提交到 main；用户明确要求才推送。
- 不新写测试代码。需要验证时用 scratchpad 里的一次性探测脚本，跑完删除，不进仓库；探测用临时目录和临时端口，不碰用户的项目和 agent 平台配置。
- 不做浏览器或 UI 验证，看板交给用户手工核对。报告时如实说明验证到哪一步。
- 看板上显示的文字用专业的书面语，不用口头表达。
- 改了功能要同步相关的文字：`README.md`、`skills/`、看板的说明和命令输出，并给核对清单加条目。
