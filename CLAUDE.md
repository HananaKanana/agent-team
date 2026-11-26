# agent-team

本地任务协调服务 `ateam`：Claude Code 当 leader，带领若干 worker（agent 窗口，目前用 DeepSeek Harness 或 WorkBuddy；test worker 操作浏览器时，DeepSeek Harness 用 dsh-cdp 插件，见 `skills/browser-cdp-setup`，WorkBuddy 用它自带的 Chrome 插件），在同一台电脑、同一个项目目录里协作开发。leader 负责拆任务、派任务、review、汇报，worker 负责领任务、干活、提交。worker 可能因为 token 用完而中途掉线，用户换账号开新窗口后，新 worker 接手继续。

## 文档

- 使用说明：`README.md`
- 手工核对清单：`docs/manual-checklist.md`，按功能分组。新条目放进对应的 `## 功能` 组并在组内编号，不要追加到文件末尾
- 工具后 hook：`docs/worker-hook-setup.md`
- 安装包、菜单栏程序、发布：`agent-installer/`（`mac/build.sh` 打 Mac 包，`windows/build.sh` 在 Mac 上打 Windows 包（C# 托盘程序 + 安装程序，.NET Framework 4.8），`mac/build-all.sh` 全部一起打，`release.sh` 发布到 GitHub Releases，`precheck.mjs` 发布前检查）
- 各功能的设计和计划：`docs/superpowers/specs/`、`docs/superpowers/plans/`。这些是当时的记录，现状以代码和 README 为准

## 当前进度

最初的实施计划已经完成，项目处于持续迭代中，按用户当前的要求改。没有待接手的计划步骤。

## 约定

- 和用户交流用中文。
- 零依赖、ESM、Node ≥ 18。
- 看板在 `src/dashboard/`：`index.html` + `css/` + `js/`，浏览器原生加载，不引入框架和构建步骤。脚本是 ES 模块，index.html 只加载入口 `js/app.js`，其余靠 `import` 引入；每个文件开头的 import 就是它的依赖。按职责放进对应文件，一个文件写大了就再拆。状态由定义它的模块修改，别的模块要改就调它导出的函数（如 `setView`、`openHelper`），不直接赋值（导入的变量也赋不了值）。prefs、state、util 是基础模块，不导入功能模块；加载时立即执行的代码只用基础模块和本模块的东西。`precheck.mjs` 会查每个模块都能从入口走到
- 服务端的状态机 `src/store.js` 只负责组装，各部分在 `src/store/` 下按职责分文件（需求和卡、worker、派发、干活中、review、补充说明、hook、无 leader、审卡、用量、租约、演播等）；共用的状态、时钟、回调在 `src/store/core.js`，一个进程只有一个 store。新功能放进对应文件，状态由所在模块修改，别的模块调它导出的函数
- HTTP 服务 `src/server.js` 只有启动流程（`startServer`），各部分在 `src/server/` 下：`context.js`（启动时设置的项目目录、store、端口等）、`http.js`（请求分发）、`routes-worker/lead/demo/system.js`（接口按调用方分组）、`live.js`（wait、watch、事件流、唤醒）以及规则、推送、同步、用量、升级、worker 启动等各自的文件。新接口加进对应的路由文件
- 直接提交到 main；用户明确要求才推送。
- 不新写测试代码。需要验证时用 scratchpad 里的一次性探测脚本，跑完删除，不进仓库；探测用临时目录和临时端口，不碰用户的项目和 agent 平台配置。
- 不做浏览器或 UI 验证，看板交给用户手工核对。报告时如实说明验证到哪一步。
- 看板上显示的文字用专业的书面语，不用口头表达。
- 改了功能要同步相关的文字：`README.md`、`skills/`、看板的说明和命令输出，并给核对清单加条目。
