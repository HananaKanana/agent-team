# dsh-cdp 完整使用说明

> 目标读者：另一个 AI agent（Claude Code / Claude）或人类开发者。
> 本文件描述的是 **`@dougen/dsh-cdp` 0.4.0** 在 **DeepSeek Harness (DSH) 0.2.1-rc.3 / macOS / Chrome 155** 上的实测行为，不是文档推算。

---

## 0. 一句话理解它

DSH 装了一个插件 `@dougen/dsh-cdp`，它：

- 通过 **一条常驻 CDP 连接** 挂到**你已经在用的** Chrome 上（保留登录态、Cookie、扩展）；
- 在 loopback 上开一个 **HTTP 路由** `/api/dsh-cdp`；
- **不注册任何模型可见的工具**（tool schema 增加 0 个）。agent 用自己已有的 shell / bash 工具 `curl` 它；
- 附带一个 `browser-cdp` skill 描述怎么用。

所以「调用浏览器」= 发一个 HTTP POST。没有 MCP，没有端口协商，没有每次弹窗。

```
agent (bash/curl)
   ↓ POST http://127.0.0.1:<DSH_WEB_PORT>/api/dsh-cdp?cmd=xxx
DSH host 进程（插件）
   ↓ 一条长连 WebSocket + 20s 心跳
你的 Chrome（127.0.0.1:9222）
```

---

## 1. 环境事实（先读这段，否则命令会失败）

### 1.1 路由地址不是固定的

DSH 每次启动会换端口。**必须从环境变量取**：

```bash
echo "$DSH_WEB_URL"      # 例：http://127.0.0.1:61335
```

本文所有例子都用：

```bash
U="${DSH_WEB_URL:?DSH_WEB_URL is not set}/api/dsh-cdp"
```

⚠️ 不要硬编码 `51844` / `61335`，那些是历史端口。

### 1.2 其他有用的环境变量

| 变量 | 值示例 | 用途 |
|---|---|---|
| `DSH_WEB_URL` | `http://127.0.0.1:61335` | 路由前缀 |
| `DSH_PROFILE` | `desktop` | 当前 profile |
| `DSH_PROFILE_DIR` | `/Users/kana/.dsh/profiles/desktop` | 插件安装位置 |
| `DSH_HOME` | `/Users/kana/.dsh` | DSH 数据根 |
| `DSH_SESSION_ID` | `session-…` | 当前会话 |

### 1.3 前置条件：浏览器必须开了调试端点

插件**永不启动、永不关闭**浏览器，只附加。检查：

```bash
curl -s -X POST "$U?cmd=browsers" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;[print(b['id'],'port=',b['port'],'file=',b['hasPortFile'],'listen=',b['listening']) for b in json.load(sys.stdin)['browsers'] if b['hasPortFile'] or b['listening']]"
```

看到类似 `chrome port= 9222 file= True listen= True` 就绪。若全是 `False`：

- **方案 A（保留现有登录态，但每次要授权）**：Chrome 打开 `chrome://inspect` → 允许远程调试 → 重启 Chrome。之后 `~/Library/Application Support/Google/Chrome/DevToolsActivePort` 会出现。**代价见 §1.4。**
- **方案 B（不需要任何授权，推荐）**：
  ```bash
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-agent"
  ```
  Chrome 136+ 对**默认 profile** 拒绝显式调试端口，所以必须带独立 `--user-data-dir`。而一旦带了独立目录，**授权弹窗就再也不会出现**——这正是本节的要点。

### 1.4 如何不点「允许」：用独立 profile

#### 为什么会弹

Chrome 136+ 之后，对**默认 profile**（`~/Library/Application Support/Google/Chrome`）开远程调试，Chrome 每次新建连接都会弹那个框：

> 要允许远程调试吗？/ 一款外部应用请求完全控制此 Chrome 会话…

这不是插件的行为，是 Chrome 自己的保护。Chrome 二进制里就写着这条规则（实测 `strings` 抓到的原文）：

```
DevTools remote debugging requires a non-default data directory. Specify this using --user-data-dir.
DevTools remote debugging is disallowed by the system admin.
```

关键点：**授权是按「连接」算的，不是按「会话」算的**。插件的设计注释里也写明「opening a fresh connection here would raise a *second* prompt」。所以只要连接重建就会再弹一次：

| 触发 | 是否再弹 |
|---|---|
| Chrome 重启 | 是 |
| DSH 重启（插件重连） | 是 |
| 连接断开后自动重连 | 是 |
| 同一连接持续心跳保活 | 否 |

插件有 20 s 心跳，所以一次授权能撑住整个 Chrome 生命周期；但 Chrome 或 DSH 一重启就要重新点。这就是「每次都要点」的来源。

#### 怎么彻底不弹：独立 profile

实测结论（Chrome 155）：

| 启动方式 | 授权弹窗 | CDP 就绪耗时 |
|---|---|---|
| 默认 profile + `chrome://inspect` | **每次新连接都弹** | 需人工点击 |
| `--user-data-dir=/tmp/x --remote-debugging-port=9223` | **从不弹** | 1 秒 |
| 同上，杀掉进程重启同一个目录 | **仍然不弹** | 1 秒 |
| `--user-data-dir=/tmp/x --remote-debugging-port=0` | **从不弹** | 1 秒，自动挑空闲端口 |

也就是说：**「非默认 data dir」== 「无授权弹窗」**，稳定可复现。

推荐组合是 `--remote-debugging-port=0` + 独立目录：

```bash
~/.agents/skills/browser-cdp-setup/chrome-agent.sh          # 启动（profile: ~/.chrome-agent，端口自动）
~/.agents/skills/browser-cdp-setup/chrome-agent.sh --status # 看当前端口
~/.agents/skills/browser-cdp-setup/chrome-agent.sh --reset  # 清空登录态重来
```

