#!/bin/bash
#
# 发布新版本到 GitHub Releases（HananaKanana/agent-team）。会推送 main 和 tag，由用户运行。
#
# 用法：bash agent-installer/release.sh 0.2.0
#
# 步骤：
#   1. 检查：在 main、工作区干净、版本号比当前新、tag 不存在、gh 已登录；
#   2. 发布前检查（precheck.mjs：语法、文档里提到的命令都存在），不过就停；
#   3. 改 package.json 的版本并提交；
#   4. 打 arm64 和 x64 两个安装包（build.sh 自己会展开核对 node 签名和文件），生成各自的 .sha256；
#   5. 生成更新说明（上个 tag 以来的提交标题），可以先编辑；确认后打 tag、推送 main 和 tag、建 Release 上传。
# 中途失败：第 3 步之后失败时，版本号提交还在本地，没有推送；修好后可以用同一个版本号重跑（会跳过改版本）。

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
DIST="$HERE/dist"
GH_REPO="HananaKanana/agent-team"
cd "$REPO"

die() { printf 'release.sh: %s\n' "$*" >&2; exit 1; }
log() { printf '\n===== %s =====\n' "$*"; }

NEW="${1:-}"
[[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "用法：bash agent-installer/release.sh <版本号，如 0.2.0>"
command -v gh >/dev/null 2>&1 || die "需要 GitHub 命令行 gh（brew install gh），并运行 gh auth login 登录"
gh auth status >/dev/null 2>&1 || die "gh 没有登录：运行 gh auth login"

[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "请在 main 分支上发布"
[ -z "$(git status --porcelain)" ] || die "工作区有未提交的改动，先提交或清理"
git rev-parse -q --verify "refs/tags/v$NEW" >/dev/null && die "tag v$NEW 已存在"

CUR="$(node -p "require('./package.json').version")"
if [ "$CUR" != "$NEW" ]; then
    node -e '
        const [a, b] = process.argv.slice(1).map((v) => v.split(".").map(Number));
        for (let i = 0; i < 3; i++) if (a[i] !== b[i]) process.exit(a[i] > b[i] ? 0 : 1);
        process.exit(1);
    ' "$NEW" "$CUR" || die "新版本 $NEW 必须比当前版本 $CUR 新"
fi

log "发布前检查"
node "$HERE/precheck.mjs"

if [ "$CUR" != "$NEW" ]; then
    log "版本号 $CUR → $NEW"
    node -e '
        const fs = require("fs");
        const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
        pkg.version = process.argv[1];
        fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
    ' "$NEW"
    git add package.json
    git commit -q -m "release v$NEW"
fi

log "打包"
rm -f "$DIST"/ateam-"$NEW"-*
bash "$HERE/mac/build-all.sh"
for arch in arm64 x64; do
    PKG="ateam-$NEW-$arch.pkg"
    [ -f "$DIST/$PKG" ] || die "没有打出 $PKG"
    ( cd "$DIST" && shasum -a 256 "$PKG" > "$PKG.sha256" )
    cat "$DIST/$PKG.sha256"
done

log "更新说明"
NOTES="$DIST/notes-v$NEW.md"
PREV="$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)"
{
    if [ -n "$PREV" ]; then
        git log --no-merges --pretty='- %s' "$PREV..HEAD" | grep -v "^- release v" || true
    else
        echo "- 首个正式版本：Mac 安装包（自带 Node，装完自动链接 skill、安装 hook）、菜单栏图标（启动 / 停止 / 重启各项目的服务）、看板与菜单栏提示新版本并一键更新、开发模式"
    fi
} > "$NOTES"
cat "$NOTES"
echo
echo "更新说明在 ${NOTES}，会显示在看板「使用说明 → 版本」和 GitHub 发布页。"
read -r -p "需要先编辑就去改这个文件，改好后回到这里。确认发布 v${NEW}？（y/N）" ok
[ "$ok" = "y" ] || [ "$ok" = "Y" ] || die "已取消（版本号提交留在本地，没有推送）"

log "打 tag、推送、建 Release"
git tag -a "v$NEW" -m "v$NEW"
git push origin main "v$NEW"
gh release create "v$NEW" --repo "$GH_REPO" --title "v$NEW" --notes-file "$NOTES" \
    "$DIST/ateam-$NEW-arm64.pkg" "$DIST/ateam-$NEW-arm64.pkg.sha256" \
    "$DIST/ateam-$NEW-x64.pkg" "$DIST/ateam-$NEW-x64.pkg.sha256"

log "完成"
echo "v$NEW 已发布：https://github.com/$GH_REPO/releases/tag/v$NEW"
echo "安装版的 ateam 服务会在 6 小时内查到新版本，看板和菜单栏会提示更新。"
