# 演播与浏览器工具解耦 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 演播不再绑定 `cua_execute`。操作记录改成「`actions` 动作块 + 工具行 + 预期行」；视口改为一个设置项，由 worker 用自己的浏览器工具调整；删掉 ateam 里的视口工具和 cua 解析。

**Architecture:**
- `src/demo.js` 的操作记录解析改成只认结构：有没有 actions 块、预期行、视口行；另外识别旧的 cua 格式。
- store 新增设置 `demoViewport`。
- server 把目标视口和「格式过期」两项信息附在演播指令和接口里；开始演播时拒绝旧格式。
- format.js 重写预演和演播规则。
- 看板删掉视口提示，加上设置项和「需要重新预演」的提示。
- 命令行删掉 `demo viewport`。

**Tech Stack:** Node ≥ 18，ESM，零依赖；单文件看板 `src/dashboard.html`。

**Spec:** `docs/superpowers/specs/2026-10-26-demo-tool-neutral-design.md`

## Global Constraints

- 零依赖、ESM、Node ≥ 18；不写测试代码，用 `node --check` + scratchpad 一次性探测（跑完删除）；看板只做语法检查和代码审阅。
- 视口预设：`1280x720`、`1600x800`（默认）、`1920x1080`、`2560x1440`；自定义格式 `宽x高`，宽高为 320–7680 的整数。
- 操作记录：开头一行 `视口：宽x高`；每步 `### N.` 条目里有 ` ```actions ` 代码块、`工具：` 行、`预期：` 行。
- 旧格式：有 ` ```cua ` 块、没有 ` ```actions ` 块。
- worker 规则里不出现插件名、`cua_execute`、`osascript`。
- 每完成一个任务，把对应 `- [ ]` 改成 `- [x]`，和代码一起提交。

## Review Focus

1. 预演跑完时缺预期行、缺 actions 块、缺视口行：`demo end` 拒绝，并逐条列出缺什么。（Task 1 探测。）
2. 旧 cua 格式的卡点「开始演播」：服务拒绝，提示重新预演；点「开始预演」照常可以。（Task 2 探测。）
3. 演播指令里的目标视口取自这张卡的记录，不受之后改设置影响；预演指令取当前设置。（Task 2 探测。）
4. 设置填非法尺寸（`1600*800`、`100x100`、`abc`）：拒绝；`null` 恢复默认。（Task 2 探测。）
5. 看板「已录」标记：用新格式判断（有 actions 块和预期行），旧格式的步骤不算已录。（Task 3 审阅。）

---

### Task 1: `src/demo.js` 操作记录解析

**Files:** Modify `src/demo.js`

**Interfaces（Produces）:**
- 删除 `ACTIONS`、`actionProblem`、`parseCuaBlock`。
- `parseOps(markdown) -> { viewport: string|null, legacy: boolean, steps: Map<n, { hasBlock, hasExpect, tool: string|null, problem: string|null }> }`
  - `hasBlock`：条目里有 ` ```actions ` 代码块，而且内容不是空的；
  - `hasExpect`：有一行 `预期：`（全角或半角冒号都认），冒号后面有内容；
  - `problem`：缺块写「没有动作块（```actions）」，缺预期写「没有预期行（预期：…）」，两个都缺就两句都写；
  - `legacy`：整段操作记录里出现过 ` ```cua `，但一个 ` ```actions ` 都没有。
- `checkOps(markdown, { all })`：
  - `all` 为真时，缺视口行报「操作记录开头缺「视口：宽x高」」；
  - 每个演示步骤：没有 `### N.` 条目、或 `problem` 不为空，就报出来；
  - `all` 为假时，只检查已经写了的条目，规则同上。
- `export const VIEWPORT_RE = /^(\d{3,4})x(\d{3,4})$/`，供 store 和 server 共用。