用 `0` 而不是 `9222` 的原因：**不会和你主 Chrome 抢端口**。你的主 Chrome 现在正占着 9222（授权模式下 Chrome 不提供 HTTP `/json` 端点，只写 `DevToolsActivePort`），换固定端口迟早撞上。

但要配套改一行插件配置，因为端口是动态的，插件得知道去哪儿找端口文件：

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: dsh-cdp
  name: '@dougen/dsh-cdp'
  config:
    dataDir: ~/.chrome-agent
```

`dataDir` 的作用在源码里很明确：**给了它，discovery 就只看这一个目录**，不再扫 catalog 里那 19 个默认路径。这同时消除了另一个隐患——否则插件可能先发现你主 Chrome 的 `DevToolsActivePort` 就挂上去了，又回到弹窗模式。

实测 `discover()` 的两种结果：

```
dataDir=~/.chrome-agent                              → port=49275  source=port-file  http=true
dataDir=~/Library/Application Support/Google/Chrome  → port=9222   source=port-file  http=false
```

`http=false` 就是「授权模式」的特征：Chrome 只开了 WebSocket，没开 HTTP 端点。

改完**重启 DSH**，之后 `cmd=status` 会显示 `browserId: custom`、`authorized: true`，再也不会弹框。

#### 代价：登录态是独立的

独立 profile 是**另一个干净浏览器**——没有你主 Chrome 的 Cookie。但：

- 它是个**真实持久目录**，在这个窗口里登录一次，之后一直有效（重启也不丢）；
- 可以和你主 Chrome **同时开着**，互不干扰（实测两实例并存，各自 CDP 都正常）；
- 端口由 Chrome 自己挑，永远不冲突。

**建议**：只在 agent profile 里登录你确实需要它操作的那几个站点（内部后台、文档、测试环境），不要拿它登网银和主邮箱。这本来也是更安全的做法——agent 能碰到的账号范围被你物理隔离了。

> 想复用现有登录态可以复制整个 profile 目录，但有坑：必须先完全退出 Chrome（目录有锁），复制过来后两边各自陈旧（cookie 不同步），Google 还可能对复制出的会话触发安全验证。不推荐，除非你明确知道自己在做什么。

#### 如果就是不想改配置

那只能用固定端口 + 默认 profile 目录扫描：

1. 启动时给 `--remote-debugging-port=9222`（或插件配置里 `ports` 列出的端口）；
2. 确保**主 Chrome 关掉**了 `chrome://inspect` 的远程调试，否则它占着 9222 且优先级更高；
3. 插件默认 `ports: [9222]` 会通过 TCP+HTTP 探测发现它。

缺点：主 Chrome 一开调试就抢端口；而且默认 profile 里可能残留过期的 `DevToolsActivePort`，指向一个已经退出的旧浏览器实例，插件会先读它然后握手失败。**所以还是推荐 `dataDir` 那条路。**

#### 关于企业策略

Chrome 确实有 `RemoteDebuggingAllowed` 策略（偏好名 `devtools.remote_debugging.allowed`，二进制里对应 `RemoteDebuggingAllowed`）。但它是一把**总开关**：设 `false` 就完全禁掉远程调试（连你自己调试都不行），设 `true` 只是回到默认状态，**并不会跳过默认 profile 的授权弹窗**。macOS 上还要写 `/Library/Managed Preferences/`（需要管理员/MDM）。所以对你这个问题，它不是解法。

顺带一提，`~/Library/Application Support/Google/Chrome/Local State` 里的 `devtools.remote_debugging.user-enabled: true` 是 `chrome://inspect` 那个开关的状态，跟这个弹窗是两回事——你这里已经是 `true` 了，弹窗照样出现。

### 1.5 调用约定

- 一个命令一次请求，**命令名放 query**（`?cmd=xxx`），参数放 JSON body。
- `cmd` 也可以放 body；query 优先。空 `cmd` 默认 `status`（实测 `GET $U` 与 `POST $U` 都返回 status）。
- 带参数的命令必须 `POST` 且带 `Content-Type: application/json`；只读且无参数的可以用 `GET`。
- `Host` 头必须是 loopback（`127.0.0.1` / `localhost` / `::1`），否则 **403**（防 DNS rebinding）。

```bash
curl -s -X POST "$U?cmd=status" -H 'Content-Type: application/json' -d '{}'
```

### 1.6 响应约定

成功：

```json
{ "ok": true, ...命令自己的字段... }
```

失败（HTTP 仍是 **200**，除了 409）：

```json
{ "ok": false, "error": "protocol" | "unreachable" | "command-failed" | "awaiting-approval",
  "message": "人话解释", "status": { ...连接状态... } }
```

**唯一例外**：`awaiting-approval` 返回 **HTTP 409**。用 `curl -s` 会拿到 body；如果用 `Invoke-RestMethod` 之类会抛异常，需要 `-SkipHttpErrorCheck`。

每一种失败都带 `status`，所以你可以从任何错误里直接读到连接现状。

---

## 2. 命令总览（30 个）

源码 `switch (command)` 去重后共 30 个分支（`back`/`forward` 共用一支）。下面按用途分组；`dialog` 在「读取」和「写入」两处都出现，因为它不带 `accept`/`dismiss` 时只读、带了才是写。

### 2.1 连接与观测（不触发附加，永不阻塞）

| cmd | body | 返回关键字段 |
|---|---|---|
| `status` | — | `state`(`idle`\|`disconnected`\|`connecting`\|`awaiting-approval`\|`connected`\|`error`), `connected`, `authorized`, `busy`, `browser`, `browserId`, `endpoint`, `connectedFor`, `pageCount`, `lastHeartbeatAgo`, `error` |
| `browsers` | — | `browsers[]`: `id/name/dataDir/hasPortFile/listening/port/launch`；`current` |
| `connect` | — | 显式附加，返回 status |
| `reconnect` | — | 断开再连 |
| `stop` | — | 断开连接（不关浏览器） |

