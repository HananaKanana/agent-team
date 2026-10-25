# 项目规则按角色分段 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `.ateam/rules.md` 用 `## ALL` / `## <角色>` 小标题分段，派卡只附全员段和这张卡角色的段；leader 用命令行改规则必须带 `--user-approved`。

**Architecture:** 新模块 `src/rules.js` 放纯函数（分段解析、按角色取、加一条、各段条数、没人收的段）；server 的 `withRules` 和 `/api/rules*` 用它；命令行加 `--role`、`--user-approved`；看板写一份同规则的解析做预览。

**Tech Stack:** Node ≥ 18，ESM，零依赖；单文件看板 `src/dashboard.html`。

**Spec:** `docs/superpowers/specs/2026-10-25-role-rules-design.md`

## Global Constraints

- 零依赖、ESM、Node ≥ 18；不写测试代码，用 `node --check` + scratchpad 一次性探测脚本（跑完删除）；看板只做语法检查和代码审阅，交用户手工核对。
- 段：以 `## ` 开头的行开始，到下一个 `## ` 行为止；`###` 及更深算段内内容；第一个 `## ` 之前的内容算全员。
- 全员段小标题只认 `ALL`（不分大小写）。其他小标题按 `,`、`，`、`、`、空白拆成角色名，不分大小写比对。
- 没有任何 `## ` 的老文件：每个角色收到的内容和现在一字不差（即整份 `trim()` 后的文本）。
- 授权：不带 `--user-approved` → `NEEDS_USER`；看板保存带 `userApproved: true`。
- 提醒整理阈值：没有 `## ` 且以 `- ` 开头的行超过 8 条。
- 每完成一个任务，把本计划对应 `- [ ]` 改成 `- [x]` 和代码一起提交。

## Review Focus

1. 老文件（没有小标题）：`rulesFor(text, 任意角色)` 与 `text.trim()` 完全相同。（Task 1 探测。）
2. `## Frontend，Test` 这类大小写、全角逗号、顿号混写：frontend 和 test 都能收到。（Task 1 探测。）
3. `## 全员` 被当作角色「全员」：没人收，`unreceived` 把它列出来。（Task 1 探测。）
4. 只含小标题、没有内容的段：不附空标题；角色收到的内容为空时 `withRules` 不附 `rules`。（Task 1 探测。）
5. `add --role test,frontend` 时文件里已有 `## frontend, test`：加到那一段，不新建段。（Task 1 探测。）

---

### Task 1: `src/rules.js` 纯函数

**Files:** Create `src/rules.js`

**Interfaces（Produces）:**
- `parseRules(text) -> Array<{ heading: string|null, roles: string[]|'all', body: string }>`：开头没有小标题的部分 `heading: null, roles: 'all'`；`## ALL` → `roles: 'all'`；其他 → 小写角色名数组。`body` 是段内文本（不含标题行）。
- `rulesFor(text, role) -> string`：没有任何小标题时返回 `text.trim()`；否则按原顺序拼接全员段和含 `role` 的段，每段写成 `## <原标题>\n<body.trim()>`（开头无标题段只写 body），段间空一行，跳过 body 为空的段。
- `addRule(text, line, roles = null) -> { text, section }`：`line` 去掉开头 `- ` / `* ` 后写成 `- <line>`。`roles` 为空 → 全员：有 ALL 段就加在最后一个 ALL 段末尾，否则加在第一个 `## ` 之前（没有小标题时就是文件末尾）；`section = 'ALL'`。`roles` 非空 → 找角色集合完全相同的段（忽略顺序和大小写）加在末尾，没有就在文件末尾新建 `## <roles.join(', ')>`；`section` 为该段标题。
- `sectionCounts(text) -> Array<{ section: string, count: number }>`：每段（开头无标题段记作 `ALL`，同名段合并）以 `- ` 开头的行数。
- `unreceived(text, knownRoles: string[]) -> string[]`：非 ALL 段标题里不在 `knownRoles`（不分大小写）中的角色名，去重。
- `needsTidy(text) -> boolean`：没有 `## ` 且 `- ` 开头的行 > 8。

- [x] **Step 1:** 实现。
- [x] **Step 2:** scratchpad 探测：Review Focus 1–5；`addRule('', 'x')` → `'- x'`；`addRule('## backend\n- a', 'b')` 新内容里 `- b` 在 `## backend` 之前；`sectionCounts` 对「开头 2 条 + `## ALL` 1 条 + `## test` 3 条」返回 ALL 3、test 3；`needsTidy` 对 9 条无标题为真、8 条为假。
  Run: `node --check src/rules.js && node <scratchpad>/probe-rules.mjs` → `ALL PASS`，删除脚本。
- [x] **Step 3: Commit** `rules: section parsing by role (## ALL / ## <role>)`

### Task 2: 服务与命令行

**Files:** Modify `src/server.js`、`bin/ateam.js`、`src/format.js`（标题措辞不变的话可不改）

