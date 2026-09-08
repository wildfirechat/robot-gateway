#!/bin/bash
# =============================================================
# dsh-plugin.js 打包 + 部署 + 重启（一次性完成）
#
# 用法:  ./build-deploy.sh [profile]
#   profile  目标 dsh profile 名，默认 wildfire
#            （当前实际在跑的机器人是 web profile：./build-deploy.sh web）
#
# 环境变量:
#   DHS_BIN=...       指定 dsh 可执行文件（默认取 PATH 上的全局 dsh）
#   SKIP_RESTART=1    只安装不重启（升级 dsh / 手动重启时用）
#
# 关键点（踩坑记录）:
#   1. 必须用本地 tsc（./node_modules/.bin/tsc），`npx tsc` 会拉到假包
#   2. npm pack 后 pnpm 安装时 `file:../client.js` 依赖按【安装目标目录】解析，
#      因此用 `--dir <profile>` 从插件目录安装；~/.dsh/profiles/client.js
#      符号链接不存在时会自动创建（指向工作区 SDK 源码，保证 SDK 补丁同步）
#   3. 必须删除已装的插件包 + .pnpm 缓存，否则 pnpm 复用旧缓存不更新
#   4. 重启必须杀【所有】匹配进程（残留多进程会导致网关重复投递、会话写坏）
#   5. dsh 0.1.2 起 ~/.dsh/profiles/node_modules 由 dsh 自己托管（module
#      fallback 符号链接指向当前 CLI 安装目录）；升级 dsh 后首次启动会自动
#      重新指向新版本，若出现缺包可 `rm -rf ~/.dsh/profiles/node_modules` 后重启
# =============================================================
set -euo pipefail

PROFILE="${1:-wildfire}"
PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
# 解析 dsh 可执行文件：优先 $DHS_BIN，其次 PATH 上的全局 dsh（升级 dsh 后自动跟随），
# 最后回退到旧的 npx 缓存路径（0.1.0-rc.7，已过时，仅保底）。
DHS_BIN="${DHS_BIN:-$(command -v dsh || true)}"
if [ -z "${DHS_BIN:-}" ] || [ ! -x "$DHS_BIN" ]; then
  DHS_BIN="/Users/rain/.npm/_npx/1e7f6d9597241db0/node_modules/.bin/dsh"
fi
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -x "${NODE_BIN:-}" ] || NODE_BIN="/Users/rain/.nvm/versions/node/v22.22.0/bin/node"
PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE"
LOG_FILE="$HOME/.dsh/dsh-wildfire.log"
SDK_SRC="$PLUGIN_DIR/../client.js"
# 固定 pnpm 版本：`pnpm@latest` 会解析到 corepack 缓存里可能损坏的新版本
# （曾出现 12.3.4 缺 bin/pnpm.cjs，导致 install 失败、profile 被 rm 后起不来）。
PNPM_VERSION="${PNPM_VERSION:-11.25.0}"
# npm 缓存目录：~/.npm 里若有 root 属主的残留会 EPERM（npm 自身的老 bug），
# 因此默认用可写的临时缓存，避免 pack 失败。
NPM_CACHE="${NPM_CACHE:-${TMPDIR:-/tmp}/dsh-plugin-npm-cache}"
mkdir -p "$NPM_CACHE"

echo "==> 1/5 构建 (tsc)"
cd "$PLUGIN_DIR"
./node_modules/.bin/tsc
echo "    构建完成"

