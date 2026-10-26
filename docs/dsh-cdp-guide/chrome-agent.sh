#!/usr/bin/env bash
# chrome-agent.sh — 用独立 profile 启动一个「给 agent 用的」Chrome。
#
# 存在意义：Chrome 136+ 对默认 profile 开远程调试时，每次新建连接都会弹
# 「要允许远程调试吗？」，必须手点。用非默认的 --user-data-dir 之后，
# 这个弹窗再也不会出现（实测 Chrome 155，重启后也不弹）。
#
# 默认用 --remote-debugging-port=0，让 Chrome 自己挑空闲端口并写
# DevToolsActivePort 到 profile 目录。这样既不会和你主 Chrome 抢 9222，
# 也让 dsh-cdp 能通过 dataDir 配置精确找到它。
#
# 用法：
#   ./chrome-agent.sh                 # 启动（profile 默认 ~/.chrome-agent）
#   ./chrome-agent.sh --status        # 只看状态
#   ./chrome-agent.sh --dir ~/myprof  # 换 profile 目录
#   ./chrome-agent.sh --port 9333     # 固定端口（默认 0 = 自动挑选）
#   ./chrome-agent.sh --reset         # 删掉 profile 目录再启动（登录态会丢）
#
# 后三个 --disable-* 参数让这个窗口不在最前面、被别的窗口挡住时照常渲染、
# 定时器不降速。agent 就不用把它拉到前台（拉到前台会抢走用户的焦点）。
#
# 配套的 dsh-cdp 配置（一次性，改完重启 DSH）：
#   - id: dsh-cdp
#     name: '@dougen/dsh-cdp'
#     config:
#       dataDir: ~/.chrome-agent
set -euo pipefail

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROFILE_DIR="${HOME}/.chrome-agent"
PORT=0
RESET=0
STATUS_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)   PORT="${2:?--port needs a value}"; shift 2 ;;
    --dir)    PROFILE_DIR="${2:?--dir needs a value}"; shift 2 ;;
    --reset)  RESET=1; shift ;;
    --status) STATUS_ONLY=1; shift ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ -x "$CHROME" ]] || { echo "Chrome not found at $CHROME" >&2; exit 1; }

# 从 profile 目录里的 DevToolsActivePort 读出 Chrome 挑的端口。
active_port() {
  [[ -f "$PROFILE_DIR/DevToolsActivePort" ]] || return 1
  head -1 "$PROFILE_DIR/DevToolsActivePort"
}

cdp_alive() {
  local port
  port="$(active_port)" || return 1
  [[ -n "$port" ]] || return 1
  curl -s -H "Host: localhost:${port}" --max-time 2 \
    "http://127.0.0.1:${port}/json/version" 2>/dev/null | grep -q '"Browser"'
}

if [[ "$STATUS_ONLY" == "1" ]]; then
  if cdp_alive; then
    port="$(active_port)"
    echo "running: CDP on 127.0.0.1:${port}"
    curl -s -H "Host: localhost:${port}" --max-time 2 "http://127.0.0.1:${port}/json/version" \
      | python3 -c 'import json,sys;print("  browser:",json.load(sys.stdin)["Browser"])' 2>/dev/null || true
    exit 0
  fi
  echo "not running"
  if [[ -d "$PROFILE_DIR" ]]; then echo "profile exists: $PROFILE_DIR"; else echo "profile not created yet: $PROFILE_DIR"; fi
  exit 1
fi

if cdp_alive; then
  echo "already running: CDP on 127.0.0.1:$(active_port) — 不会再起第二个"
  exit 0
fi

if [[ "$RESET" == "1" ]]; then
  # 目录被另一个实例占用时删除会出问题，先确认没有活着的进程在用它。
  if pgrep -f "user-data-dir=$PROFILE_DIR" >/dev/null 2>&1; then
    echo "refusing to --reset: a Chrome is still using $PROFILE_DIR" >&2
    echo "quit that window first, then retry." >&2
    exit 1
  fi
  echo "removing profile dir: $PROFILE_DIR"
  rm -rf "$PROFILE_DIR"
fi

mkdir -p "$PROFILE_DIR"

echo "starting Chrome"
echo "  profile: $PROFILE_DIR"
echo "  CDP:     127.0.0.1:<auto>  (--remote-debugging-port=${PORT})"
echo "  在这个窗口里登录一次，之后 agent 一直能用这些登录态。"

nohup "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling \
  >"$PROFILE_DIR/chrome.log" 2>&1 &

for i in $(seq 1 20); do
  sleep 1
  if cdp_alive; then
    echo "ready in ${i}s on 127.0.0.1:$(active_port) — 没有出现授权弹窗"
    exit 0
  fi
done

echo "Chrome 起了但 20 秒内读不到可用的 CDP。" >&2
echo "  DevToolsActivePort: $PROFILE_DIR/DevToolsActivePort" >&2
echo "  日志: $PROFILE_DIR/chrome.log" >&2
exit 1
