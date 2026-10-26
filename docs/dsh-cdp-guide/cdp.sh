#!/usr/bin/env bash
# cdp.sh — dsh-cdp 的薄封装，避免每次手写 curl + JSON。
#
# 用法：
#   ./cdp.sh <cmd> ['<json>']          例：
#   ./cdp.sh status
#   ./cdp.sh tabs
#   ./cdp.sh open '{"url":"https://example.com"}'
#   ./cdp.sh eval '{"tabId":"ABC","expression":"document.title"}'
#   ./cdp.sh shot '{"tabId":"ABC","fullPage":true}'
#
#   ./cdp.sh open-url https://example.com          # 开新页并只打印 tabId
#   ./cdp.sh refs     <tabId>                      # 打印 aria 快照里每个 ref 一行
#   ./cdp.sh find-ref <tabId> <关键词>             # 从 aria 快照里找 ref（按角色/名字匹配）
#   ./cdp.sh close-all                             # 关掉所有本会话开的页
#
# 依赖：curl、python3（仅用于取字段，不用装额外包）
set -euo pipefail

: "${DSH_WEB_URL:?DSH_WEB_URL is not set — run this from a DSH session shell}"
U="$DSH_WEB_URL/api/dsh-cdp"
CT='Content-Type: application/json'

# 一行取 JSON 字段：jget <json> <python表达式，d 是解析后的对象>
jget() {
  python3 -c 'import json,sys;d=json.load(sys.stdin);print(eval(sys.argv[1]))' "$2" <<<"$1"
}

# 发一条命令。成功打印 body；失败打印 body 到 stderr 并以 1 退出。
call() {
  local cmd="$1" body="${2:-}"
  [[ -z "$body" ]] && body='{}'
  local out http
  # 409 是 awaiting-approval，需要读 body 才知道，所以分开取状态码
  out=$(curl -s -w $'\n%{http_code}' -X POST "$U?cmd=$cmd" -H "$CT" -d "$body")
  http="${out##*$'\n'}"
  out="${out%$'\n'*}"
  if [[ "$http" == "409" ]]; then
    echo "BLOCKED: 浏览器等待授权 —— 切到浏览器窗口点 Allow，然后重试一次" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
  if [[ "$(jget "$out" "d.get('ok')" 2>/dev/null || echo False)" != "True" ]]; then
    printf '%s\n' "$out" >&2
    return 1
  fi
  printf '%s\n' "$out"
}

case "${1:-status}" in
  open-url)
    call open "$(python3 -c 'import json,sys;print(json.dumps({"url":sys.argv[1],"settleMs":1500}))' "${2:?url required}")" \
      | jget "$(cat)" "d['id']"
    ;;
  refs)
    tab="${2:?tabId required}"
    call snapshot "$(printf '{"tabId":"%s","aria":true,"limit":400}' "$tab")" \
      | python3 -c '
import json,sys
d=json.load(sys.stdin)
for line in d.get("tree","").split("\n"):
    if "[ref=" in line:
        print(line.strip())
'
    ;;
  find-ref)
    tab="${2:?tabId required}"; needle="${3:?keyword required}"
    call snapshot "$(printf '{"tabId":"%s","aria":true,"limit":400}' "$tab")" \
      | NEEDLE="$needle" python3 -c '
import json,os,re,sys
needle=os.environ["NEEDLE"].lower()
d=json.load(sys.stdin)
hits=[]
for line in d.get("tree","").split("\n"):
    m=re.search(r"\[ref=(e\d+)\]",line)
    if m and needle in line.lower():
        hits.append((m.group(1),line.strip()))
if not hits:
    sys.exit(1)
for ref,line in hits:
    # print 的多参数会插入空格，调用方 cut -f1 会带上尾随空格；显式拼串保证第一列干净。
    print(ref + "\t" + line)
'
    ;;
  close-all)
    call tabs | python3 -c '
import json,sys
for p in json.load(sys.stdin).get("pages",[]):
    if p.get("owned"): print(p["id"])
' | while read -r id; do
      [[ -n "$id" ]] && call close "$(printf '{"tabId":"%s"}' "$id")" >/dev/null && echo "closed $id"
    done
    ;;
  *)
    call "${1:-status}" "${2:-}"
    ;;
esac
