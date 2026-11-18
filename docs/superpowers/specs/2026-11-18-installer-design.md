# ateam 安装包与升级 设计

## 目的

现在装 ateam 要手动 `npm link`、建 skill 软链、装 hook，同事的电脑上还得先有 Node。做成 Mac 安装包：双击装完就能在任意项目目录运行 `ateam`，skill 自动链接到各 agent 平台；有新版本时看板提示，一键更新。

用户本人和同事都用安装包；用户本人同时要能直接跑源码仓库（改完代码立即生效，不用打包）。

## 不做

- Windows 安装包：自动启动 WorkBuddy、提词悬浮窗、焦点检测都依赖 macOS，ateam 目前只支持 Mac。
- 常驻服务（LaunchAgent）、原生窗口：`ateam serve` 是在各项目目录里各自启动的，看板用浏览器打开。只做菜单栏图标（见下）。
- 安装包签名、公证：和 apiloop 一样不签名，第一次打开在「系统设置 → 隐私与安全性」点「仍要打开」。

## 方案选择

升级方式考虑过两种：

1. **（采用）看板一键更新，安装包发在 GitHub Releases**：下载对应架构的 pkg，交给系统安装程序，输一次管理员密码。与 apiloop 的 Mac 版一致，标准 pkg 安装，路径固定。
2. 装到用户目录、ateam 自己替换文件，不要密码：不是标准 pkg 安装，自己替换文件出错时难恢复，不采用。

安装包放 GitHub Releases（用户决定）。前提：仓库 `HananaKanana/agent-team` 是公开的，未登录的电脑才能查到和下载。

## 参考

`~/code/apiloop/agent-installer/mac/`：官方 Node 原样打包（核 sha256、全程不重新签名，macOS 15 起未签名程序访问局域网会被静默拒绝，而 ateam 默认对局域网开放）、`pkgbuild` + `productbuild`、postinstall 以 root 运行时找到登录用户再以该用户身份操作、`lib/gateway/update.js` 的下载后 `open xxx.pkg`。

## 安装后的布局

```
/Library/Application Support/ateam/
  node/                 官方 Node（nodejs.org 构建，原样）
  app/                  bin/ src/ skills/ docs/ README.md package.json（ateam 零依赖，直接复制）
  卸载 ateam.command
/usr/local/bin/ateam    启动脚本
```

**启动脚本**：读 `~/.config/ateam/dev-repo`，有且目录存在就用自带 Node 运行 `<仓库>/bin/ateam.js`（开发模式），否则运行 `app/bin/ateam.js`。worker hook 里写的是「Node 路径 + ateam.js 路径」，安装版的路径升级后不变，hook 不用重装。

## 安装时做的事（postinstall）

以 root 运行，找到当前登录用户后以该用户身份执行 `ateam setup`：

1. **skill 软链**（开发模式下链到仓库，否则链到 `app/skills`）：
   - `ateam-lead` → `~/.claude/skills/`
   - `ateam-worker` → `~/.agents/skills/`、`~/.workbuddy/skills/`
   - `browser-cdp-setup` → `~/.agents/skills/`
   - 已有同名软链：直接替换。已有同名真实目录：改名为 `<名>.bak-<日期>` 后再链接。
2. **自动进入开发模式**：第一次安装时，如果现有 skill 软链指向某个 git 仓库（即现在的 `npm link` + 手动软链用法），把那个仓库记为开发仓库，保持现状，不覆盖。
3. **清理 `npm link` 留下的旧命令**：PATH 里名为 `ateam`、指向 `.../bin/ateam.js` 的软链删掉，避免两个 `ateam` 抢先后。
4. **hook**：本机有 DeepSeek Harness（`~/.dsh`）或 WorkBuddy（`~/.workbuddy`）的，各执行一次 `ateam hook install`。DeepSeek Harness 需要重启才加载，安装完成页和看板自检会提示。

postinstall 永远成功退出，出问题写进 `/tmp/ateam-install.log`；看板「安装」页和自检照常能查出没装好的项。

## 菜单栏程序 ateam.app

装在 `/Applications/ateam.app`，只在屏幕右上角菜单栏显示图标（不出现在 Dock，没有窗口）。点开：

```
 ateam 0.2.0 · 开发模式
 ──────────────────────────────
 ● sp      运行中 · 3 worker · 1 待验收   ▸ 打开看板 / 重启服务 / 停止服务 / 查看日志 / 在 Finder 中显示 / 从列表中移除
 ○ equip   未运行                        ▸ 启动并打开看板 / 在 Finder 中显示 / 从列表中移除
 添加项目…
 ──────────────────────────────
 有新版本 0.2.1，点击更新…（有新版本时）
 检查更新
 ──────────────────────────────
 登录时自动打开            ✓
 退出 ateam 菜单
```

