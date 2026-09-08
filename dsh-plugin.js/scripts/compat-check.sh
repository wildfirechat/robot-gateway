#!/usr/bin/env bash
# =============================================================
# 插件 ↔ dsh 版本兼容性自检（离线）
#
# 在临时 DSH_HOME 里用【假网关】启动插件，不接触 ~/.dsh、不连真实网关、
# 不影响正在运行的实例。验证：
#   1. 插件能被该版本 dsh 加载（plugin loaded，无 import/加载错误）
#   2. userQuestions 只走一条注册分支：
#        dsh <= 0.1.1-rc.2  -> registerProvider
#        dsh >= 0.1.2-rc.1  -> waterfall user-questions/request
#   3. （默认开启的探针）瀑布流确实被调用，且插件对“非本机器人会话”的请求
#      调用 next() 让给其它 answerer（而不是抛错吞掉）
#
# 用法:
#   ./scripts/compat-check.sh                    # 用 PATH 上的 dsh
#   ./scripts/compat-check.sh /path/to/bin/dsh   # 指定 dsh 可执行文件
#   ./scripts/compat-check.sh --no-probe         # 跳过瀑布流探针
#
# 退出码: 0 = 通过；1 = 失败（会打印日志尾部）
# =============================================================
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REAL_HOME="$HOME"
DSH_BIN=""
PROBE=1
for arg in "$@"; do
  case "$arg" in
    --no-probe) PROBE=0 ;;
    --probe) PROBE=1 ;;
    -*) echo "未知参数: $arg" >&2; exit 2 ;;
    *) DSH_BIN="$arg" ;;
  esac
done
[ -n "$DSH_BIN" ] || DSH_BIN="$(command -v dsh || true)"
[ -x "${DSH_BIN:-}" ] || { echo "找不到 dsh 可执行文件（可用参数指定）" >&2; exit 2; }
NODE_BIN="${NODE_BIN:-$(command -v node)}"
PNPM_VERSION="${PNPM_VERSION:-11.25.0}"

VER="$("$NODE_BIN" "$DSH_BIN" --version 2>/dev/null | head -1)"
echo "== dsh: $DSH_BIN ($VER)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
HOME_T="$WORK/home"
DSH_HOME="$HOME_T/.dsh"
PROFILE_DIR="$DSH_HOME/profiles/compat-check"
LOG="$WORK/boot.log"
mkdir -p "$PROFILE_DIR/node_modules"

# ---- 1. 打包并安装当前插件（与 build-deploy.sh 相同的安装路径） ----
TGZ="$(ls -t "$PLUGIN_DIR"/wildfirechat-dsh-wildfire-*.tgz 2>/dev/null | head -1 || true)"
if [ -z "$TGZ" ]; then
  echo "== 打包插件"
  ( cd "$PLUGIN_DIR" && npm pack --silent --cache "$WORK/npm-cache" >/dev/null )
  TGZ="$(ls -t "$PLUGIN_DIR"/wildfirechat-dsh-wildfire-*.tgz | head -1)"
fi
echo "== 安装: $(basename "$TGZ")"
ln -sfn "$PLUGIN_DIR/../client.js" "$DSH_HOME/profiles/client.js"
COREPACK_HOME="${COREPACK_HOME:-$REAL_HOME/.cache/node/corepack}" \
  corepack pnpm@"$PNPM_VERSION" --dir "$PROFILE_DIR" install "$TGZ" >"$WORK/install.log" 2>&1 \
  || { echo "!! pnpm install 失败"; tail -5 "$WORK/install.log"; exit 1; }

# ---- 2. 隔离 profile：假网关 + 隔离的持久化文件 ----
printf '{ "name": "dsh-profile-compat-check", "private": true, "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } } }\n' \
  > "$PROFILE_DIR/package.json"
printf '[]\n' > "$PROFILE_DIR/cordis.yml"
cat > "$PROFILE_DIR/cordis.patch.yml" <<EOF
- insert:
    - id: wildfire
      name: '@wildfirechat/dsh-wildfire'
      config:
        gatewayUrl: ws://127.0.0.1:1/robot/gateway
        robotId: robot_compat_check
        robotSecret: compat_check_secret
        whiteList:
          persistFile: $WORK/allow.json
        workspace:
          root: $WORK/ws
          persistFile: $WORK/ws.json