`status` 与 `browsers` **不进入命令队列**——一个 5 秒的 `wait` 不会让状态轮询卡住。UI 的浏览器图标靠这个 2s 轮询活着。

### 2.2 标签页

| cmd | body | 返回 |
|---|---|---|
| `tabs` | — | `pages[]`: `id/title/url/owned` |
| `open` | `url`, `settleMs?`(默认 400) | `id`（即 tabId）, `url` |
| `goto` | `url`, `tabId`, `settleMs?` | `id`, `url` |
| `back` / `forward` | `tabId` | `id`, `url` |
| `close` | `tabId` | `closed` |
| `activate` | `tabId` | `active`, `url` |

`owned` 表示「这个标签页是本会话 `open` 出来的」。**写操作只能用 `owned: true` 的页。**

`activate` 是读操作，任何 tab 都能提权——因为后台标签的 `requestAnimationFrame` 和定时器会被节流，截图和布局会僵。

### 2.3 读取（任何标签页，包括用户自己的）

| cmd | body | 返回 |
|---|---|---|
| `eval` | `expression`, `tabId?`, `awaitPromise?`(默认 true) | `value`(字符串), `kind`(`value`\|`object`\|`unserializable`), 可选 `description`/`subtype` |
| `snapshot` | `tabId?`, `limit?`, `aria?`, `boxes?` | `mode`(`dom`\|`aria`), `tree`, `nodes`, `truncated`；aria 模式额外 `refs` |
| `shot` | `tabId?`, `fullPage?`, `out?` | **`path`**(磁盘绝对路径), `width`, `height`, `bytes`, `truncated` |
| `console` | `tabId?`, `level?`, `limit?`(默认 100) | `entries[]`(`level/text/source/url`), `count`, `captured`, `dialogs[]`, `pendingDialog`, `trimmed`, `note` |
| `network` | `tabId?`, `index?`, `filter?`, `limit?`(默认 100) | 列表或 `request` 单条；`total/dropped/returned/trimmed` |
| `dialog` | `tabId?`（不带 accept/dismiss） | `pending`（当前阻塞的对话框）, `dialogs[]` |

#### `eval` 的 `kind` 不是装饰

| kind | 含义 | 应对 |
|---|---|---|
| `value` | 有 JSON 形式，`value` 是字符串化的结果 | 要 JSON 就 `JSON.parse` |
| `object` | 无法序列化描述（如 DOM 节点） | 只返回你要的字段 |
| `unserializable` | `NaN`/`Infinity` 之类 | `value` 是 `"NaN"` 字符串，不要当数字用 |

**最佳实践**：表达式只返回你需要的字段。

```json
{"expression":"({t:document.title,u:location.href})"}
```
不要返回 `outerHTML`——一个页面能吞掉整个上下文预算。

#### `snapshot` 的两种模式

- `aria: false`（默认）：DOM 大纲，便宜，适合「这页有什么」。

  ```
  body
    h1#h "表单测试"
    input#name
    button#go "Go"
  ```

- `aria: true`：无障碍树，每个可操作节点带 `[ref=eN]`，**这是得到 ref 的唯一途径**。

  ```
  - RootWebArea "WT" [ref=e1]
    - button "Press" [ref=e2]
    - textbox [ref=e5]
  ```

**ref 编号不是固定值**，它来自 session 级递增计数器：同一页面不同标签分别是 `e86` / `e106` / `e36`。而且每次 snapshot 都会清空 ref 表——永远从**当前**快照里取，用完即弃。

### 2.4 ref：按语义瞄准，不要按 CSS 路径

ref 是「role + name」对的句柄，比 CSS 选择器抗改结构（多包一层 div，所有选择器都变，role/name 不变）。

- `click` / `hover` / `type` / `key` / `drag` 都接受 `ref`，和 `selector` 等价。
- **编号只增不减**：整个 session 共用一个计数器，所以旧 ref 不会被重新分配给别的元素。
- **但 ref 表每次 snapshot 都会被清空**（源码 `setRefs()` 第一行就是 `this.#refs.clear()`）。所以 ref 只在**最近一次** `snapshot aria:true` 之后有效——你再拍一次快照，之前那批全部作废。
- **页面变化后必须重新 snapshot**。

实测：先取 `e36`，再拍一次快照，旧的立刻失效：

```
{"ok":false,"error":"protocol","message":"unknown ref \"e36\" — take a fresh snapshot (cmd=snapshot with aria:true) and use a ref from it"}
```

这个报错是**设计目标**，不是缺陷。源码注释：

> 合并会让过期 ref 继续解析——静默地指向错误的元素，而点击还会被报告为成功。

正确姿势是「**拍快照 → 立刻用 → 不跨快照复用**」，别把 ref 存起来等会儿再用。找不到元素就重拍一次，成本只是一个命令。

### 2.5 写入（必须 `tabId`，且必须是本会话 `open` 的）

