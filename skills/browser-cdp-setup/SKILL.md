---
name: browser-cdp-setup
description: Drive a Chromium browser from DeepSeek Harness through the dsh-cdp plugin without triggering Chrome's "Allow remote debugging?" consent dialog on every connection. Use when connecting to a browser over CDP fails, when the consent prompt keeps reappearing, or when setting up browser automation on a machine — covers the non-default-profile requirement, target verification, and the ref/tabId traps.
---

# 用 dsh-cdp 驱动浏览器（不弹授权框）

`@dougen/dsh-cdp` 通过一条常驻 CDP 连接驱动本机 Chromium，并在 loopback 上暴露
`POST /api/dsh-cdp?cmd=<命令>`。**它不注册任何模型可见的工具**——agent 用已有的
shell 工具 `curl` 调用它。

本文解决三件事：为什么 Chrome 反复弹「要允许远程调试吗」、怎么彻底消掉它、
连上之后有哪些必踩的坑。**这些结论来自 Chrome 155 / DSH 0.2.1 的实测，不是文档推算。**

---

## 0. 先取路由地址

DSH 每次启动换端口，**必须从环境变量取，不要硬编码**：

```bash
U="${DSH_WEB_URL:?DSH_WEB_URL is not set}/api/dsh-cdp"
H='Content-Type: application/json'
```

`DSH_WEB_URL` 形如 `http://127.0.0.1:61335`。没有这个变量说明你不在 DSH 会话里。

调用约定：

- 命令名放 query（`?cmd=xxx`），参数放 JSON body
- `cmd` 也可以放 body；query 优先；空 `cmd` 默认 `status`
- 带参数必须 `POST` + `Content-Type: application/json`
- `Host` 头必须是 loopback，否则 **403**（防 DNS rebinding）
- 成功 `{"ok":true,...}`；失败也是 HTTP 200 + `{"ok":false,"error":...,"message":...}`
  唯一例外：`awaiting-approval` 返回 **409**（用 `curl -s` 能拿到 body，
  用 `Invoke-RestMethod` 需 `-SkipHttpErrorCheck`）

---

## 1. 为什么每次都要点「允许」

Chrome 136+ 对**默认 profile** 开远程调试时，每次新建连接都弹授权框。这是 Chrome
自己的保护，不是插件行为。Chrome 二进制里的原文：

```
DevTools remote debugging requires a non-default data directory. Specify this using --user-data-dir.
DevTools remote debugging is disallowed by the system admin.
```

**授权按「连接」算，不按「会话」算。** 所以 Chrome 重启、DSH 重启、断线重连，
各弹一次。插件虽有 20 s 心跳保活，但连接一断就废。

实测（Chrome 155）：

| 启动方式 | 授权弹窗 | CDP 就绪 |
|---|---|---|
| 默认 profile + `chrome://inspect` | **每次新连接都弹** | 需人工点击 |
| `--user-data-dir=<非默认> --remote-debugging-port=<port>` | **从不弹** | 1 秒 |
| 同上，杀掉重启同一目录 | **仍然不弹** | 1 秒 |
| 同上，端口写 `0` | **从不弹** | 1 秒，自动挑空闲端口 |

**结论：「非默认 data dir」⟺「无授权弹窗」。**

---

## 2. 正确配置（两步，缺一不可）

### 第一步：用非默认 profile 启动浏览器

**agent 自己就能做，不用让用户动手**：运行本 skill 目录下的 `chrome-agent.sh`（比如 `~/.agents/skills/browser-cdp-setup/chrome-agent.sh`）。它用 `~/.chrome-agent` 目录、自动端口启动一个前台可见的 Chrome，等到 CDP 能用才返回；已经在跑就不会再起第二个，所以每次开工前跑一下也没关系。`--status` 只看状态。

第一次启动的是个干净的浏览器，要测的网站还没登录：打开页面遇到登录页就按第 8 节停下，请用户在这个窗口里登录一次，之后一直有效。

脚本做的事等同于下面这条命令：

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=0 \
  --user-data-dir="$HOME/.chrome-agent" \
  --no-first-run --no-default-browser-check \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling &

