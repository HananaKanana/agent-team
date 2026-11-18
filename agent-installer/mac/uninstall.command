#!/bin/bash
#
# 卸载 ateam：删除指向安装目录的 skill 软链和 hook、登录项、菜单栏程序、安装目录和 ateam 命令。
# 各项目里的 .ateam/、~/.config/ateam（项目列表、开发模式记录）不动。

set -u
BASE="/Library/Application Support/ateam"
MENU_APP="/Applications/ateam.app"

if [ "$(id -u)" -ne 0 ]; then
    echo "卸载 ateam 需要管理员权限，请输入登录密码："
    exec sudo "$0" "$@"
fi

CONSOLE_USER=$(stat -f %Su /dev/console)
case "$CONSOLE_USER" in ""|root|loginwindow) CONSOLE_USER="" ;; esac
if [ -n "$CONSOLE_USER" ] && [ -x "$BASE/node/bin/node" ]; then
    CONSOLE_UID=$(id -u "$CONSOLE_USER")
    HOME_DIR=$(dscl . -read "/Users/$CONSOLE_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
    echo "删除 skill 链接、hook 和登录项…"
    launchctl asuser "$CONSOLE_UID" sudo -u "$CONSOLE_USER" env HOME="${HOME_DIR:-/Users/$CONSOLE_USER}" \
        "$BASE/node/bin/node" "$BASE/app/bin/ateam.js" setup --remove || true
fi

pkill -f "$MENU_APP/Contents/MacOS/ateam" 2>/dev/null || true
echo "删除 $MENU_APP"
rm -rf "$MENU_APP"
echo "删除 /usr/local/bin/ateam"
rm -f /usr/local/bin/ateam
echo "删除 $BASE"
rm -rf "$BASE"
pkgutil --forget com.ateam.pkg >/dev/null 2>&1 || true

echo
echo "ateam 已卸载。已经在运行的 ateam 服务会继续运行，直到停止。"
echo "各项目里的 .ateam/ 和 ~/.config/ateam 没有删除。"
echo
read -n 1 -s -r -p "按任意键关闭这个窗口…"
echo
