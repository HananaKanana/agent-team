# agent-team（ateam）

让 Claude Code 当主管，带几个 WorkBuddy 工人，在同一个项目里分工写代码。

- 你只和主管说话：提需求 → 主管拆成任务派给工人 → 工人写代码、提交 → 主管 review，不合格就打回 → 全部通过后主管向你汇报 → 你验收。
- 工人的 token 用完、窗口停了也没关系：你换个账号开新窗口，新工人会接着上一个的改动继续做。
- 浏览器里有一个看板，随时能看每个任务做到哪了、review 了几轮。

需要 Node ≥ 18 和 git，没有其他依赖。

---

## 一、安装（只做一次）

### 1. 注册 `ateam` 命令

```bash
cd ~/code/agent-team
npm link
ateam help          # 能打印出命令列表就成功了
```

如果提示找不到 `ateam`，说明 npm 的全局目录不在 PATH 里。用 `npm prefix -g` 查出目录（比如 `~/.npm-global`），然后把它的 `bin` 加进 `~/.zshrc`：

```bash
export PATH="$HOME/.npm-global/bin:$PATH"
```

### 2. 安装两份 skill

两份 skill 分给两个程序用，**两边各放一份**：

| skill | 给谁用 | 放到哪里 |
|---|---|---|
| [skills/ateam-lead/SKILL.md](skills/ateam-lead/SKILL.md) | Claude Code（主管） | `~/.claude/skills/ateam-lead/SKILL.md` |
| [skills/ateam-worker/SKILL.md](skills/ateam-worker/SKILL.md) | WorkBuddy（工人） | `~/.workbuddy/skills/ateam-worker/SKILL.md` |

两种装法，选一种：

```bash
# 装法 A：复制。以后 skill 更新了，要再复制一次
mkdir -p ~/.claude/skills ~/.workbuddy/skills
cp -R ~/code/agent-team/skills/ateam-lead   ~/.claude/skills/
cp -R ~/code/agent-team/skills/ateam-worker ~/.workbuddy/skills/

# 装法 B：软链。以后 skill 更新了自动生效
ln -s ~/code/agent-team/skills/ateam-lead   ~/.claude/skills/ateam-lead
ln -s ~/code/agent-team/skills/ateam-worker ~/.workbuddy/skills/ateam-worker
```

也可以手动复制粘贴：文件名必须叫 `SKILL.md`，外面套一层同名文件夹，文件开头 `---` 之间的几行要原样保留。

---

## 二、每次开工

下面以要开发的项目 `~/code/apiloop` 为例。

### 1. 在**要开发的项目根目录**启动服务

```bash
cd ~/code/apiloop          # ⚠ 一定是要开发的项目，不是 agent-team
ateam serve
```

看到这两行就对了：

```
ateam 服务已启动：http://127.0.0.1:7700（看板同地址）
项目目录：/Users/kana/code/apiloop（任务路径相对于这里，工人的改动必须在这个目录里）
```

- **「项目目录」必须是你要开发的项目。** 工人提交时，服务只在这个目录里找改动；目录不对，工人提交会一直报「没有改动」。
- 这个终端窗口**一直开着**，关掉服务就停了。
- 项目必须是 git 仓库（没有就先 `git init`）。
- 服务会在项目里建 `.ateam/` 存状态，并把 `.ateam/` 加进 `.gitignore`（这个改动需要你自己提交）。重启服务状态不丢。

### 2. 打开看板

浏览器打开 <http://127.0.0.1:7700>（只能用 `127.0.0.1` 或 `localhost`）。

### 3. 打开工人

按需要开几个 WorkBuddy 窗口，**工作目录选同一个项目**，分别对它们说：

```
使用 ateam-worker skill，角色 backend
使用 ateam-worker skill，角色 frontend
```

**角色就是工作分类**，比如 frontend、backend、test。派发不是随机的：分类为 backend 的任务只会派给以 backend 加入的工人。所以角色要按「做什么活」起名，不要按窗口起名（像 session1、session2 这种，主管只能把前后端的活混着派）。同一分类可以开多个工人，它们会按顺序分着领。

工人加入后看板顶部会出现绿点。每个分类有固定颜色，卡片上的分类标签同色，一眼能分清谁做什么。

### 4. 让主管开工

在**同一个项目目录**开一个 Claude Code 会话，说：

```
使用 ateam-lead skill，需求是：……
```

告诉它现在有哪些角色的工人。之后主管会自己拆任务、派发、review，全部完成后在对话里给你汇报。