# Linux: google-chrome   Windows: chrome.exe
```

- **必须是非默认目录**，这是消除弹窗的唯一手段
- **端口用 `0`**：让浏览器自己挑空闲端口并写 `DevToolsActivePort`。固定端口会和用户
  主浏览器抢（它常占着 9222），且默认 profile 残留的旧 `DevToolsActivePort` 会指向
  已退出的实例，握手失败
- 浏览器**必须由人启动或由脚本启动**——插件永不启动浏览器
- 后三个 `--disable-*`：窗口不在最前面、被挡住时照常渲染，定时器不降速。这样 agent
  不用把它拉到前台（见第 5.1 节）

等它就绪（`/json/version` 有应答即可用，通常 1 秒）：

```bash
for i in $(seq 1 20); do
  sleep 1
  P=$(head -1 "$HOME/.chrome-agent/DevToolsActivePort" 2>/dev/null) || continue
  curl -s -H "Host: localhost:$P" --max-time 2 "http://127.0.0.1:$P/json/version" \
    | grep -q '"Browser"' && { echo "ready on $P"; break; }
done
```

### 第二步：把插件的 discovery 钉到这个目录

```yaml
# <profile>/cordis.patch.yml   （通常 ~/.dsh/profiles/<profile>/cordis.patch.yml）
- id: dsh-cdp
  name: '@dougen/dsh-cdp'
  config:
    dataDir: /home/user/.chrome-agent      # ← 必须绝对路径
```

⚠️ **绝对路径，不能用 `~`。** 源码里 `explicitDataDir` 直接用原值，只有 catalog
目录和 `extraDirs` 才走 `expandPath`。实测：

```
dataDir="~/.chrome-agent"            → candidates: 0（找不到）
dataDir="/home/user/.chrome-agent"   → candidates: 1  http=true
```

改完重启 DSH（或等 HMR 热重载）。

**为什么必须配对**：

| 配置 | 作用 | 缺了会怎样 |
|---|---|---|
| 非默认 `--user-data-dir` | 消除授权弹窗 | 每次重连都要手点 |
| `dataDir: 绝对路径` | 让插件找到那个 profile | 插件回去扫默认目录，又挂上主浏览器，弹窗照旧 |

---

## 3. ⚠️ 不要用 `cmd=browsers` 决定连哪个

这是最隐蔽的坑。

`dataDir` 只影响**连接时的 discovery**，**不影响 `browsers` 这个观测命令的输出**。
`cmd=browsers` 会列出 catalog 里所有默认路径的浏览器，**不包含**你自定义的目录：

```
!! chrome: port=9222 file=True listen=True     ← 看起来像"可用目标"
   有没有列出自定义目录? False
```

如果你按 skill 命令表里「找不到就跑 `browsers`」的建议行动，会看到主浏览器
`listening: true` 然后去连它 —— **弹窗就回来了**。

**正确的判断依据是 `cmd=status` 的 `browserId`：**

| 现象 | 含义 | 动作 |
|---|---|---|
| `state: idle` | 还没连过（懒连接，正常） | `cmd=connect` |
| `browserId: custom`, `authorized: true` | ✅ 正确目标 | 直接用 |
| `browserId: chrome` / `endpoint: <默认端口>` | ❌ 连错，会弹窗 | `cmd=stop`，检查 `dataDir` 与浏览器是否用非默认目录启动 |
| `error: no CDP endpoint found` | 浏览器没开 | 按第 2 步启动 |
| `state: awaiting-approval` | 正在等人工授权 | 说明连了默认 profile，`cmd=stop` 后改连 custom |

自检（必须过）：

```bash
curl -s -X POST "$U?cmd=status" -H "$H" -d '{}' | python3 -c "
import json,sys
s=json.load(sys.stdin)['status']
ok = s['browserId']=='custom' and s['authorized']
print(('OK 正确目标' if ok else 'BAD 目标不对'), '|', s['state'], s['browserId'], s['endpoint'])
"
```

`browserId: custom` 说明 `dataDir` 生效了。如果显示 `chrome`，说明配置没读到。

---

## 4. ref 每次快照都会清空

源码 `setRefs()` 第一行是 `this.#refs.clear()`。所以 ref 只在**最近一次**
`snapshot aria:true` 之后有效。

