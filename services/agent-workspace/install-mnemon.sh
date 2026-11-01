#!/usr/bin/env bash
# 给某个 DSH profile 装上 dsh-mnemon（记忆插件）。
#
# 为什么需要：机器人调的是 headless profile，而 headless 默认只有 base + headless
# 两个 bundle。没装记忆插件时，~/.mnemon/runtime/{MEMORY.md,USER.md} 从来没进过
# 上下文，于是"它什么都不记得"。
#
# 用法（在 agent 机上跑，不是 Windows）：
#   bash install-mnemon.sh              # 装到 headless（机器人用的那个）
#   bash install-mnemon.sh web          # 装到 web
#   MNEMON_PKG=dsh-mnemon@0.5.37 bash install-mnemon.sh
#
# 幂等：已经装过就跳过安装，只做检查。

set -euo pipefail

PROFILE="${1:-headless}"
PKG="${MNEMON_PKG:-dsh-mnemon@^0.5.37}"
PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE"
STAMP="$(date +%Y%m%d-%H%M%S)"

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# ── 前置检查 ────────────────────────────────────────────────────────────────
command -v dsh >/dev/null 2>&1 || die "找不到 dsh，先确认 DSH 已装（which dsh）"
[ -d "$PROFILE_DIR" ] || die "没有这个 profile：$PROFILE_DIR（现有：$(ls "$HOME/.dsh/profiles" 2>/dev/null | tr '\n' ' '))"

say "profile : $PROFILE"
say "目录    : $PROFILE_DIR"
say "包      : $PKG"
say ""

# ── 已经装过就跳过 ──────────────────────────────────────────────────────────
if grep -q '"dsh-mnemon"' "$PROFILE_DIR/package.json" 2>/dev/null; then
  VER="$(grep -o '"dsh-mnemon"[^,}]*' "$PROFILE_DIR/package.json" | head -1)"
  say "✓ 已经装过了（$VER），跳过安装。"
else
  # ── 备份 ──────────────────────────────────────────────────────────────────
  BAK="$PROFILE_DIR/package.json.bak-before-mnemon-$STAMP"
  cp -p "$PROFILE_DIR/package.json" "$BAK"
  say "→ 已备份 package.json → $(basename "$BAK")"

  # ── 安装 ──────────────────────────────────────────────────────────────────
  # pnpm 会同时写 dependencies 和 dsh.profile.bundles，不需要手改 JSON。
  say "→ 安装中（pnpm 会自动把 bundle 加进 dsh.profile.bundles）..."
  if ! dsh plugin --profile "$PROFILE" add "$PKG"; then
    say ""
    die "安装失败。回滚：cp -p $BAK $PROFILE_DIR/package.json"
  fi
  say "✓ 安装完成"
  say "  回滚：cp -p $BAK $PROFILE_DIR/package.json"
fi

say ""

# ── 检查装配 ────────────────────────────────────────────────────────────────
COUNT="$(dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -ci mnemon || true)"
if [ "${COUNT:-0}" -lt 3 ]; then
  die "dump-config 里只看到 $COUNT 处 mnemon，装配可能没生效（期望 ≥3：mnemon / mnemon-bundle / mnemon-source-*）"
fi
say "✓ dump-config 里有 $COUNT 处 mnemon entry"

say ""

# ── 记忆文件 ────────────────────────────────────────────────────────────────
RUNTIME="$HOME/.mnemon/runtime"
if [ -d "$RUNTIME" ]; then
  for f in MEMORY.md USER.md memories.json; do
    [ -f "$RUNTIME/$f" ] && say "  $RUNTIME/$f  $(stat -c %s "$RUNTIME/$f") 字节"
  done
  say "  （mnemon 启动时会 flush 一次，mtime 变、大小不变，属正常）"
else
  say "  还没有 $RUNTIME —— 第一次跑起来之后才会有"
fi

say ""
say "验证（两句独立 session，答案都该是记忆里的名字，而不是从会话历史猜的）："
say "  cd /home/agent/work && dsh-task --json '你还记得我叫什么名字？只回答名字'"
say ""
say "别做的事：不要把 web profile 里 dsh-mnemon/cordis.patch.yml 的 insert 块"
say "抄进 profile 的 patch —— entry id 会重复，Settings 存不住（上游 issue #470）。"