- [ ] **Step 1:** 实现。
- [ ] **Step 2:** scratchpad 探测：
  - 3 步脚本，全部录好（视口行 + 每步 actions 块 + 预期行）：`checkOps(all)` 返回空；
  - 第 2 步去掉预期行：报「第 2 步：没有预期行」；
  - 去掉视口行：报缺视口；
  - 旧 cua 记录：`legacy === true`；
  - 同时有 cua 块和 actions 块：`legacy === false`。

  Run: `node --check src/demo.js && node <scratchpad>/probe-ops.mjs` → `ALL PASS`，删除脚本。
- [ ] **Step 3: Commit** `demo: tool-neutral ops format (actions block + 预期), detect legacy cua records`

### Task 2: store 设置、server、命令行、worker 规则

**Files:** Modify `src/store.js`、`src/server.js`、`src/format.js`、`bin/ateam.js`

**Interfaces:**
- store：`SETTINGS.demoViewport = { type: 'size', def: () => '1600x800' }`。
  - `setSettings` 处理 `size` 类型：值必须匹配 `VIEWPORT_RE`，宽高都在 320–7680 之间，否则报 `INVALID`「demoViewport 要写成 宽x高，比如 1600x800」；`null` 恢复默认。
- server：
  - 演播指令附带的 `script` 里加两个字段：
    - `viewport`：预演用 `config().demoViewport`；演播用 `parseOps(text).viewport ?? config().demoViewport`；
    - `legacy`：等于 `parseOps(text).legacy`。
  - `POST /api/demo/start`：`mode === 'show'` 时读脚本；`legacy` 为真就报 `BAD_STATE`「T? 的操作记录是旧格式（按坐标录的），请先重新预演一次」。
  - `GET /api/demo/ops`：返回里加 `legacy`；`recorded` 改为 `hasBlock && hasExpect` 的步骤号。
  - `demo end` 的拒绝文案改为：「每步要有「### N.」条目、```actions 动作块和「预期：」行，开头要有「视口：宽x高」」。