```bash
# 错：拍两次快照，第一批 ref 全废
curl ... snapshot  → ref e6, e14
curl ... snapshot  → （表被清空）
curl ... type ref=e6 → {"error":"protocol","message":"unknown ref \"e6\"..."}

# 对：拍一次，一次性提取所有 ref，立刻全部用完
```

首次用某个页面时，一次性取出所有需要的 ref：

```bash
curl -s -X POST "$U?cmd=snapshot" -H "$H" \
  -d '{"tabId":"'"$T"'","aria":true,"limit":100}' \
  | python3 -c "
import json,sys,re
tree=json.load(sys.stdin)['tree']
for line in tree.split('\n'):
    m=re.search(r'\[ref=(e\d+)\]', line)
    if m: print(m.group(1), line.strip()[:100])
"
```

**两种不同的报错，含义完全不同**：

| 报错 | 含义 | 处理 |
|---|---|---|
| `unknown ref "e6"` | 表里没有这个 ref（快照已失效） | 重新 `snapshot aria:true` |
| `no element matches ref e89` | ref 还在表里，但元素已脱离 DOM（SPA 重渲染） | 改用 CSS 选择器 |

**SPA 上优先用 CSS 选择器或按文字匹配**，比 ref 稳。实测同一个菜单：

```
click ref=e89                       → no element matches ref
click .menu-entry:nth-of-type(3)    → ok
```

`snapshot` 的两种模式：

- `aria:false`（默认）：DOM 大纲，便宜，适合「这页有什么」
- `aria:true`：无障碍树，可操作节点带 `[ref=eN]`，**这是拿 ref 的唯一途径**

---

## 5. 写操作只能用自己 open 的 tab

`strictTabs: true` 是硬编码的（除非显式改配置）。`goto`/`back`/`forward`/`click`/
`hover`/`wheel`/`type`/`key`/`select`/`upload`/`drag`/`resize`/`media`/`close`/
带 `click` 的 `assert`，全都必须传**本会话 `open` 出来的** `tabId`。

```bash
T=$(curl -s -X POST "$U?cmd=open" -H "$H" -d '{"url":"https://example.com"}' \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
[ -n "$T" ] || { echo "open failed"; exit 1; }

curl -s -X POST "$U?cmd=click" -H "$H" -d "{\"tabId\":\"$T\",\"selector\":\"#go\"}"
```

- 不传 `tabId` 是 **error**，不会退回第一个页面（那条路会让 agent 驱动用户正在看的页）
- 读操作（`tabs`/`snapshot`/`shot`/只读 `eval`/`console`/`network`）可以看任何 tab
- 想操作已开着的页面，正确做法是 `open` 自己的 tab 再 `goto` 同一个 URL——副本同样
  带登录态
- 不再用的 tab 要 `close`，遗留的标签是用户可见的变化；但自己常用的那一个留着、停在 `about:blank`，免得下次再 `open`（见 5.1）

### 5.0 只关自己的标签页，不关浏览器

Chrome 是几个 agent 和用户共用的：

- `close` 只用于**本会话 `open` 出来的**标签页（`cmd=tabs` 里 `owned: true`），以及自己
  页面弹出来的新标签页。别人的、用户的标签页不关，不按「全部页面」批量清场
- 不退出、不杀、不重启 Chrome（`pkill` / `killall` / `osascript ... quit` 都不行），也不关
  浏览器窗口。浏览器卡死、连不上就停下来问

### 5.1 不要抢用户的焦点、不要占满连接：只 `open` 一次、闲着停在空白页，`activate` 不用

插件的 `open` 和 `activate` 会调 `Page.bringToFront`，在 macOS 上会把整个 Chrome
拉到最前面、抢走用户正在用的窗口的焦点。其他命令（`goto`/`click`/`type`/`eval`/
`wait`/`assert`/`shot`/`snapshot`……）都不会。

CDP 里「切到某个标签页」和「把窗口拉到最前」是同一个调用，没有只切标签不置顶的办法，
所以只能少 `open`：

- **整个会话只 `open` 一次**：要用浏览器时先 `cmd=tabs`，有 `owned: true` 的就接着用，
  没有才 `open`。之后换页面都在这个标签页里 `goto`（不置顶），不另开