**Interfaces:**
- Consumes: Task 1 全部函数。
- `withRules`：`out.rules = rulesFor(readRules(), result.task.role)`，`trim()` 后为空不附。
- 已知角色 `knownRoles()` = `store.state.tasks` 和 `store.state.agents` 的 `role` 去重。
- `GET /api/rules?role=<r>` → `{ rules, forRole?, unreceived, needsTidy, roles: knownRoles() }`（带 `role` 才有 `forRole`）。
- `POST /api/rules` body `{ text, userApproved }`：不带 → `NEEDS_USER`，信息「改动前后各段条数：ALL 20 → 4，test 0 → 8 ……（只列有变化的段；没有变化写「条数没有变化，内容有改动」）。请把这些和完整新内容给用户看，用户同意后加 --user-approved 重新运行。」；带了 → 写入，返回 `{ rules }`。
- `POST /api/rules/add` body `{ text, roles: string[], userApproved }`：`addRule` 算出新内容；不带授权 → `NEEDS_USER`「将在 <section> 段加一条：- <line>。请给用户看，用户同意后加 --user-approved 重新运行。」；带了 → 写入，返回 `{ rules, section }`。大小上限仍按 `MAX_RULES`。
- 命令行 `ateam rules`：
  - 无子命令：原样列出；`--role r` 时改为列出 `forRole`，标题「# test 收到的项目规则」，为空写「test 目前收不到任何项目规则」。末尾按需追加：`unreceived` 非空 →「这些段目前没有角色会收到：全员、测试（现有角色：backend、frontend、test）」；`needsTidy` →「规则还没按角色分段，各角色都会收到全部规则；可以向用户提议整理（先给用户看分组，用户同意后 ateam rules set --file … --user-approved）」。
  - `add "<规则>" [--role a,b] [--user-approved]` → `/api/rules/add`；成功「已加到 <section> 段。之后派发的 <角色或全员> 任务会带上。」
  - `set --file f [--user-approved]` → `/api/rules`；`NEEDS_USER` 信息由服务给，命令行在后面补「新内容：<f>」。
  - USAGE 那一行改为 `ateam rules [--role <角色>] | add "<一条规则>" [--role a,b] [--user-approved] | set --file rules.md [--user-approved]（改规则必须用户同意）`。

- [x] **Step 1:** 实现。
- [x] **Step 2:** scratchpad 探测（临时目录起真服务）：写入分段规则（带授权）；`POST /api/rules` 不带授权返回 `NEEDS_USER` 且文件没变；`/api/rules/add` 不带授权 `NEEDS_USER` 含段名；`GET ?role=test` 的 `forRole` 不含 backend 段；建一张 test 卡让 worker 领取，wait 结果的规则不含 backend 段内容、含 ALL 段内容；老文件（无标题）领取时规则与文件 `trim()` 相同。
  Run: `node --check src/server.js bin/ateam.js && node <scratchpad>/probe-rules-server.mjs <scratchpad>` → `ALL PASS`，删除脚本和临时目录。
- [x] **Step 3: Commit** `server/cli: rules delivered by role; leader edits need --user-approved`

### Task 3: 看板

**Files:** Modify `src/dashboard.html`

- `saveRules` 的 body 加 `userApproved: true`。`loadRules` 存下 `roles`（`GET /api/rules` 返回的已知角色）。
- 看板内写 `parseRules` / `rulesFor` / `unreceived`，规则同 Task 1（注释写明和 `src/rules.js` 保持一致）。
- `rulesEditor`：
  - 说明改为「每个任务都要遵守的约定，worker 领任务时自动附上。用 `## backend`、`## frontend, test` 分段，只发给这些角色；`## ALL` 段和第一个小标题之前的内容发给所有人。一行一条，支持 markdown。」
  - 编辑框下方加「预览」行：`<select>`（选项：已知角色 ∪ 小标题里的角色，按字母排序；记在 `rules.previewRole`，默认第一个），下方只读 `<pre class="rules-preview">` 显示 `rulesFor(rules.draft, previewRole)`，为空显示「这个角色收不到任何规则」。输入时同步刷新预览（不重绘整个面板，保持光标）。
  - `unreceived(rules.draft, roles)` 非空时预览上方显示提示「这些段目前没有角色会收到：…」。
  - 底部说明改为「保存在项目的 .ateam/rules.md。leader 用命令行改规则需要你同意。」
- 样式：`.rules-preview` 沿用编辑框字体、浅底、`max-height` 内滚动。

- [x] **Step 1:** 实现。
- [x] **Step 2:** 语法检查 `node -e "…new Function(…)"` → `syntax ok`；代码审阅：没有小标题时预览等于全文；保存仍可用。
- [x] **Step 3: Commit** `dashboard: rules preview per role; save sends userApproved`

### Task 4: skill 与核对清单

**Files:** Modify `skills/ateam-lead/SKILL.md`、`docs/manual-checklist.md`

- leader skill 第 58 行那段改写：
  - 规则按角色分段（写法同看板说明）。
  - 加规则前先判断给谁，拿不准放全员。
  - 先把「加到哪段、加什么」告诉用户，用户同意后带 `--user-approved` 运行。
  - 整理或挪动已有规则时，先给用户看「哪条归哪段」，同意后 `set --file … --user-approved`。
  - 几个角色共用的规则写在共用段，不抄两份。
  - `ateam rules --role <角色>` 可以预览某个角色收到什么。
- 第 261 行「验收后检查项目规则」补「同样先给用户看、带 `--user-approved`」。
- 核对清单追加：
  - 老规则文件各角色收到全部。
  - 分段后 test 卡收不到 backend 段。
  - `rules add` 不带授权被拒、带授权落到正确的段。
  - 看板预览随输入变化。
  - `## 全员` 被提示没人收。
- [ ] **Step 1:** 实现。
- [ ] **Step 2: Commit** `skills: rules by role, edits need user approval; checklist`
