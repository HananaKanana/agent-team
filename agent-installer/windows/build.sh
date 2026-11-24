#!/bin/bash
#
# ateam 的 Windows 安装包（ateam-<版本>-win-x64.exe），在 Mac 上打，不需要 Windows 机器（参考 apiloop 的 Windows 安装包）：
#   - node：nodejs.org 官方的 win-x64 zip（npmmirror 镜像），按 SHASUMS256 校验，只取 node.exe；
#   - ateam：和 Mac 包同一份源码（零依赖，原样复制）；
#   - 托盘程序 ateam.exe 和安装程序：C# / .NET Framework 4.8，用 dotnet SDK 交叉编译。
#
# 装到 %LOCALAPPDATA%\Programs\ateam，不需要管理员权限；安装包不签名，第一次运行时 Windows 会提示
# 「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」。
#
# 用法：bash agent-installer/windows/build.sh
# 产物：agent-installer/dist/ateam-<版本>-win-x64.exe（不入库）

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORK="${ATEAM_WIN_BUILD_DIR:-/tmp/ateam-win-build}"
DIST="$REPO/agent-installer/dist"
NODE_VERSION="${NODE_VERSION:-v24.21.0}"
NODE_MIRROR="${NODE_MIRROR:-https://npmmirror.com/mirrors/node}"

log() { printf '\n===== %s =====\n' "$*"; }
die() { printf 'windows/build.sh: %s\n' "$*" >&2; exit 1; }

for tool in curl shasum awk unzip zip dotnet node swiftc sips python3 file; do
    command -v "$tool" >/dev/null 2>&1 || die "缺少工具：$tool"
done

VERSION="$(node -p "require('$REPO/package.json').version")"
[ -n "$VERSION" ] || die "读不出 package.json 里的版本号"
OUT_NAME="ateam-${VERSION}-win-x64.exe"
mkdir -p "$WORK/cache" "$DIST"

log "目标"
printf '  版本      %s\n  Node      %s（win-x64，镜像：%s）\n  工作目录  %s\n  产物      %s\n' "$VERSION" "$NODE_VERSION" "$NODE_MIRROR" "$WORK" "$OUT_NAME"

# ---------------------------------------------------------------- 1. 官方 node.exe

ZIP_NAME="node-${NODE_VERSION}-win-x64.zip"
BASE_URL="$NODE_MIRROR/$NODE_VERSION"
NODE_ZIP="$WORK/cache/$ZIP_NAME"
SHASUMS="$WORK/cache/SHASUMS256-${NODE_VERSION}.txt"
if [ ! -f "$SHASUMS" ]; then
    log "下载 $BASE_URL/SHASUMS256.txt"
    curl -fL --retry 3 --connect-timeout 20 -o "$SHASUMS.part" "$BASE_URL/SHASUMS256.txt"
    mv "$SHASUMS.part" "$SHASUMS"
fi
EXPECTED="$(awk -v f="$ZIP_NAME" '$2 == f { print $1 }' "$SHASUMS")"
[ -n "$EXPECTED" ] || die "$SHASUMS 里没有 ${ZIP_NAME}"
if [ ! -f "$NODE_ZIP" ]; then
    log "下载 $BASE_URL/$ZIP_NAME"
    curl -fL --retry 3 --connect-timeout 20 -o "$NODE_ZIP.part" "$BASE_URL/$ZIP_NAME"
    mv "$NODE_ZIP.part" "$NODE_ZIP"
fi
log "校验 node 的 sha256"
ACTUAL="$(shasum -a 256 "$NODE_ZIP" | awk '{print $1}')"
[ "$EXPECTED" = "$ACTUAL" ] || die "sha256 不匹配：期望 ${EXPECTED}，实际 ${ACTUAL}。删掉 $NODE_ZIP 再试"
printf '  %s  %s\n' "$ACTUAL" "$ZIP_NAME"
rm -f "$WORK/node.exe" "$WORK/LICENSE"
unzip -o -j -q "$NODE_ZIP" "node-${NODE_VERSION}-win-x64/node.exe" "node-${NODE_VERSION}-win-x64/LICENSE" -d "$WORK"
[ -f "$WORK/node.exe" ] || die "zip 里没有 node.exe"

# ---------------------------------------------------------------- 2. 图标（和 Mac 同一张图）

log "画图标 ateam.ico"
ICON_DIR="$WORK/icon"
rm -rf "$ICON_DIR"
mkdir -p "$ICON_DIR"
swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos12.0" -framework AppKit \
    "$REPO/agent-installer/mac/menubar/make-icon.swift" -o "$ICON_DIR/make-icon"
"$ICON_DIR/make-icon" "$ICON_DIR/icon-1024.png" >/dev/null
for size in 16 20 24 32 40 48 64 128 256; do
    sips -z "$size" "$size" "$ICON_DIR/icon-1024.png" --out "$ICON_DIR/icon-$size.png" >/dev/null