- **点击、输入、等待、核对、截图时一律不 `open`**，也不要为了「保险」先 `open` 一下
- **`activate` 只在自己的标签页被压到后面时用**：几个 agent 共用一个窗口，别人新开
  或切过去的标签页会让你的变成后台页，用户就看不到你在操作。每次 `goto` 之后、每开始
  一段操作之前 `eval` 读 `document.visibilityState`：`visible` 就直接操作；`hidden` 才
  `activate` 一次（会置顶一次，这是为了让用户看得见，可以接受）。窗口只是被别的程序挡住
  时仍是 `visible`（`chrome-agent.sh` 关掉了遮挡降速），不用 `activate`
- **不干活时 `goto about:blank`，不要 `close`**：关了下次还得 `open`，又置顶一次。
  停在 `about:blank` 的页不占被测网站的连接。原因是同一个网站，整个 Chrome 最多 6 条连接
  （HTTP/1.1，按浏览器算，不按标签页算），几个 agent 共用一个 Chrome、每页又挂着长连接
  （SSE、WebSocket、长轮询）时，标签页一多，后打开的页面接口会全部卡住。`cmd=tabs` 里
  `owned: true` 的都是本会话开的，多出来的及时关
- 截图像是没刷新、页面动画卡住：先确认浏览器是用 `chrome-agent.sh` 启动的（带那三个
  `--disable-*` 参数），不是就让用户关掉它重新用脚本启动；不要用 `activate` 顶上去

---

## 6. 视口大小 ≠ 窗口大小

`cmd=resize` 走 `Emulation.setDeviceMetricsOverride`，只改页面**认为**自己多大：

```bash
{"tabId":"...","width":375,"height":812,"mobile":true,"deviceScaleFactor":3}
{"tabId":"...","clear":true}    # 复原
```

实测对照（同一时刻）：

```
resize 400x300  →  innerWidth/innerHeight = [400,300]
                   OS 报告窗口尺寸 = 完全没变
```

要真改窗口，插件不支持（源码里没有 `Browser.setWindowBounds`），需要原生 CDP：

```
Browser.getWindowForTarget({targetId})      → windowId
Browser.setWindowBounds({windowId, bounds:{width, height}})
```

注意：最大化/全屏状态下直接改宽高可能不生效，先 `{windowState:"normal"}` 再设尺寸。

本 skill 目录下的 `chrome-window.mjs` 就是做这个的（用 DSH 自带的 node 跑，它先找
`~/.chrome-agent` 那个 Chrome）：

```bash
NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"
"$NODE" ~/.agents/skills/browser-cdp-setup/chrome-window.mjs get
"$NODE" ~/.agents/skills/browser-cdp-setup/chrome-window.mjs set 1600 887
"$NODE" ~/.agents/skills/browser-cdp-setup/chrome-window.mjs minset 1600 887   # 最大化/全屏时
```

它只改窗口大小，不会把窗口拉到前面。

**只在开工时调一次，干活过程中不要为了「显示不全」去拉大窗口**：`click`/`hover`/`drag`
会先把目标元素滚进视口（弹窗、抽屉里的元素滚的是最近的滚动区域，不动背后的页面），
要单独滚动就用 `wheel`。改了窗口，页面布局和用户看到的尺寸就都变了。

---

## 7. 其他限制（读源码确认）

| 项 | 值 |
|---|---|
| 单命令响应上限 | 24000 字节 |
| snapshot 节点上限 | 400 |
| aria ref 上限 | 800（每 session） |
| assert 每调用 | 最多 50 条 check |
| `wait` 超时上限 | 8000 ms（`timeoutMs` 会被 clamp） |
| console / network / dialog 保留 | 200 / 500 / 20 条 |
| `upload` | **默认关闭**，需配 `uploadRoots` |
| 截图 | 返回**磁盘路径**，不是 base64；`out` 只能是相对子目录 |

`assert` 的四种 check：`js`（`expression`，可选 `equals`）、`css`（`selector`+`property`，
可选 `equals`/`matches`/`contains`）、`dom`（`selector` + `text` 或 `absent`，**只认 CSS**，
不接受 `text=` 语法）、`pixel`（`x`/`y` 是 0..1 相对视口 + `color` + `tolerance`）。
任意 check 可加 `click` + `waitMs`（会变成写操作）。

