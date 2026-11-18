#!/bin/bash
#
# ateam Mac 安装包（.pkg），arm64 与 x64 各一个。参考 ~/code/apiloop/agent-installer/mac/build.sh。
#
# 安装包里带一份官方 Node：同事电脑上不一定有 Node；而且 macOS 15 起没有苹果签名的程序访问局域网会被
# 直接拒绝、不弹授权框，ateam 默认对局域网开放看板，要用签名完好的官方 Node。所以：
#   1. node 来自 nodejs.org（这里用国内镜像下同一份文件），核对 sha256；
#   2. 任何一步都不对它重新签名（全程不对 node 用 codesign，pkgbuild / productbuild 都不带 --sign）；
#   3. 打完包展开核对：node 的 TeamIdentifier 是 HX7739G8FX，和下载的那份逐字节相同。
#
# 用法：bash agent-installer/mac/build.sh               （arm64）
#       NODE_ARCH=x64 bash agent-installer/mac/build.sh （Intel）
#       bash agent-installer/mac/build-all.sh           （两个都打）
# 产物：agent-installer/dist/ateam-<版本>-<架构>.pkg（不入库）
#
# 变量后面紧跟中文时一律写 ${VAR}：某些 locale 下 bash 会把后面的高位字节算进变量名。

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

NODE_VERSION="${NODE_VERSION:-v24.21.0}"
NODE_ARCH="${NODE_ARCH:-arm64}"
NODE_MIRROR="${NODE_MIRROR:-https://npmmirror.com/mirrors/node}"
NODE_TEAM_ID="HX7739G8FX"
PKG_ID="com.ateam.pkg"
MENU_ID="com.ateam.menubar"
MIN_MACOS="12.0"

case "$NODE_ARCH" in
    arm64) PKG_ARCH="arm64" ;;
    x64) PKG_ARCH="x86_64" ;;
    *) printf 'build.sh: NODE_ARCH 只能是 arm64 或 x64，收到 %s\n' "$NODE_ARCH" >&2; exit 1 ;;
esac

# 中间产物放在仓库外（node 解压后八千多个文件）。两种架构共用 ${WORK}，子目录带架构后缀
WORK="${ATEAM_BUILD_WORK:-/tmp/ateam-build}"
DIST="$REPO/agent-installer/dist"