- format.js：
  - `OPS_FORMAT` 重写。写明条目格式（` ```actions ` 块、`工具：`、`预期：`），以及：
    - 动作块用你当前浏览器工具的命令格式，下次演播要能一次执行完；
    - 按元素找目标（选择器、角色 + 名字），不录坐标；
    - 预期要能用工具确定地核对，录的时候实际核对一次；
    - 开头写 `视口：<script.viewport>`。
  - 视口规则（预演和演播共用）：「开始前用你的浏览器工具把页面视口（以页面里的 innerWidth/innerHeight 为准）调到 <宽>x<高>：先读页面视口和窗口尺寸，按差值设真实窗口大小，再读一次确认。只改页面视口、不改窗口的做法不行，内容会溢出到窗口外。调不了（比如屏幕不够大）就停住：demo end --stuck "视口调不到 <宽>x<高>：<原因>"」。
  - 快档：「demo step 报到 → 把这一步的动作块一次执行完 → 核对预期。对得上进下一步；对不上（报错、找不到元素、预期不符）这一步切慢档」。
  - 慢档：「看页面、找元素、走通，把新的动作块和预期写回操作记录，demo step 加 --slow」。
  - 【核对】步骤：核对预期之外，再截一张图自己看一眼。
  - 删掉所有 `cua_execute`、截图读视口、`ateam demo viewport` 的说法。
  - `script.legacy` 为真的预演：规则开头加一句「旧的操作记录是按坐标录的，作废，按新格式整段重写」。
- 命令行：
  - 删掉 `demo viewport` 命令、USAGE 里那一行、`chrome-frame.json` 的读写，以及只给它用的 osascript 辅助函数（先 grep 确认没有别处在用）。
  - `ateam settings` 如果有列出设置的地方，加上 `demoViewport`。

- [ ] **Step 1:** 实现。
- [ ] **Step 2:** scratchpad 探测（`createStore` + 临时 git 仓库 + 真服务）：
  - `setSettings({demoViewport:'1920x1080'})` 成功；`'1600*800'`、`'100x100'`、`'abc'` 报 `INVALID`；
  - 旧 cua 记录的卡（已预演）：`start {mode:'show'}` 报错，含「旧格式」；`start {mode:'rehearsal'}` 成功；领取后的预演指令里含「旧的操作记录是按坐标录的」，视口是当前设置；
  - 新格式、记录写着 `视口：1280x720`：把设置改成 1920x1080 后开始演播，指令里的视口是 1280x720；
  - `demo end` 缺预期行：被拒，信息含「预期」；
  - 指令文本里不出现 `cua_execute`、`osascript`、`demo viewport`。

  Run: `node --check src/store.js src/server.js src/format.js bin/ateam.js && node <scratchpad>/probe-demo-neutral.mjs <scratchpad>` → `ALL PASS`，删除脚本和临时目录。
- [ ] **Step 3: Commit** `demo: viewport setting, legacy records need re-rehearsal, tool-neutral worker rules; drop demo viewport command`

### Task 3: 看板

**Files:** Modify `src/dashboard.html`

- 删掉 `viewportTip`、`CHROME_FRAME_H`、`DEFAULT_VIEWPORT` 和调用处，以及只给它们用的样式。
- 设置页加一组「演播」，一个 `demoViewport` 项：
  - 下拉框列四个预设，加一个「自定义…」；
  - 选「自定义」时出现一个文本框，填「宽x高」，失焦时保存；
  - 说明文字：「预演按这个尺寸录，演播沿用这张卡预演时的尺寸。窗口要比它再大一圈（标签栏、地址栏），超过屏幕的尺寸 worker 调不出来，会停住。」
- 演播卡：`opsCache` 记下 `legacy`。旧格式的卡，「开始演播」按钮禁用，旁边提示「操作记录是旧格式（按坐标录的），请重新预演」。「重新预演」照常可用。
- 卡上显示这张卡记录的视口（读 `/api/demo/ops` 返回的 `viewport`），比如「视口 1600x800」，放在原来视口提示的位置。

- [ ] **Step 1:** 实现。
- [ ] **Step 2:** 语法检查 → `syntax ok`；代码审阅：`viewportTip` 没有残留引用；没有演播卡的项目页面不受影响。
- [ ] **Step 3: Commit** `dashboard: demo viewport setting; legacy demo cards ask for a re-rehearsal; drop viewport tip`

### Task 4: skill 与核对清单

**Files:** Modify `skills/ateam-worker/SKILL.md`、`skills/ateam-lead/SKILL.md`、`docs/manual-checklist.md`

- worker skill 的演播一节改成用 DSH 的 browser-cdp：
  - `open` 自己的标签页，全程用这个 tabId，收尾时 `close`；
  - 调视口：先用 `eval` 读 `innerWidth/innerHeight/outerWidth/outerHeight`，按差值用 `chrome-window.mjs set` 设真实窗口，再用 `eval` 确认；不能用 `resize`；
  - 动作块写成一串 curl，一步一次 shell 调用执行完；
  - 用 `wait` / `assert` 核对预期；
  - 慢档用 `snapshot aria:true` 找元素。
  - 主循环表里 `# 演播` 那一行，删掉 `cua_execute` 和 `demo viewport` 的说法。
- leader skill：演播卡一节写明视口在看板设置里选；旧格式的卡要先重新预演。
- 核对清单追加：
  - 设置里改视口后，新预演按新尺寸录，已预演的卡演播时仍用原来的尺寸；
  - 旧格式的卡不能开始演播，提示重新预演；
  - 预演缺预期行时 `demo end` 被拒；
  - 演播中改动页面，让某一步的预期对不上：worker 切慢档补救，并写回新的动作块。
- [ ] **Step 1:** 实现。
- [ ] **Step 2: Commit** `skills: demo via the worker's own browser tool (browser-cdp); checklist`