---

## 三、看板怎么看

- **顶部**：每个工人一个标签。绿点 = 在线，灰色 = 掉线；后面是当前任务和上次心跳时间。
- **左边**：需求列表。彩色条每一格是一个任务，颜色就是它的状态。
- **中间**：选中需求的任务看板，按状态分 7 列：

  | 列 | 含义 |
  |---|---|
  | 待领取 | 等工人来领；带「接手」标记的是上一个工人掉线留下的 |
  | 进行中 | 工人正在做 |
  | 返工中 | 被打回过，工人在改 |
  | 等待答复 | 工人提了问题，等主管回答 |
  | 待 review | 工人已提交，等主管审 |
  | 已通过 | 完成 |
  | 已挂起 | 打回 3 次还不行，等主管处理 |

- **点卡片**：右边弹出详情（验收标准、描述、提交记录、完整时间线）。点抽屉外任意地方、点「关闭」或按 Esc 关闭；点另一张卡片直接切换。
- **汇报**：需求全部完成后，主管的汇报显示在需求顶部。
- 页面每 3 秒自动刷新。

---

## 四、常见情况

### 工人等了一会儿就自己停了

工人应该一直循环等任务。如果它停下来问你「要继续等吗」，对它说一句「继续」就行。

### 工人掉线、换号接手

工人超过租约时长（默认 15 分钟）没有动静，就会被判为掉线，它手上的任务退回「待领取」。以下都算动静：调用 `ateam` 命令，或者任务路径里的文件在变。

接手：换个账号开新的 WorkBuddy 窗口，说同样的话（`使用 ateam-worker skill，角色 xxx`）。新工人会收到「⚠ 接手任务」，在已有改动上继续做。

原来的工人如果其实还活着，下次调用命令会收到「租约已失效」，它会自己重新加入。

### 工人提交时报「指定路径下没有改动」

先看错误信息里的「服务的项目目录」：

- **不是你要开发的项目**：服务起错了目录。按下面「服务起错了目录」处理，工人的改动不要动。
- **是对的**：说明工人确实没在允许的路径里改文件，让主管看一下。

### 服务起错了目录

```bash
# 1. 在服务窗口按 Ctrl+C 停掉
# 2. 把状态搬到正确的项目（假设之前错起在 ~/code/agent-team）
mkdir -p ~/code/apiloop/.ateam
cp ~/code/agent-team/.ateam/state.json ~/code/apiloop/.ateam/
# 3. 在正确的目录重新启动，确认「项目目录」那一行
cd ~/code/apiloop && ateam serve
# 4. 对卡住的工人说「服务已重启，继续」
# 5. 确认没问题后删掉旧状态
rm -r ~/code/agent-team/.ateam
```

整个过程尽量在 1 分钟内完成：服务断开超过约 60 秒，工人会收到「服务不可达」并停下。如果停了，对它说「继续」即可。

### 主管会话重开了（上下文满了）

在新会话里说「使用 ateam-lead skill，继续」。它会先运行 `ateam status`，从「待你处理」列表接着做。

### 更新了 agent-team 的代码之后

- 改了 `src/` 里的服务端代码：重启 `ateam serve`。
- 改了 skill：如果是复制装的，再复制一次；工人窗口要新开才会读到新 skill。
- 只改了看板：刷新浏览器即可。

---

## 五、参数与环境变量

| 设置 | 说明 | 默认 |
|---|---|---|
| `ateam serve --port 7701` | 换端口（7700 被占用时） | `7700` |
| `ATEAM_URL` | 换了端口后，主管和工人都要设置，例如 `http://127.0.0.1:7701` | `http://127.0.0.1:7700` |
| `ateam serve --lease 5` 或 `ATEAM_LEASE_MIN` | 租约时长（分钟）：多久没动静判为掉线。测试掉线接手时可以设短一点，正常干活用默认值 | `15` |

## 六、命令速查

一般不用你手动敲命令，主管和工人会自己调用。需要排查时可以用：

```bash
ateam status        # 全局概况：项目目录、待处理事项、工人、各任务状态
ateam show T3       # 某个任务的详情和完整历史
ateam cancel T3 "原因"   # 作废任务：不再派发，看板上置灰放到最下面
ateam help          # 全部命令
```

设计细节见 [docs/superpowers/specs/2026-10-03-agent-team-design.md](docs/superpowers/specs/2026-10-03-agent-team-design.md)。