echo "==> 2/5 打包 (npm pack)"
rm -f ./*.tgz
TGZ="$(npm pack --silent --cache "$NPM_CACHE" | tail -1)"
echo "    $TGZ"

echo "==> 3/5 确保 SDK file: 依赖可解析（符号链接）"
mkdir -p "$HOME/.dsh/profiles"
if [ ! -L "$HOME/.dsh/profiles/client.js" ]; then
  ln -sfn "$SDK_SRC" "$HOME/.dsh/profiles/client.js"
  echo "    已创建 -> $HOME/.dsh/profiles/client.js"
else
  echo "    已存在"
fi

echo "==> 4/5 安装到 profile ($PROFILE)"
mkdir -p "$PROFILE_DIR"
INSTALLED="$PROFILE_DIR/node_modules/@wildfirechat/dsh-wildfire"
BACKUP_DIR=""
if [ -d "$INSTALLED" ]; then
  BACKUP_DIR="$(mktemp -d)"
  cp -R "$INSTALLED" "$BACKUP_DIR/dsh-wildfire"
fi
rm -rf "$INSTALLED" \
       "$PROFILE_DIR/node_modules/.pnpm/@wildfirechat+dsh-wildfire@"*
if ! corepack pnpm@"$PNPM_VERSION" --dir "$PROFILE_DIR" install "$PLUGIN_DIR/$TGZ" 2>&1 | tail -3; then
  echo "!! pnpm install 失败（pnpm@${PNPM_VERSION}）"
  if [ -n "$BACKUP_DIR" ]; then
    echo "   回滚到安装前的插件版本，避免 profile 起不来"
    rm -rf "$INSTALLED"
    cp -R "$BACKUP_DIR/dsh-wildfire" "$INSTALLED"
  fi
  exit 1
fi

echo "==> 5/5 重启插件（杀全部旧进程）"
echo "    dsh: $DHS_BIN ($("$NODE_BIN" "$DHS_BIN" --version 2>/dev/null || echo '版本未知'))"

# 旧进程定位：
#   - web profile 用监听端口反查 PID。实测该进程的命令行对 pgrep/pkill 不可见
#     （`pgrep -f "bin.js"` / `"bin/dsh"` / `"--profile web"` 全部匹配不到），
#     只能按 PID 杀。
#   - 其他 profile 退化为命令行匹配。
WEB_PORT="${WEB_PORT:-3080}"
profile_pids() {
  {
    if [ "$PROFILE" = "web" ]; then
      lsof -nP -iTCP:"$WEB_PORT" -sTCP:LISTEN -t 2>/dev/null || true
    fi
    pgrep -f -- "--profile $PROFILE" 2>/dev/null || true
  } | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u
}
restart_hint() {
  echo "    手动重启："
  if [ "$PROFILE" = "web" ]; then
    echo "      kill \$(lsof -nP -iTCP:$WEB_PORT -sTCP:LISTEN -t)"
  else
    echo "      pkill -f -- '--profile $PROFILE'"
  fi
  echo "      cd /Users/rain/Workspace/robot-gateway && nohup $NODE_BIN $DHS_BIN --profile $PROFILE >> $LOG_FILE 2>&1 &"
}
if [ "${SKIP_RESTART:-0}" = "1" ]; then
  echo "    SKIP_RESTART=1，已跳过重启。"
  restart_hint
  exit 0
fi

OLD_PIDS="$(profile_pids | tr '\n' ' ')"
if [ -n "${OLD_PIDS// /}" ]; then
  echo "    结束旧进程: $OLD_PIDS"
  # shellcheck disable=SC2086
  kill $OLD_PIDS 2>/dev/null || true
  for _ in $(seq 1 15); do
    [ -z "$(profile_pids | tr -d '\n')" ] && break
    sleep 1
  done
  STILL="$(profile_pids | tr '\n' ' ')"
  if [ -n "${STILL// /}" ]; then
    echo "    仍未退出，强制结束: $STILL"
    # shellcheck disable=SC2086
    kill -9 $STILL 2>/dev/null || true
    sleep 1
  fi
fi

cd /Users/rain/Workspace/robot-gateway
nohup "$NODE_BIN" "$DHS_BIN" --profile "$PROFILE" >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "    新进程 PID $NEW_PID"

sleep 10
if kill -0 "$NEW_PID" 2>/dev/null; then
  echo "==> 完成：PID $NEW_PID，日志: $LOG_FILE"
  tail -2 "$LOG_FILE"
else
  echo "!! 插件未启动，查看日志: $LOG_FILE"
  tail -20 "$LOG_FILE"
  exit 1
fi