| cmd | body | 返回 |
|---|---|---|
| `click` | **恰好一个**：`selector` \| `ref` \| `x`+`y`；可选 `doubleClick?`, `button?`(默认 left), `clickCount?`, `modifiers?` | `clicked`, `x`, `y`, `button`, `clickCount` |
| `hover` | **要么** `x`+`y`，**要么** `ref`/`selector` | `hovered`, `x`, `y` |
| `drag` | 起点 `fromSelector`/`fromRef`/`fromX`+`fromY`，终点 `toSelector`/`toRef`/`toX`+`toY`，`steps?`(默认 10) | `from{x,y}`, `to{x,y}` |
| `wheel` | `deltaX`, `deltaY`，可选 `x?`, `y?` | `scrolled{x,y,deltaX,deltaY}`, `via`(`gesture`\|fallback), `cancelledByPage?` |
| `type` | `text`，可选 `selector?`/`ref?`, `submit?`, `pressAfter?`, `delayMs?` | `typed`(字符数)，`submitted?` / `pressed?` |
| `key` | `key`（`Enter`/`Escape`/`Tab`/`Ctrl+A`/`Meta+A`…），可选 `selector?`/`ref?` | `key`, `modifiers` |
| `select` | `selector`, 以及 `value`/`values`, `byLabel?` | `picked[]`, `selectedCount` |
| `upload` | `selector`, `files[]`(绝对路径) | 已附加的文件 |
| `dialog` | `tabId`, `accept?`/`dismiss?`, `promptText?` | `answered`, `dialog` |
| `resize` | `width`+`height`(**必须数字**), `mobile?`, `deviceScaleFactor?`；或 `clear:true` | `width/height/deviceScaleFactor/mobile` 或 `cleared:true` |
| `media` | `colorScheme?`, `reducedMotion?`, `forcedColors?`, `contrast?`, `media?` | 实际生效的媒体状态 |

**为什么 `hover` / `wheel` / `resize` / `media` 也算写？** 它们改变用户看到的东西：hover 会展开菜单，wheel 会触发懒加载/无限滚动，resize 会让页面变成手机布局。所以同样要求自有 tab。

#### 参数写错会被明确拒绝，不会静默降级

| 错误写法 | 结果 |
|---|---|
| `click` 同时给 `selector` 和 `ref` | `click takes exactly one target: ref, selector, or x+y (not a combination)` |
| `resize` 给 `"375"` 或 `true` | `resize requires numeric width and height, or clear:true` |
| `dom` check 用 `text=xxx` | `SyntaxError: ... not a valid selector`（`dom` 只认 CSS） |
| 写操作不传 `tabId` | `click requires the tabId of a tab you opened with cmd=open (omitting it is not a fallback)` |
| 写操作传别人的 `tabId` | `click refused: tab xxx was not opened by this session` |

### 2.6 等待与断言

| cmd | body | 返回 |
|---|---|---|
| `wait` | 四选一：`text` / `textGone` / `selector`(+`gone?`) / `expression`；`timeoutMs?`(上限 8000), `pollMs?`(默认 100) | `ok`, `waitedMs` |
| `assert` | `checks[]`（上限 **50** 条） | `passed`, `failed`, `total`, `results[]` |

**`wait` 超时返回 `ok:false` 而不是报错**——「慢」是一个可报告的事实，不是命令失败。不要用固定 `settleMs` 猜，也不要超时后盲目重试。

`timeoutMs` 会被 clamp 到 8000。实测传 `99999`：

```
{"ok":false,"waitedMs":8081}      # 命令真实耗时 8.098s
```

#### assert 的四种 check + 两个通用修饰

| type | 必需 | 语义 |
|---|---|---|
| `js` | `expression`，可选 `equals` | 真值；给了 `equals` 则严格相等 |
| `css` | `selector` + `property`，可选 `equals` / `matches` / `contains` | 计算样式；三者都不给 = 只验元素存在 |
| `dom` | `selector`，可选 `text` 或 `absent:true` | 纯 CSS 选择器 |
| `pixel` | `x`,`y`（**0..1 相对视口**）, `color`, `tolerance?`(默认 16) | 像素采样 |

任何 check 都可以加：
- `click`: `"selector"` 或 `{x,y}` —— **先点击再断言**（会让整条 assert 变成写操作）
- `waitMs`: 动作后的等待

**`ok:true` 只代表命令跑完了。要读 `passed`/`failed`。**

实测一份全过：

```bash
curl -s -X POST "$U?cmd=assert" -H 'Content-Type: application/json' -d "{
  \"tabId\":\"$T\",
  \"checks\":[
    {\"name\":\"title\",\"type\":\"js\",\"expression\":\"document.title==='CDP 工具测试'\"},
    {\"name\":\"h1 color\",\"type\":\"css\",\"selector\":\"#h\",\"property\":\"color\"},
    {\"name\":\"h1 text\",\"type\":\"dom\",\"selector\":\"#h\",\"text\":\"工具测试\"},
    {\"name\":\"no banner\",\"type\":\"dom\",\"selector\":\"#banner\",\"absent\":true},
    {\"name\":\"pixel\",\"type\":\"pixel\",\"x\":0.5,\"y\":0.5,\"color\":\"#eeeeee\",\"tolerance\":20}
  ]}"
# {"ok":true,"passed":5,"failed":0,"total":5,...}
```

---

## 3. 视口大小 vs 窗口大小（关键区分）

这是最容易搞混的一点。**插件只做前者；后者要用原生 CDP。**

### 3.1 视口模拟：`cmd=resize` ✅ 插件原生支持

```json
{"tabId":"…","width":375,"height":812,"mobile":true,"deviceScaleFactor":3}
{"tabId":"…","clear":true}
```

它调的是 `Emulation.setDeviceMetricsOverride`，只改**页面认为自己多大**，不改窗口。

实测响应式断点真的会变。测试页 `@media(max-width:600px)` 红、`@media(min-width:1200px)` 绿：

| width | `innerWidth` | `#bar` 背景 |
|---|---|---|
| 500 | 500 | `rgb(255,68,68)` ← 红，命中 max-width |
| 800 | 800 | `rgb(68,136,255)` ← 蓝 |
| 1400 | 1400 | `rgb(0,170,0)` ← 绿，命中 min-width |

异同对照（同一时刻）：

```
resize 400x300 →
  innerWidth/innerHeight = [400, 300]
  AppleScript 读窗口 bounds = 89, 30, 1689, 917   ← 完全没变
```