- **项目列表**：`~/.config/ateam/projects.json`。`ateam serve` 启动时把项目目录记进去，「添加项目…」用选择文件夹对话框加。点开菜单时刷新每个项目的状态（读 `.ateam/port`，请求服务的 `GET /api/summary`）。点项目名 = 打开看板（未运行就先启动）。
- **图标小圆点**：任一项目有待验收的需求或待答复的提问时显示，每 15 秒查一次。
- **后台运行**：菜单启动的服务不开终端，输出写到 `<项目>/.ateam/serve.log`，「查看日志」用「控制台」打开。终端里手动启动的服务同样识别、同样可以停止和重启。
- **停止 / 重启**：服务新增只限本机的 `POST /api/shutdown`、`POST /api/restart`（局域网只读访客调用不了）。重启沿用原来的启动参数和端口，在后台重新拉起，输出写到 `serve.log`；看板「服务需要重启」的提示上加「重启」按钮，用的是同一个接口。
- **退出菜单栏程序不停服务**：它只是控制面板，误点退出不打断 leader 和 worker。
- **登录时自动打开**：在 `~/Library/LaunchAgents/` 写一个打开 ateam.app 的条目，勾选切换。安装完成时默认打开一次、默认勾选。
- **更新**：「点击更新」运行 `ateam update`（与看板的「立即更新」相同）；「检查更新」立即查一次。

## 开发模式

- `ateam dev on <仓库路径>`：记下仓库，skill 软链和 hook 改指向仓库。之后改代码直接生效。
- `ateam dev off`：删掉记录，skill 和 hook 改回安装版。
- `ateam dev`：显示当前模式和路径。
- 开发模式下不检查更新；升级安装包时保留开发模式。
- 看板「安装」页显示当前版本和模式（安装版 / 开发模式：仓库路径）。

## 升级

- **检查**：安装版的 `ateam serve` 启动时和之后每 6 小时请求 `https://api.github.com/repos/HananaKanana/agent-team/releases/latest`（不带用户信息，User-Agent 写 `ateam-update`）。tag `vX.Y.Z` 比本机 `package.json` 的版本新，且有本机架构的安装包时，看板页头显示「有新版本 X.Y.Z」。查不到（没联网、仓库不公开、超出 GitHub 未登录限额）就不显示，不报错。
- **更新**：点开显示该版本的更新说明（Release 正文）和「立即更新」。ateam 下载 `ateam-X.Y.Z-<arm64|x64>.pkg` 到临时目录（显示进度），`open` 打开系统安装程序，用户输一次密码完成安装。Node 下载的文件不带隔离标记，不会被 Gatekeeper 拦。
- **装完**：正在运行的 `ateam serve` 发现代码变了，显示现有的「服务需要重启」提示。skill 是软链，自动是新内容。
- **校验**：每个安装包在 Release 里附一份 `<安装包名>.sha256`。下载完先核对，对不上就删除文件、提示「安装包校验失败」，不打开安装程序。
- **回退**：`ateam update --version X.Y.Z` 安装指定版本（可以比当前旧）；看板「版本」页列出最近的版本，旧版本旁有「安装此版本」。
- 局域网只读访客看不到「立即更新」。
- 命令行：`ateam version` 显示版本和模式，`ateam update` 做同样的检查和下载安装。
- **看板「使用说明 → 版本」页**：当前版本、模式（安装版 / 开发模式：仓库路径）、上次检查更新的时间和结果、「检查更新」按钮，以及最近几个版本的更新说明（取自 Release 正文）。

## 打包与发布

- `agent-installer/mac/build.sh`：下载官方 Node（与 apiloop 同版本，核 sha256，不重新签名），复制 app 文件，写启动脚本，`pkgbuild` + `productbuild` 生成 `agent-installer/dist/ateam-<版本>-<arm64|x64>.pkg`（不入库）。安装界面拦下装错架构的情况。
- **发布前检查**（`release.sh` 打包前，任何一项不过就停止，不发布）：所有源码 `node --check`；README、skills、看板说明里出现的 `ateam <子命令>` 都是存在的命令；打完包展开核对文件齐全、Node 的 TeamIdentifier 和 sha256 与下载件一致。
- `agent-installer/release.sh <版本>`：要求在 main、工作区干净；改 `package.json` 版本并提交、打 tag、打两个包、推送 main 和 tag、`gh release create` 上传两个包和各自的 `.sha256`，更新说明默认取上个 tag 以来的提交标题，可先编辑。**由用户运行**（会推送）。

## 卸载

`卸载 ateam.command`：删除指向安装目录的 skill 软链和 hook 条目，删除 `/Library/Application Support/ateam`、`/usr/local/bin/ateam`，`pkgutil --forget`。开发模式记录、各项目里的 `.ateam/` 不动。

## 验证分工

开发时只做语法检查和 `build.sh` 能打出包、包内文件齐全、Node 签名未变（`codesign -dv` 核 TeamIdentifier、sha256 与下载件一致）。安装、升级、开发模式切换涉及管理员密码和改系统，交给用户按核对清单验证。

## 留给实现时决定

- 看板「有新版本」提示的具体样式（沿用页头标签的风格）。
- `ateam setup` 的输出措辞。