done
# .ico 就是一个目录头 + 若干张 PNG（Vista 起支持 PNG 条目）
python3 - "$ICON_DIR" <<'PY'
import struct, sys, os
d = sys.argv[1]
sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
images = [open(os.path.join(d, 'icon-%d.png' % s), 'rb').read() for s in sizes]
offset = 6 + 16 * len(sizes)
out = struct.pack('<HHH', 0, 1, len(sizes))
for size, data in zip(sizes, images):
    dim = 0 if size == 256 else size
    out += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(data), offset)
    offset += len(data)
open(os.path.join(d, 'ateam.ico'), 'wb').write(out + b''.join(images))
PY
ICON="$ICON_DIR/ateam.ico"

# ---------------------------------------------------------------- 3. 托盘程序 ateam.exe

log "编译托盘程序 ateam.exe"
TRAY_OUT="$WORK/tray-out"
rm -rf "$TRAY_OUT"
dotnet build "$HERE/tray/ateam.csproj" -c Release -nologo -v quiet \
    -p:Version="$VERSION" -p:AteamIcon="$ICON" -p:AteamNodeVersion="$NODE_VERSION" -o "$TRAY_OUT"
[ -f "$TRAY_OUT/ateam.exe" ] || die "没编出 ateam.exe"

# ---------------------------------------------------------------- 4. 载荷：安装后的目录

log "搭出安装后的目录（payload.zip）"
PAYLOAD="$WORK/payload"
rm -rf "$PAYLOAD"
mkdir -p "$PAYLOAD/node/$NODE_VERSION" "$PAYLOAD/app"
cp "$WORK/node.exe" "$PAYLOAD/node/$NODE_VERSION/node.exe"
cp "$WORK/LICENSE" "$PAYLOAD/node/$NODE_VERSION/LICENSE"
# ateam 零依赖：直接复制源码。只放运行要用的（docs/ 是给维护者看的）
for d in bin src skills dsh-plugin; do cp -R "$REPO/$d" "$PAYLOAD/app/$d"; done
cp "$REPO/package.json" "$REPO/README.md" "$PAYLOAD/app/"
find "$PAYLOAD/app" -name '.DS_Store' -delete
cp "$TRAY_OUT/ateam.exe" "$TRAY_OUT/ateam.exe.config" "$PAYLOAD/"
# ateam 命令（ateam.cmd，等同 Mac 的 /usr/local/bin/ateam）：node 的版本目录写死在里面；换成 CRLF，cmd 对 LF 的批处理文件偶尔会解析错。
# ateam.cmd 只能写英文：cmd 按系统代码页（中文系统是 GBK）读批处理，UTF-8 中文会把解析搞乱
sed "s/@NODE_VERSION@/$NODE_VERSION/g" "$HERE/ateam.cmd" | sed 's/$/\r/' > "$PAYLOAD/ateam.cmd"
PAYLOAD_ZIP="$WORK/payload.zip"
rm -f "$PAYLOAD_ZIP"
( cd "$PAYLOAD" && zip -qr -X "$PAYLOAD_ZIP" . )
printf '  payload.zip %s 字节\n' "$(wc -c < "$PAYLOAD_ZIP" | tr -d ' ')"

# ---------------------------------------------------------------- 5. 安装程序

log "编译安装程序"
SETUP_OUT="$WORK/setup-out"
rm -rf "$SETUP_OUT"
dotnet build "$HERE/setup/setup.csproj" -c Release -nologo -v quiet \
    -p:Version="$VERSION" -p:AteamIcon="$ICON" -p:AteamPayload="$PAYLOAD_ZIP" -o "$SETUP_OUT"
[ -f "$SETUP_OUT/ateam-setup.exe" ] || die "没编出安装程序"
cp "$SETUP_OUT/ateam-setup.exe" "$DIST/$OUT_NAME"

# ---------------------------------------------------------------- 6. 核对

log "核对"
case "$(file "$DIST/$OUT_NAME")" in
    *PE32+*x86-64*) echo "  ✓ 是 64 位 Windows 程序" ;;
    *) die "产物不是 64 位 Windows 程序：$(file "$DIST/$OUT_NAME")" ;;
esac
for need in "node/$NODE_VERSION/node.exe" ateam.exe ateam.exe.config ateam.cmd app/bin/ateam.js app/src/server.js app/src/dashboard.html \
            app/skills/ateam-worker/SKILL.md app/skills/ateam-lead/SKILL.md app/dsh-plugin/index.js app/package.json; do
    unzip -l "$PAYLOAD_ZIP" "$need" >/dev/null 2>&1 || die "payload.zip 里缺 $need"
    printf '  ✓ %s\n' "$need"
done
unzip -p "$PAYLOAD_ZIP" app/package.json | grep -q "\"version\": \"$VERSION\"" && echo "  ✓ 版本 $VERSION"
unzip -p "$PAYLOAD_ZIP" ateam.cmd | grep -q "node\\\\$NODE_VERSION\\\\node.exe" && echo "  ✓ ateam.cmd 指向 node\\$NODE_VERSION\\node.exe"

log "完成"
printf '  %s（%s 字节）\n' "$DIST/$OUT_NAME" "$(wc -c < "$DIST/$OUT_NAME" | tr -d ' ')"
echo
echo "安装包不签名：第一次运行时点「更多信息 → 仍要运行」。拿到 Windows 10 / 11 上双击安装。"