`mobile:true, deviceScaleFactor:3` 时截图 375×812 → 输出 1125×2436（@3x），和真机一致。

**特性**：
- 是 per-session 覆盖，**会话结束自动消失**，不留副作用；
- 但视觉上窗口没真的缩小——截图按模拟视口渲染，你的窗口仍是原尺寸。

### 3.2 真窗口大小：插件不支持 ❌，需用原生 CDP

插件源码里只出现 `Emulation.setDeviceMetricsOverride` 和 `Emulation.clearDeviceMetricsOverride`，**从未调用 `Browser.setWindowBounds`**。

要真改窗口，用 `Browser.getWindowForTarget` + `Browser.setWindowBounds`。已验证可用：

| 操作 | 结果 |
|---|---|
| 读 | `{left:89, top:30, width:1600, height:887, windowState:"normal"}` |
| `setWindowBounds({width:1000,height:700})` | 窗口变 1000×700，`osascript` 复查 `89,30,1089,730` ✅ |
| `{windowState:"maximized"}` | 变 2560×1311，`osascript` 复查 `0,30,2560,1341` ✅ |
| `{windowState:"normal"}` + `set 1600 887` | 完整恢复原状 ✅ |

可运行脚本见附录 A（`~/.agents/skills/browser-cdp-setup/chrome-window.mjs`）。

**重要顺序**：窗口最大化后直接 `setWindowBounds` 改尺寸可能无效，要先 `{windowState:"normal"}` 再设宽高。脚本里 `minset` 子命令做的就是这件事。

---

## 4. 硬性限制（读源码确认，不是猜测）

| 项 | 值 | 说明 |
|---|---|---|
| 单命令响应上限 | **24000 字节** | `maxOutputBytes`；超出被裁剪 |
| snapshot 节点上限 | **400** | 超过 `truncated: true` |
| aria ref 上限 | **800** | 每个 session |
| assert 每调用 | **50 条** check | 超了直接拒 |
| `wait` 超时上限 | **8000 ms** | `timeoutMs` 会被 clamp |
| console 保留 | **200** 条 | `CONSOLE_LIMIT` |
| network 保留 | **500** 条 | `NETWORK_LIMIT` |
| dialog 保留 | **20** 条 | `DIALOG_LIMIT` |
| 心跳 | **20 s** | 保活，避免重复授权 |
| WebSocket 握手超时 | **12 s** | 短了会把「慢」误判为「等授权」 |
| 授权放弃 | **90 s** | 静默超过这个就重连（宁可再弹一次） |
| `upload` | **默认关闭** | `uploadRoots: []` |
| 截图目录 | `$TMPDIR/dsh-cdp-shots` | `out` 只能是**相对子目录**，`..` 和绝对路径被拒 |

---

## 5. 安全模型（这是它能被放心用的原因）

### 5.1 标签页所有权是机制，不是约定

```js
function checkWriteTab(session, command, args) {
  if (session.config.strictTabs === false) return
  const tabId = args?.tabId
  if (typeof tabId !== 'string' || tabId === '') {
    throw new CdpError(`${command} requires the tabId of a tab you opened with cmd=open (omitting it is not a fallback)`)
  }
  if (!session.ownsTab(tabId)) {
    throw new CdpError(`${command} refused: tab ${tabId} was not opened by this session ...`)
  }
}
```

设计意图（源码注释）：

> 没有这道限制，一个漏传 `tabId` 的 agent 会去驱动浏览器报出的第一个页面——通常就是用户的。

**后果**：想操作一个已经开着的页面，正确做法不是 `goto` 它，而是 `open` 一个自己的 tab 再 `goto` 同一个 URL。副本同样是登录态（登录态属于浏览器）。

### 5.2 对话框

- 自有 tab：插件**自动替你应答**（默认 `dismiss`），并记录。因为 dialog 会阻塞该页所有协议调用，不答就是每个调用都烧满超时。
- 用户 tab：**只记录，绝不应答**。替用户点「确定」会丢弃他的未保存内容。

### 5.3 upload 的边界

`uploadRoots` 默认为空 = 命令关闭。原因写在源码里：

> 插件跑在 host 进程、在 agent 的文件沙箱之外，所以不受限的 upload 路径会把 `upload` + `eval` 变成任意文件读取。

### 5.4 loopback + DNS rebinding 防护

`Host` 头必须是 `127.0.0.1` / `localhost` / `::1`，否则 403。实测 `-H 'Host: evil.com'` → `{"ok":false,"error":"forbidden"}`。

### 5.5 审计

每条命令一行 JSONL，写到 `$TMPDIR/dsh-cdp-audit/audit-YYYY-MM-DD.jsonl`：

```json
{"ts":"2026-10-26T06:24:08.819Z","cmd":"assert","tabId":"53FAD1…","ok":true,"error":null,"ms":3}
```

用户问「你刚才对我的浏览器做了什么」，查这个文件。

---

## 6. 必须遵守的行为准则（给 agent）

### 6.1 先读后写

```
1. cmd=status             → 是否连上
2. cmd=tabs               → 有哪些页、哪些是我的
3. cmd=open               → 开自己的页
4. cmd=snapshot/aria      → 拿 ref 或选择器
5. 写命令带 tabId
6. cmd=close              → 在本轮内关掉
```

### 6.2 本轮开的 tab，本轮关掉

遗留的标签页是**用户浏览器的可见变化**。`open` 后把 `tabId` 一路带着用，干完 `close`。

### 6.3 遇到登录墙 / 验证码 / 2FA：停下，交给人

没有绕过方法，也不许自己创造。正确做法：

1. **停**。不重试、不自己填账号密码、不去点提示框。
2. **明确告诉用户**：哪个 tab（给出 URL）、页面在要什么。
3. 等确认后，**重新读页面状态**再从断点继续（用户可能已经登录、跳走、或关了标签）。