log() { printf '\n===== %s =====\n' "$*"; }
die() { printf 'build.sh: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "只能在 macOS 上打包"
for tool in curl tar shasum awk pkgbuild productbuild pkgutil codesign swiftc sips iconutil lipo ditto plutil node; do
    command -v "$tool" >/dev/null 2>&1 || die "缺少工具：$tool"
done

VERSION="$(node -p "require('$REPO/package.json').version")"
[ -n "$VERSION" ] || die "读不出 package.json 里的版本号"
mkdir -p "$WORK/cache" "$DIST"

log "目标"
printf '  版本  %s\n  架构  %s（%s）\n  Node  %s（%s）\n  工作目录  %s\n' "$VERSION" "$NODE_ARCH" "$PKG_ARCH" "$NODE_VERSION" "$NODE_MIRROR" "$WORK"

# ---------------------------------------------------------------- 1. 官方 node

TARBALL_NAME="node-${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz"
BASE_URL="$NODE_MIRROR/$NODE_VERSION"
TARBALL="$WORK/cache/$TARBALL_NAME"
SHASUMS="$WORK/cache/SHASUMS256-${NODE_VERSION}.txt"

if [ ! -f "$SHASUMS" ]; then
    log "下载 $BASE_URL/SHASUMS256.txt"
    curl -fL --retry 3 --connect-timeout 20 -o "$SHASUMS.part" "$BASE_URL/SHASUMS256.txt"
    mv "$SHASUMS.part" "$SHASUMS"
fi
EXPECTED="$(awk -v f="$TARBALL_NAME" '$2 == f { print $1 }' "$SHASUMS")"
[ -n "$EXPECTED" ] || die "$SHASUMS 里没有 ${TARBALL_NAME}"
if [ ! -f "$TARBALL" ]; then
    log "下载 $BASE_URL/$TARBALL_NAME"
    curl -fL --retry 3 --connect-timeout 20 -o "$TARBALL.part" "$BASE_URL/$TARBALL_NAME"
    mv "$TARBALL.part" "$TARBALL"
fi
log "校验 node 的 sha256"
ACTUAL="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
[ "$EXPECTED" = "$ACTUAL" ] || die "sha256 不匹配：期望 ${EXPECTED}，实际 ${ACTUAL}。删掉 $TARBALL 再试"
printf '  %s  %s\n' "$ACTUAL" "$TARBALL_NAME"

NODE_DIR="$WORK/node-$NODE_ARCH"
MARKER="$NODE_DIR/.ateam-node-version"
if [ ! -f "$MARKER" ] || [ "$(cat "$MARKER")" != "$NODE_VERSION" ]; then
    log "解出 node（原样解压，不碰签名）"
    rm -rf "$NODE_DIR"
    mkdir -p "$NODE_DIR"
    tar -xzf "$TARBALL" -C "$NODE_DIR" --strip-components=1
    printf '%s\n' "$NODE_VERSION" > "$MARKER"
fi
[ -x "$NODE_DIR/bin/node" ] || die "解压后没有 bin/node"

# ---------------------------------------------------------------- 2. 安装后的目录树

log "搭出安装后的目录树"
ROOT="$WORK/root-$NODE_ARCH"
rm -rf "$ROOT"
BASE_DIR="$ROOT/Library/Application Support/ateam"
mkdir -p "$BASE_DIR/app" "$ROOT/usr/local/bin" "$ROOT/Applications"
# node 只要运行需要的部分（bin/node）和许可证；npm、头文件不要
mkdir -p "$BASE_DIR/node/bin"
ditto "$NODE_DIR/bin/node" "$BASE_DIR/node/bin/node"
cp "$NODE_DIR/LICENSE" "$BASE_DIR/node/LICENSE"
# ateam 零依赖：直接复制源码
# 只放运行要用的：docs/ 是给维护者看的设计记录和核对清单，运行时不读
for d in bin src skills dsh-plugin; do ditto "$REPO/$d" "$BASE_DIR/app/$d"; done
cp "$REPO/package.json" "$REPO/README.md" "$BASE_DIR/app/"
cp "$HERE/ateam" "$ROOT/usr/local/bin/ateam"
cp "$HERE/uninstall.command" "$BASE_DIR/卸载 ateam.command"
chmod 755 "$ROOT/usr/local/bin/ateam" "$BASE_DIR/卸载 ateam.command" "$BASE_DIR/app/bin/ateam.js"

# ---------------------------------------------------------------- 3. 菜单栏程序

log "编译菜单栏程序 /Applications/ateam.app"
MENU_APP="$ROOT/Applications/ateam.app"
mkdir -p "$MENU_APP/Contents/MacOS" "$MENU_APP/Contents/Resources"
SWIFT_TARGET="${PKG_ARCH}-apple-macos${MIN_MACOS}"
# -disable-autolinking-runtime-compatibility：命令行工具里的 Swift 兼容库只有 arm64，交叉编译 x86_64 时会链接失败；
# 最低系统 12.0 本来就不需要这些兼容库
swiftc -O -swift-version 5 -target "$SWIFT_TARGET" -Xfrontend -disable-autolinking-runtime-compatibility -framework AppKit -framework IOKit \
    "$HERE/menubar/main.swift" -o "$MENU_APP/Contents/MacOS/ateam"
cat > "$MENU_APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key><string>${MENU_ID}</string>
    <key>CFBundleExecutable</key><string>ateam</string>
    <key>CFBundleName</key><string>ateam</string>
    <key>CFBundleDisplayName</key><string>ateam</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
    <key>CFBundleShortVersionString</key><string>${VERSION}</string>
    <key>CFBundleVersion</key><string>${VERSION}</string>
    <key>CFBundleIconFile</key><string>ateam</string>
    <key>LSMinimumSystemVersion</key><string>${MIN_MACOS}</string>
    <!-- 只在菜单栏显示，不出现在 Dock -->
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
    <!-- 只连本机的 ateam 服务（http://127.0.0.1） -->
    <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST
plutil -lint "$MENU_APP/Contents/Info.plist" >/dev/null || die "Info.plist 不合法"

log "画图标"
ICON_DIR="$WORK/icon"
rm -rf "$ICON_DIR"
mkdir -p "$ICON_DIR/ateam.iconset"
swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos${MIN_MACOS}" -framework AppKit "$HERE/menubar/make-icon.swift" -o "$ICON_DIR/make-icon"
"$ICON_DIR/make-icon" "$ICON_DIR/icon-1024.png"
for spec in 16:icon_16x16 32:icon_16x16@2x 32:icon_32x32 64:icon_32x32@2x 128:icon_128x128 256:icon_128x128@2x 256:icon_256x256 512:icon_256x256@2x 512:icon_512x512 1024:icon_512x512@2x; do
    sips -z "${spec%%:*}" "${spec%%:*}" "$ICON_DIR/icon-1024.png" --out "$ICON_DIR/ateam.iconset/${spec##*:}.png" >/dev/null
done
iconutil -c icns "$ICON_DIR/ateam.iconset" -o "$MENU_APP/Contents/Resources/ateam.icns"

# 菜单栏程序用 ad-hoc 签名（不是 node，node 不碰）
codesign --force --sign - "$MENU_APP"
chmod -R a+rX "$ROOT"

# ---------------------------------------------------------------- 4. 打包

log "pkgbuild"
SCRIPTS="$WORK/scripts-$NODE_ARCH"
rm -rf "$SCRIPTS"
mkdir -p "$SCRIPTS"
cp "$HERE/scripts/preinstall" "$HERE/scripts/postinstall" "$SCRIPTS/"
chmod 755 "$SCRIPTS/preinstall" "$SCRIPTS/postinstall"
COMPONENT_PLIST="$WORK/component-$NODE_ARCH.plist"
cat > "$COMPONENT_PLIST" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
    <dict>
        <key>BundleHasStrictIdentifier</key><false/>
        <key>BundleIsRelocatable</key><false/>
        <key>BundleIsVersionChecked</key><false/>
        <key>BundleOverwriteAction</key><string>upgrade</string>
        <key>RootRelativeBundlePath</key><string>Applications/ateam.app</string>
    </dict>
</array>
</plist>
XML
COMPONENT_DIR="$WORK/component-$NODE_ARCH"
rm -rf "$COMPONENT_DIR"
mkdir -p "$COMPONENT_DIR"
pkgbuild --root "$ROOT" --identifier "$PKG_ID" --version "$VERSION" --install-location / \
    --scripts "$SCRIPTS" --component-plist "$COMPONENT_PLIST" "$COMPONENT_DIR/ateam-component.pkg"

log "productbuild"
if [ "$NODE_ARCH" = "arm64" ]; then
    WANTS_ARM="true"
    WRONG_MSG="这是 Apple 芯片（M 系列）的安装包，这台 Mac 是 Intel 芯片，请下载 x64 的安装包。"
else
    WANTS_ARM="false"
    WRONG_MSG="这是 Intel 芯片的安装包，这台 Mac 是 Apple 芯片（M 系列），请下载 arm64 的安装包。"
fi
DIST_XML="$WORK/distribution-$NODE_ARCH.xml"
cat > "$DIST_XML" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="1">
    <title>ateam ${VERSION}</title>
    <organization>com.ateam</organization>
    <domains enable_localSystem="true" enable_anywhere="false" enable_currentUserHome="false"/>
    <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
    <installation-check script="ateamCheckChip()"/>
    <script>
    function ateamCheckChip() {
        var silicon = false;
        try {
            var raw = system.sysctl('hw.optional.arm64');
            if (raw === 1 || raw === '1') { silicon = true; }
        } catch (err) {
            silicon = false;
        }
        if (${WANTS_ARM} === silicon) { return true; }
        my.result.type = 'Fatal';
        my.result.title = '芯片类型不对';
        my.result.message = '${WRONG_MSG}';
        return false;
    }
    </script>
    <choices-outline>
        <line choice="default"><line choice="${PKG_ID}"/></line>
    </choices-outline>
    <choice id="default"/>
    <choice id="${PKG_ID}" visible="false"><pkg-ref id="${PKG_ID}"/></choice>
    <pkg-ref id="${PKG_ID}" version="${VERSION}" onConclusion="none">ateam-component.pkg</pkg-ref>
</installer-gui-script>
XML
OUT="$DIST/ateam-${VERSION}-${NODE_ARCH}.pkg"
rm -f "$OUT"
productbuild --distribution "$DIST_XML" --package-path "$COMPONENT_DIR" "$OUT"

# ---------------------------------------------------------------- 5. 核对

log "展开安装包核对"
VERIFY="$WORK/verify-$NODE_ARCH"
rm -rf "$VERIFY"
mkdir -p "$VERIFY"
pkgutil --expand-full "$OUT" "$VERIFY/expanded"
PAYLOAD="$(find "$VERIFY/expanded" -type d -name Payload | head -1)"
[ -n "$PAYLOAD" ] || die "安装包里找不到 Payload"

PACKED_NODE="$PAYLOAD/Library/Application Support/ateam/node/bin/node"
[ -f "$PACKED_NODE" ] || die "安装包里没有 node"
case "$(file -b "$PACKED_NODE")" in *"$PKG_ARCH"*) echo "  ✓ node 架构 $PKG_ARCH" ;; *) die "node 架构不对：$(file -b "$PACKED_NODE")" ;; esac
case "$(codesign -dv --verbose=4 "$PACKED_NODE" 2>&1 || true)" in
    *"TeamIdentifier=$NODE_TEAM_ID"*) echo "  ✓ node 的 TeamIdentifier 是 $NODE_TEAM_ID" ;;
    *) die "node 的 TeamIdentifier 不是 ${NODE_TEAM_ID}，被重新签名了" ;;
