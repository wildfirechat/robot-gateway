#!/bin/bash
# =============================================================
# dsh-plugin.js 打包 + 部署 + 重启（一次性完成）
#
# 用法:  ./build-deploy.sh [profile]
#   profile  目标 dsh profile 名，默认 wildfire
#
# 关键点（踩坑记录）:
#   1. 必须用本地 tsc（./node_modules/.bin/tsc），`npx tsc` 会拉到假包
#   2. npm pack 后 pnpm 安装时 `file:../client.js` 依赖按【安装目标目录】解析，
#      因此用 `--dir <profile>` 从插件目录安装；~/.dsh/profiles/client.js
#      符号链接不存在时会自动创建（指向工作区 SDK 源码，保证 SDK 补丁同步）
#   3. 必须删除已装的插件包 + .pnpm 缓存，否则 pnpm 复用旧缓存不更新
#   4. 重启必须杀【所有】匹配进程（残留多进程会导致网关重复投递、会话写坏）
# =============================================================
set -euo pipefail

PROFILE="${1:-wildfire}"
PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
DHS_BIN="/Users/rain/.npm/_npx/1e7f6d9597241db0/node_modules/.bin/dsh"
NODE_BIN="/Users/rain/.nvm/versions/node/v22.22.0/bin/node"
PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE"
LOG_FILE="$HOME/.dsh/dsh-wildfire.log"
SDK_SRC="$PLUGIN_DIR/../client.js"

echo "==> 1/5 构建 (tsc)"
cd "$PLUGIN_DIR"
./node_modules/.bin/tsc
echo "    构建完成"

echo "==> 2/5 打包 (npm pack)"
rm -f ./*.tgz
TGZ="$(npm pack --silent | tail -1)"
echo "    $TGZ"

echo "==> 3/5 确保 SDK file: 依赖可解析（符号链接）"
if [ ! -L "$HOME/.dsh/profiles/client.js" ]; then
  ln -sfn "$SDK_SRC" "$HOME/.dsh/profiles/client.js"
  echo "    已创建 -> $HOME/.dsh/profiles/client.js"
else
  echo "    已存在"
fi

echo "==> 4/5 安装到 profile ($PROFILE)"
rm -rf "$PROFILE_DIR/node_modules/@wildfirechat/dsh-wildfire" \
       "$PROFILE_DIR/node_modules/.pnpm/@wildfirechat+dsh-wildfire@"*
corepack pnpm@latest --dir "$PROFILE_DIR" install "$PLUGIN_DIR/$TGZ" 2>&1 | grep -v "^\s*$" | tail -2

echo "==> 5/5 重启插件（杀全部旧进程）"
pkill -f "bin/dsh --profile $PROFILE" 2>/dev/null || true
for i in $(seq 1 15); do
  pgrep -f "bin/dsh --profile $PROFILE" >/dev/null 2>&1 || break
  sleep 1
done
cd /Users/rain/Workspace/robot-gateway
nohup "$NODE_BIN" "$DHS_BIN" --profile "$PROFILE" >> "$LOG_FILE" 2>&1 &
echo "    新进程 PID $!"

sleep 10
if pgrep -f "bin/dsh --profile $PROFILE" >/dev/null 2>&1; then
  echo "==> 完成：插件进程 $(pgrep -f "bin/dsh --profile $PROFILE" | wc -l | tr -d ' ') 个，日志: $LOG_FILE"
  tail -2 "$LOG_FILE"
else
  echo "!! 插件未启动，查看日志: $LOG_FILE"
  tail -20 "$LOG_FILE"
  exit 1
fi