### 6.4 省 token

- 截图返回**路径**，从不用 base64。要看图就让支持视觉的模型去读文件。
- 优先 `assert` 而不是「截图 + 自己描述」——一次调用确定性回答多个问题。
- `snapshot` 先用小 `limit`，真需要再放大。
- `eval` 只返回需要的字段。
- 大页面别 `console`/`network` 不带 `limit`。

### 6.5 明确报错，不要猜

- `wait` 超时 ≠ 命令失败，读页面再决定。
- `assert` 的 `ok:true` ≠ 断言全过，读 `passed`/`failed`。
- `eval` 的 `kind` 要检查，`unserializable` 别当数字。

---

## 7. 完整实战示例

以下全部实测通过。`U` 见 §1.1。

### 7.0 三种调用方式，选一个

**方式 1：手写 curl**（下面各节就是这样，最透明）

```bash
U="${DSH_WEB_URL:?}/api/dsh-cdp"
H='Content-Type: application/json'
```

**方式 2：用附带的小封装**（同目录 `cdp.sh`，省掉手写 JSON）

```bash
cd ~/dsh-cdp-guide
./cdp.sh status
T=$(./cdp.sh open-url https://example.com | tail -1 | tr -d '"')
./cdp.sh find-ref "$T" searchbox      # 直接给出可用的 ref
./cdp.sh close-all                    # 关掉所有本会话开的页
```

**方式 3：PowerShell**（Windows / pwsh）

```powershell
$r = Invoke-RestMethod -Uri "$env:DSH_WEB_URL/api/dsh-cdp?cmd=status" -Method Post `
  -ContentType 'application/json' -Body '{}' -SkipHttpErrorCheck
$r | ConvertTo-Json -Depth 6
```

`-SkipHttpErrorCheck` 不可省：`awaiting-approval` 是 HTTP 409，不加会变成 PowerShell 异常、看不到 body。

### 7.1 建立连接 + 开自己的页

```bash
U="${DSH_WEB_URL:?}/api/dsh-cdp"
H='Content-Type: application/json'

curl -s -X POST "$U?cmd=connect" -H "$H" -d '{}' \
  | python3 -c "import json,sys;s=json.load(sys.stdin)['status'];print(s['state'],s['browser'],s['endpoint'])"

