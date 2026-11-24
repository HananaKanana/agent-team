#!/bin/bash
# 全部安装包一起打：Mac 的 Apple 芯片（arm64）和 Intel（x64），内容一样，只有 node 和菜单栏程序的架构不同；
# 再打 Windows 的 win-x64（agent-installer/windows/build.sh，也在这台 Mac 上打）。
# 用法：bash agent-installer/mac/build-all.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
for arch in arm64 x64; do
    printf '\n########## 打 %s 包 ##########\n' "$arch"
    NODE_ARCH="$arch" bash "$HERE/build.sh"
done
printf '\n########## 打 Windows 包 ##########\n'
bash "$HERE/../windows/build.sh"
printf '\n安装包都打好了：\n'
ls -lh "$HERE/../dist/"*.pkg "$HERE/../dist/"*.exe