`ok:true` 只代表命令跑完了，**要读 `passed`/`failed`**。

`wait` 超时返回 `ok:false` 而不是报错——「慢」是可报告的事实，不是失败。不要超时后
盲目重试。

---

## 8. 人机边界

遇到登录墙、验证码、2FA、或任何只有人能做的一步：

1. **停**。不重试、不自己填凭据、不点提示框
2. **说清楚**：哪个 tab（给 URL）、页面在要什么
3. 等确认后**重新读页面状态**再继续（用户可能已登录、跳走、或关了标签）

对话框：自己开的 tab 上插件会自动应答并记录（默认 `dismiss`）；用户自己的 tab 只记录
**绝不应答**——替人点「确定」会丢掉他的未保存内容。

---

## 9. 故障排查

| 症状 | 原因 / 处理 |
|---|---|
| `no CDP endpoint found` | 浏览器没开，或没带 `--user-data-dir`。按第 2 步启动 |
| `awaiting-approval`（409） | 连了默认 profile。`cmd=stop`，检查 `dataDir` 与启动参数 |
| 连上但 `browserId: chrome` | `dataDir` 没生效。确认是**绝对路径**、重启过 DSH |
| `not connected to a browser` | 连接掉了。`cmd=connect` |
| `no page target <id>` | tabId 失效（页关了 / 重连后旧 tab 不再归你）。重新 `open` |
| `unknown ref` | 快照已失效。重拍 `snapshot aria:true` |
| `no element matches ref` | 元素被 SPA 替换。改用 CSS 选择器 |
| `upload is disabled` | 没配 `uploadRoots` |
| 大页面 snapshot 只回一点 | 撞到 400 节点 / 24000 字节上限，降 `limit` |

---

## 10. 一次跑通的完整流程

```bash
U="${DSH_WEB_URL:?}/api/dsh-cdp"; H='Content-Type: application/json'

# 1) 状态
curl -s -X POST "$U?cmd=status" -H "$H" -d '{}' \
  | python3 -c "import json,sys;s=json.load(sys.stdin)['status'];print(s['state'],s['browserId'],s['endpoint'])"

# 2) 连（idle/disconnected 时才需要）
curl -s -X POST "$U?cmd=connect" -H "$H" -d '{}' >/dev/null

# 3) 校验目标（必须 custom + authorized）
curl -s -X POST "$U?cmd=status" -H "$H" -d '{}' | python3 -c "
import json,sys
s=json.load(sys.stdin)['status']
assert s['browserId']=='custom' and s['authorized'], f\"wrong target: {s['browserId']}\"
print('target ok')"

# 4) 开自己的 tab
T=$(curl -s -X POST "$U?cmd=open" -H "$H" -d '{"url":"https://example.com","settleMs":1200}' \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 5) 读
curl -s -X POST "$U?cmd=eval" -H "$H" \
  -d "{\"tabId\":\"$T\",\"expression\":\"({t:document.title,u:location.href})\"}"

# 6) 断言（比截图便宜且确定）
curl -s -X POST "$U?cmd=assert" -H "$H" -d "{\"tabId\":\"$T\",\"checks\":[
  {\"name\":\"title\",\"type\":\"js\",\"expression\":\"document.title.length>0\"},
  {\"name\":\"body\",\"type\":\"dom\",\"selector\":\"body\"}]}"

# 7) 收尾
curl -s -X POST "$U?cmd=close" -H "$H" -d "{\"tabId\":\"$T\"}"
```

---

## 附：如果不想用独立 profile

只能固定端口 + 让插件扫默认目录，**但弹窗无法消除**，且要确保主浏览器关掉了调试
（否则抢端口）。所以除非你必须共享主浏览器的登录态，否则用上面的独立 profile 方案。

想共享登录态的另一条路是**浏览器扩展桥**（如 `dsh-chrome-bridge`）：走 native messaging
+ `chrome.debugger`，完全不经过远程调试授权，能原地驱动你已登录的标签页——
但需要装浏览器扩展，且新增 11–15 个 tool schema。