esac
[ "$(shasum -a 256 "$NODE_DIR/bin/node" | awk '{print $1}')" = "$(shasum -a 256 "$PACKED_NODE" | awk '{print $1}')" ] || die "包里的 node 和下载的不一致"
echo "  ✓ node 与下载件逐字节相同"

for f in \
    "usr/local/bin/ateam" \
    "Library/Application Support/ateam/app/bin/ateam.js" \
    "Library/Application Support/ateam/app/src/server.js" \
    "Library/Application Support/ateam/app/src/dashboard.html" \
    "Library/Application Support/ateam/app/src/install.js" \
    "Library/Application Support/ateam/app/src/update.js" \
    "Library/Application Support/ateam/app/skills/ateam-lead/SKILL.md" \
    "Library/Application Support/ateam/app/skills/ateam-worker/SKILL.md" \
    "Library/Application Support/ateam/app/skills/browser-cdp-setup/SKILL.md" \
    "Library/Application Support/ateam/app/dsh-plugin/index.js" \
    "Library/Application Support/ateam/app/package.json" \
    "Library/Application Support/ateam/卸载 ateam.command" \
    "Applications/ateam.app/Contents/MacOS/ateam" \
    "Applications/ateam.app/Contents/Resources/ateam.icns" \
    "Applications/ateam.app/Contents/Info.plist"