EOF

# ---- 3. 可选探针：调用 userQuestions.ask()，验证瀑布流 fall through ----
if [ "$PROBE" = "1" ]; then
  PROBE_DIR="$PROFILE_DIR/node_modules/@wildfirechat/probe"
  mkdir -p "$PROBE_DIR"
  cat > "$PROBE_DIR/package.json" <<'EOF'
{ "name": "@wildfirechat/probe", "version": "1.0.0", "type": "module", "main": "./index.js" }
EOF
  cat > "$PROBE_DIR/index.js" <<'EOF'
export const name = 'probe'
export const inject = ['userQuestions']
export function apply(ctx) {
  const logger = ctx.logger('probe')
  void (async () => {
    try { await ctx.get('loader')?.await?.() } catch {}
    // 在插件之后注册（插件在 loader settle 时注册），确保插件先拿到请求
    await new Promise((r) => setTimeout(r, 1500))
    ctx.on('user-questions/request', async (request) => {
      logger.info('PROBE_REACHED')
      return { answers: [{ id: request.questions[0].id, selected: ['probe-answer'] }] }
    })
    try {
      const answer = await ctx.userQuestions.ask({
        questions: [{ id: 'q1', question: 'compat probe?', options: [{ label: 'probe-answer' }] }],
      })
      logger.info('ASK_RESOLVED ' + JSON.stringify(answer))
    } catch (err) {
      logger.error('ASK_REJECTED ' + String(err?.code ?? '') + ' ' + String(err?.message ?? err))
    }
  })()
}
EOF
  cat >> "$PROFILE_DIR/cordis.patch.yml" <<'EOF'
    - id: probe
      name: '@wildfirechat/probe'
EOF
fi

# ---- 4. 启动（假网关连不上是预期的；只看插件加载与注册路径） ----
echo "== 启动（约 20s）"
set +e
HOME="$HOME_T" DSH_HOME="$DSH_HOME" timeout 20 \
  "$NODE_BIN" "$DSH_BIN" --profile compat-check >"$LOG" 2>&1
set -e

FAIL=0
check() { # check <描述> <grep 正则>
  if grep -qE "$2" "$LOG"; then echo "  ✅ $1"; else echo "  ❌ $1"; FAIL=1; fi
}
nocheck() {
  if grep -qE "$2" "$LOG"; then echo "  ❌ $1"; FAIL=1; else echo "  ✅ $1"; fi
}

echo "== 结果"
check "插件已加载" "\[wildfire\].*plugin loaded"
nocheck "无模块/加载错误" "Cannot find package|plugin tree failed to load|not a symlink"

REG_OLD="$(grep -c 'userQuestions provider registered (registerProvider' "$LOG" || true)"
REG_NEW="$(grep -c 'waterfall user-questions/request' "$LOG" || true)"
if [ "$REG_OLD" -eq 1 ] && [ "$REG_NEW" -eq 0 ]; then
  echo "  ✅ userQuestions 走旧接口 registerProvider（dsh ≤ 0.1.1-rc.2 预期）"
  PATH_KIND=old
elif [ "$REG_NEW" -eq 1 ] && [ "$REG_OLD" -eq 0 ]; then
  echo "  ✅ userQuestions 走瀑布流 user-questions/request（dsh ≥ 0.1.2-rc.1 预期）"
  PATH_KIND=new
else
  echo "  ❌ userQuestions 注册分支异常（registerProvider=$REG_OLD, waterfall=$REG_NEW）"
  FAIL=1
  PATH_KIND=unknown
fi

if [ "$PROBE" = "1" ]; then
  if [ "$PATH_KIND" = "new" ]; then
    check "瀑布流被调用且插件让行（PROBE_REACHED）" "PROBE_REACHED"
    check "请求最终被其它 answerer 应答（ASK_RESOLVED）" "ASK_RESOLVED"
  else
    echo "  ℹ️ 非瀑布流分支，探针不作断言（旧接口单 provider，无 fall through 语义）"
  fi
fi

if [ "$FAIL" -ne 0 ]; then
  echo "== 日志尾部 =="
  tail -25 "$LOG"
  exit 1
fi
echo "== 通过 ✅（${VER}）"
