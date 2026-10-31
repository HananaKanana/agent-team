# 让 worker 干活中途就看到留言（工具后 hook）

默认情况下，看板留言和 `ateam note`、`ateam task edit` 的通知，要等 worker 下一次调用 ateam 才送达。启用这个 hook 后，worker 每完成一次工具调用，就会收到待送达的内容。

不启用也能正常工作，只是送达更晚。

`ateam hook post-tool` 不绑定具体平台：它从 stdin 读 `session_id`、`tool_name`、`tool_input`，向 stdout 输出 `hookSpecificOutput.additionalContext`。平台只要支持这种 Claude Code 格式的 PostToolUse command hook，就能使用。

| 平台 | 状态 |
|---|---|
| DeepSeek Harness | 桥接包的代码和文档确认支持；未实际运行 |
| WorkBuddy | 支持 PostToolUse；`additionalContext` 是否进入模型上下文未确认 |

## 启用：DeepSeek Harness

适用于 DeepSeek Harness 0.2.1-rc.5。hook 包必须和已安装的 DSH 版本完全一致，版本号在应用的「关于」里查看。

1. 安装桥接包，在 `~/.dsh/profiles/desktop` 下运行：

   ```bash
   pnpm add @deepseek-ai/dsh-hooks-claude-code@0.2.1-rc.5 @deepseek-ai/dsh-hook-protocol@0.2.1-rc.5
   ```

2. 新建 `~/.dsh/profiles/desktop/ateam-hooks.json`，`command` 写 `command -v ateam` 查到的绝对路径：

   ```json
   {
     "hooks": {
       "PostToolUse": [
         { "hooks": [{ "type": "command", "command": "/绝对路径/ateam hook post-tool", "timeout": 5 }] }
       ]
     }
   }
   ```

3. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾追加，`configPath` 写绝对路径：

   ```yaml
   - name: '@deepseek-ai/dsh-hooks-claude-code'
     config:
       configPath: /绝对路径/.dsh/profiles/desktop/ateam-hooks.json
   ```

4. 重启 DeepSeek Harness。配置只在启动时读取一次。

## 启用：WorkBuddy

在 `<项目>/.codebuddy/settings.json`（只对这个项目生效）或 `~/.workbuddy/settings.json` 的 `hooks` 里，给 `PostToolUse` 加一条和上面相同的配置。已有的条目不要改。改完重启会话，或在 `/hooks` 面板里确认。

启用后先留言试一次，确认 worker 确实看到「# ateam 补充说明」。如果看不到，说明 WorkBuddy 不接受 `additionalContext`，留言已被取走、不会再送达，应停用这条 hook。

## 其他平台

配置一条 PostToolUse command hook，运行 `ateam hook post-tool`。工具名需要包含 bash、shell、exec、command 或 terminal 之一，否则认不出 worker 编号。

## 工作方式

- 平台在每次工具调用后运行 `ateam hook post-tool`，内容以「# ateam 补充说明」的形式附加到 worker 的上下文。
- 同一目录下有多个 worker 时，服务根据 worker 运行的 `ateam ... --as <编号>` 命令，记住会话对应的编号。服务重启后，worker 下一次调用 ateam 时重新记住。
- 目录下没有 `.ateam/port` 时，hook 不发请求，直接退出。服务不可达时同样安静退出，不影响 worker。

## 局限

- 只在工具调用结束后送达。worker 卡在一条长命令里时，要等这条命令结束。
- worker 刚加入、还没运行过带 `--as` 的命令时收不到。worker 加入后会马上运行 `ateam wait --as`，实际不受影响。
- 目前只送达补充说明。任务作废和打回仍在 worker 下一次调用 ateam 时送达。

## 停用

删除上面加的配置，重启对应的平台。