do
    [ -e "$PAYLOAD/$f" ] || die "安装包里缺少 $f"
    printf '  ✓ %s\n' "$f"
done
[ -x "$PAYLOAD/usr/local/bin/ateam" ] || die "ateam 命令没有执行权限"
[ "$(lipo -archs "$PAYLOAD/Applications/ateam.app/Contents/MacOS/ateam")" = "$PKG_ARCH" ] || die "菜单栏程序架构不对"
echo "  ✓ 菜单栏程序架构 $PKG_ARCH"
PACKED_VERSION="$(node -p "require('$PAYLOAD/Library/Application Support/ateam/app/package.json').version")"
[ "$PACKED_VERSION" = "$VERSION" ] || die "包里的版本号 $PACKED_VERSION 不是 $VERSION"
echo "  ✓ 版本 $VERSION"
SCRIPTS_DIR="$(find "$VERIFY/expanded" -type d -name Scripts | head -1)"
[ -f "$SCRIPTS_DIR/preinstall" ] && [ -f "$SCRIPTS_DIR/postinstall" ] || die "安装包里没有 preinstall / postinstall"
echo "  ✓ preinstall、postinstall"
grep -q 'hostArchitectures="arm64,x86_64"' "$VERIFY/expanded/Distribution" && grep -q "ateamCheckChip()" "$VERIFY/expanded/Distribution" || die "Distribution 里没有架构检查"
echo "  ✓ 装错架构时拦下"

log "完成"
ls -lh "$OUT"
echo "安装包不签名：第一次打开要在「系统设置 → 隐私与安全性」点「仍要打开」。"