T=$(curl -s -X POST "$U?cmd=open" -H "$H" \
      -d '{"url":"https://awesome-dsh-plugin.com/","settleMs":1500}' \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "我的 tab: $T"
```

### 7.2 按 ref 搜索并等结果

> ⚠️ **ref 数字不要照抄本文**。它来自一个 session 级递增计数器，同一个页面不同 tab 分别是 `e86` / `e106` / `e36`。而且每次 snapshot 都会清空 ref 表，所以「拍快照 → 立刻用」是唯一正确顺序。下面第 1 步就是动态取。

```bash
# 1) aria 快照 + 自动提取 searchbox 的 ref
REF=$(curl -s -X POST "$U?cmd=snapshot" -H "$H" \
        -d "{\"tabId\":\"$T\",\"aria\":true,\"limit\":80}" \
      | python3 -c "
import json,sys,re
for line in json.load(sys.stdin)['tree'].split('\n'):
    if 'searchbox' in line:
        print(re.search(r'\[ref=(e\d+)\]', line).group(1)); break")
echo "searchbox ref = $REF"

# 2) 立刻用这个 ref 打字（中间不要再 snapshot）
curl -s -X POST "$U?cmd=type" -H "$H" -d "{\"tabId\":\"$T\",\"ref\":\"$REF\",\"text\":\"browser cdp\"}"
# → {"ok":true,"typed":11}

# 3) 等到筛选生效（比 settleMs 稳）
curl -s -X POST "$U?cmd=wait" -H "$H" \
  -d "{\"tabId\":\"$T\",\"textGone\":\"6896 / 6896\",\"timeoutMs\":4000}"
# → {"ok":true,"waitedMs":202}

# 4) 读结果
curl -s -X POST "$U?cmd=eval" -H "$H" -d "{\"tabId\":\"$T\",\"expression\":\"({q:document.querySelector('input').value, n:(document.body.innerText.match(/\\\\d+ \\\\/ \\\\d+/)||[''])[0]})\"}"
# → {"q":"browser cdp","n":"1 / 6896"}
```

用过期 ref（或跨快照复用）的报错长这样，不会悄悄点到别的东西：

```
{"ok":false,"error":"protocol","message":"unknown ref \"e36\" — take a fresh snapshot (cmd=snapshot with aria:true) and use a ref from it"}
```

如果觉得这套 ref 管理麻烦，直接用 CSS 选择器也一样能干活——ref 只是抗改结构，不是必须。

### 7.3 断言 + 截图 + 网络

```bash
curl -s -X POST "$U?cmd=assert" -H "$H" -d "{\"tabId\":\"$T\",\"checks\":[
  {\"name\":\"q filled\",\"type\":\"js\",\"expression\":\"document.querySelector('input').value==='browser cdp'\"},
  {\"name\":\"filtered\",\"type\":\"js\",\"expression\":\"document.body.innerText.includes('1 / 6896')\"},
  {\"name\":\"h1 color\",\"type\":\"css\",\"selector\":\"h1\",\"property\":\"color\"}
]}"

curl -s -X POST "$U?cmd=shot" -H "$H" -d "{\"tabId\":\"$T\",\"fullPage\":true}"
# → {"ok":true,"path":"/var/folders/.../dsh-cdp-1792995525205.png","width":3200,"height":3308,...}

curl -s -X POST "$U?cmd=network" -H "$H" -d "{\"tabId\":\"$T\",\"limit\":5}"
curl -s -X POST "$U?cmd=console" -H "$H" -d "{\"tabId\":\"$T\",\"level\":\"error\",\"limit\":10}"
```

### 7.4 响应式验证（视口）

```bash
for w in 500 800 1400; do
  curl -s -X POST "$U?cmd=resize" -H "$H" -d "{\"tabId\":\"$T\",\"width\":$w,\"height\":800}" >/dev/null
  curl -s -X POST "$U?cmd=eval" -H "$H" \
    -d "{\"tabId\":\"$T\",\"expression\":\"({w:innerWidth,bg:getComputedStyle(document.body).backgroundColor})\"}"
  echo
done
curl -s -X POST "$U?cmd=resize" -H "$H" -d "{\"tabId\":\"$T\",\"clear\":true}"
```

注意 `innerWidth` 会确实变成 500/800/1400，但 `getComputedStyle` 的返回值取决于**目标站点自己有没有响应式规则**——在 awesome-dsh-plugin.com 上三档背景色完全相同（`rgb(246,242,234)`），因为它没在这些断点上改 body 背景。要验证模拟是否生效，看 `innerWidth` 就够；要验证断点行为，得用一个带 `@media` 的页面（§3.1 的三色表就是这么测的）。

### 7.5 收尾（必须）

```bash
curl -s -X POST "$U?cmd=close" -H "$H" -d "{\"tabId\":\"$T\"}"
curl -s -X POST "$U?cmd=tabs" -H "$H" -d '{}'   # 确认只剩用户自己的页
```

---

## 8. 故障排查

| 症状 | 原因 / 处理 |
|---|---|
| `no CDP endpoint found` | 浏览器没开调试端点。跑 `cmd=browsers`，用打印出的 `launch` 命令，或走 `chrome://inspect` |
| `awaiting-approval`（HTTP 409） | 切到浏览器窗口点 **Allow**，然后**重试一次**。绝不循环重试 |
| 图标灰 / 面板「未连接」 | 同上；面板会打印本机找到的浏览器的启动命令 |
| 浏览器重启后图标变灰 | 正常，会自动重连，可能再要一次授权 |
| 图标变蓝 | agent 正在驱动，约 5 秒后恢复 |
| `--remote-debugging-port` 附加不上默认 profile | Chrome/Edge 136+ 的官方限制（防止恶意程序读 Cookie）。改用「方案 A」 |
| `not connected to a browser` | 连接掉了。`cmd=connect`，或 `cmd=reconnect` |
| `no page target <id>` | tabId 已失效（页被关了，或重连后旧 tab 不再归你）。重新 `open` |
| 大页面 `snapshot` 只回一点 | 命中 400 节点 / 24000 字节上限。降 `limit`，或用 `aria` + 精确目标 |
| `unknown ref "e86"` | ref 过期或来自别的 tab。重新 snapshot 取新 ref |
| `upload is disabled: no uploadRoots configured` | 默认关闭。在 profile 的 `cordis.patch.yml` 里配 `uploadRoots` |

---

## 9. 配置（如需改动）

插件由 bundle 层自动挂载（`node_modules/@dougen/dsh-cdp/cordis.patch.yml` 里 `insert` 了 `id: dsh-cdp`）。**默认没有任何 config**——你当前的 `~/.dsh/profiles/desktop/cordis.patch.yml` 里也**没有** `dsh-cdp` 条目，所以全部走源码里的 `Defaults`。

要改就在 profile 的 `cordis.patch.yml` 里追加一个同 id 的条目覆盖：

```yaml
- id: dsh-cdp
  name: '@dougen/dsh-cdp'
  config:
    # dataDir: ~/Library/Application Support/Google/Chrome   # 钉死某个 profile
    # browser: chrome                                        # 优先哪个浏览器
    ports: [9222]                                            # 没有 port file 时探测的端口
    autoConnect: false                                       # true = 启动即连（会立刻弹授权）
    heartbeatMs: 20000
    activityHoldMs: 5000
    strictTabs: true                                         # false = 恢复旧的「默认第一个页」行为（不推荐）
    maxOutputBytes: 24000
    # shotDir: /tmp/shots
    uploadRoots: []                                          # 空 = 禁用 upload
    audit: true
    # auditDir: /tmp/cdp-audit
    dialogPolicy: dismiss                                    # 自有 tab 上 dialog 的默认应答
```

改完**重启 DSH**（菜单 `Restart App and Host`）。

### 最可能需要改的两项

**`uploadRoots`** —— 想用 `upload` 必须配，且只配真正需要的目录：

```yaml
    uploadRoots:
      - /Users/kana/tmp
```

配了之后 `upload` 才能把文件附到 `<input type=file>`。注意源码注释的警告：插件在 host 进程、在你的文件沙箱之外，所以 `upload` + `eval` 等于按路径读任意文件。边界给窄一点。

**`strictTabs`** —— 除非你完全明白代价，否则**保持 `true`**。设成 `false` 会恢复「省略 tabId 就用浏览器报的第一个页」的旧行为，而那个页通常就是用户正在看的。

---

## 附录 A：真窗口大小控制脚本

插件没这能力，所以附一个独立脚本 `chrome-window.mjs`（在 `skills/browser-cdp-setup/` 里），用 DSH 自带的 Node 跑：

```bash
NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"
W=~/.agents/skills/browser-cdp-setup/chrome-window.mjs

"$NODE" "$W" get              # 读当前窗口
"$NODE" "$W" set 1200 800     # 设为 1200x800
"$NODE" "$W" maximize
"$NODE" "$W" fullscreen
"$NODE" "$W" normal
"$NODE" "$W" minset 1200 800  # 先 normal 再设尺寸（最大化/全屏后必须这样）
```

输出示例：

```json
{"browser":"chrome","windowId":1105137614,
 "bounds":{"left":21,"top":30,"width":1200,"height":800,"windowState":"normal"},
 "page":"chrome://newtab/"}
```

已实测：`set 1200 800` → `osascript` 复查 `22,30,1222,830`；`maximize` → 2560×1311；恢复 `1600 887` 后 `21,30,1621,917`。

脚本做的事：
1. 按顺序找各浏览器 profile 下的 `DevToolsActivePort`，取端口 + 浏览器级 WebSocket 路径；
2. 连上后 `Target.getTargets` 找一个 page（浏览器级 CDP 没有「当前窗口」概念，只能反查）；
3. `Browser.getWindowForTarget` 拿 `windowId`，再 `Browser.setWindowBounds`。

**注意**：

- 参数校验在连接**之前**——命令名拼错会立刻报错，不会伪装成「连不上浏览器」。
- 这是**真实改变用户窗口**，侵入性远大于 `resize`。执行前应确认，用完恢复原尺寸。
- 需要浏览器已开调试端点（同 §1.3）。

---

## 附录 B：与「浏览器扩展桥」类插件的区别

| | 本插件（CDP 直连） | 扩展桥（如 dsh-chrome-bridge） |
|---|---|---|
| 需要装浏览器扩展 | 不需要 | 需要 |
| 需要开 TCP 端口 | 是（或自动挑选） | 否（native messaging） |
| 保持现有登录态 | 需独立 profile（见 §1.4） | ✅ 直接复用主 Chrome |
| 驱动用户当前标签页 | ❌ 只能用自己 open 的 | ✅ 可原地接管 |
| 授权弹窗 | 独立 profile 下 **无** | 无 |
| 新增 tool schema | 0 | 11–15 个 |

如果你的核心需求是「**在用户正看着的那个标签页上干活**」，本插件不合适（它按设计拒绝这么干）。那是扩展桥的领域。

如果你的核心痛点是「**就是不想点那个允许框，又必须用主 Chrome 的登录态**」，那扩展桥反而是更对的选择——它走 native messaging + `chrome.debugger`，完全不经过远程调试授权。

---

## 附录 C：实测记录（本文结论的来源）

| 命令 | 实测结果 |
|---|---|
| `status` | `connected`, `authorized:true`, `Chrome 155.0.8059.86`, `127.0.0.1:9222` |
| `browsers` | 19 种 Chromium 全部列出；`chrome` `portFile:true` `listening:true` |
| `tabs` | 用户「新标签页」`owned:false`；自开页 `owned:true` |
| `open`/`goto`/`back`/`forward`/`close` | 全部正常；历史来回正确 |
| `eval` | `{t:"CDP 工具测试",u:"file:///tmp/rw.html"}` |
| `snapshot` dom | 9 节点，树形正确 |
| `snapshot` aria | 456 节点，ref 可用；`click ref=e2` / `type ref=e5` 生效 |
| `shot` | 视口 3200×1488；整页 3200×3308；`out:"myshots"` 落到子目录 |
| `console` | 4 error + 1 log；`level:"error"` 过滤生效；alert 记为 `dismissed` |
| `network` | 列表 + `index:1` 单条含请求/响应头、`ttfbMs:14`、`durationMs:13` |
| `click`/`hover`/`drag` | hover 触发 `mouseenter`；drag `{50,320}→{382,372}` |
| `wheel` | `via:"gesture"`，`scrollY` 0→900 |
| `type`/`key`/`select` | `typed:5,submitted:true`；`Tab` 正常；`picked:["c"]` |
| `resize` | `innerWidth` 500/800/1400 真实变化；在带 `@media` 的测试页上 500→红 / 800→蓝 / 1400→绿 |
| `media` | `dark` → `rgb(17,17,17)` |
| `wait` | 命中 0ms；不存在 `ok:false` 807ms |
| `assert` | 5 种 check 全过；`text=` 语法被明确拒绝 |
| `upload` | `upload is disabled: no uploadRoots configured` |
| `Host: evil.com` | `403 forbidden` |
| 窗口控制（附录 A） | `set 1000x700` 生效；`maximize` 生效；已恢复 `1600×887` |
| 默认 profile + 授权 | `discover()` 给出 `http=false`（只有 WebSocket，无 HTTP 端点） |
| 独立 profile（port 9223） | 1 秒就绪，**无授权弹窗** |
| 独立 profile 重启 | 1 秒就绪，**仍无弹窗** |
| 独立 profile（port 0） | 自动挑端口 65518，写 `DevToolsActivePort`，http=true |
| `discover({dataDir})` | `~/.chrome-agent` → `port=49275 http=true`；默认 profile → `port=9222 http=false` |

---

## 附录 D：`chrome-agent.sh`

启动一个给 agent 专用的 Chrome。默认 `~/.chrome-agent` + 自动端口。

```bash
~/.agents/skills/browser-cdp-setup/chrome-agent.sh            # 启动
~/.agents/skills/browser-cdp-setup/chrome-agent.sh --status   # 看端口和状态
~/.agents/skills/browser-cdp-setup/chrome-agent.sh --reset    # 清空登录态重来
~/.agents/skills/browser-cdp-setup/chrome-agent.sh --dir ~/x  # 换目录
~/.agents/skills/browser-cdp-setup/chrome-agent.sh --port 9333# 固定端口
```

脚本做的事：

1. 读 `$PROFILE_DIR/DevToolsActivePort` 判断是否已在跑（在跑就只报告，不起第二个）；
2. `--reset` 前先确认没有活着的 Chrome 还在用这个目录（否则删了会出锁问题）；
3. 带 `--remote-debugging-port=<port> --user-data-dir=<dir> --no-first-run` 后台启动；
4. 每秒轮询直到 CDP 真的能应答，最多 20 秒，成功就把实际端口打出来。

配套插件配置（一次性）：

```yaml
- id: dsh-cdp
  name: '@dougen/dsh-cdp'
  config:
    dataDir: ~/.chrome-agent
```
