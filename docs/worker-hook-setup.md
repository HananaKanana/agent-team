# 让 worker 干活中途就看到留言（工具后 hook）

默认情况下，看板留言和 `ateam note`、`ateam task edit` 的通知，要等 worker 下一次调用 ateam 才送达。启用这个 hook 后，worker 每完成一次工具调用，就会收到待送达的内容。

不启用也能正常工作，只是送达更晚。启用后，留言仍保留到 worker 下一次调用 ateam，所以 hook 没生效时也不会丢，代价是生效时 worker 会多看到一遍。

`ateam hook post-tool` 不绑定具体平台：它从 stdin 读 `session_id`、`tool_name`、`tool_input`，向 stdout 输出 `hookSpecificOutput.additionalContext`。平台只要支持这种 Claude Code 格式的 PostToolUse command hook，就能使用。

| 平台 | 状态 |
|---|---|
| DeepSeek Harness | 桥接包的代码和文档确认支持 |
| WorkBuddy | 引擎代码确认支持，日志确认 hook 会运行；留言注入还没有实际跑过 |

等待时的送达不靠这个 hook：`ateam wait` 挂着时，有消息会马上返回。后台长等待见 `skills/ateam-worker/SKILL.md` 的「运行命令的规则」。

## 启用

worker 加入团队时会自动运行下面的命令，通常不用手工操作：

```bash
ateam hook install --platform dsh        # 或 --platform workbuddy
```

命令可以重复运行。如果 agent 平台的权限模式只允许写项目目录，worker 自己装不上，会请你在终端里运行这条命令。改动内容：

- **DeepSeek Harness：** 在 profile 目录安装和应用版本一致的桥接包，写入 `ateam-hooks.json`，并在 `cordis.patch.yml` 追加一段带标记的配置。DSH 会自动重新加载这个文件，实测约 25 秒内对运行中的会话生效，不用重启。如果一直不生效（会话日志里没有 `hook/invoked`），再在菜单中点击「Restart App and Host」。重启会打断所有会话，由用户选择时机。DSH 升级后重新运行一次。
- **WorkBuddy：** 在 `~/.workbuddy/settings.json`（没有则用 `~/.codebuddy/settings.json`）的 `PostToolUse` 追加一条，已有条目不变。之后重启会话，或在 `/hooks` 面板确认。

修改前会把原文件备份为 `<文件名>.bak.ateam`。

启用后先留言试一次，确认 worker 看到「# ateam 补充说明」。

## 其他平台

配置一条 PostToolUse command hook，运行 `ateam hook post-tool`。工具名需要包含 bash、shell、exec、command 或 terminal 之一，否则认不出 worker 编号。

## 工作方式

- 平台在每次工具调用后运行 `ateam hook post-tool`，内容以「# ateam 补充说明」的形式附加到 worker 的上下文。
- 同一目录下有多个 worker 时，服务根据 worker 运行的 `ateam ... --as <编号>` 命令，记住会话对应的编号。这个对应关系会保存到磁盘，服务重启后不会丢。
- 目录下没有 `.ateam/port` 时，hook 不发请求，直接退出。服务不可达时同样安静退出，不影响 worker。

此外还有一条读后台输出之前的 hook：worker 的 `ateam wait` 还在挂着时，拦下 `job_output` / `TaskOutput`，并让它结束本轮，避免它一直占着一轮消耗 token。wait 结束后不拦。

## 局限

- 只在工具调用结束后送达。worker 卡在一条长命令里时，要等这条命令结束。
- worker 刚加入、还没运行过带 `--as` 的命令时收不到。worker 加入后会马上运行 `ateam wait --as`，实际不受影响。
- 目前只送达补充说明。任务作废和打回仍在 worker 下一次调用 ateam 时送达。

## 停用

```bash
ateam hook uninstall --platform dsh        # 或 --platform workbuddy
```

DeepSeek Harness 通常自动生效；WorkBuddy 需要重启会话。
