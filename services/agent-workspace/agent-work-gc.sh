#!/usr/bin/env bash
# agent-work-gc — agent 工作区清理器
#
# 默认只报告不删。删之前一定会先列出将删的路径和体积。
# L1 是坏安装残骸（永远安全）；L2/L3 删了之后要重新 build / install，所以必须显式点名。
#
#   agent-work-gc              报告全部级别
#   agent-work-gc -r L1        删残骸
#   agent-work-gc -r L2        ！删构建产物（release/ 里可能有要交付的安装包）
#   agent-work-gc -r L3        ！删 node_modules
#   agent-work-gc -p /some/dir 指定别的根目录
#
set -uo pipefail

ROOT="${HOME}/work"
DO=0
LEVELS="L1"

while getopts "nr:p:L:h" opt; do
  case "$opt" in
    n) DO=0 ;;
    r) DO=1; LEVELS="${OPTARG}" ;;
    L) LEVELS="${OPTARG}" ;;
    p) ROOT="${OPTARG}" ;;
    h) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) exit 2 ;;
  esac
done

[ -d "$ROOT" ] || { echo "根目录不存在：$ROOT" >&2; exit 1; }
cd "$ROOT" || exit 1

has() { case ",${LEVELS}," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

# ── 收集 ────────────────────────────────────────────────────────────────────
# 用 -prune 跳过 node_modules 内部，避免在 20 万文件里爬
L1_LIST=$(find . -maxdepth 6 \
  \( -name "node_modules.incomplete-*" -o -name "node_modules.link-repair-*" \
     -o -name "node_modules.bak*" -o -name "node_modules.old*" \) -prune -print 2>/dev/null)

L2_LIST=$(find . -maxdepth 6 -type d \
  \( -name dist -o -name out -o -name release -o -name .next -o -name .cache -o -name .turbo \
     -o -name .parcel-cache -o -name .vite \) \
  -not -path "*/node_modules/*" -not -path "*/.git/*" -prune -print 2>/dev/null)

L3_LIST=$(find . -maxdepth 6 -type d -name node_modules \
  -not -path "*/node_modules/*" -not -path "*/.git/*" -prune -print 2>/dev/null)

size_of() { du -sb "$@" 2>/dev/null | awk '{s+=$1} END{printf "%.0f", s+0}'; }
mb() { awk -v b="$1" 'BEGIN{printf "%.1f MB", b/1048576}'; }

report() {
  local name="$1" list="$2"
  [ -z "$list" ] && return
  local total; total=$(printf '%s\n' "$list" | tr '\n' '\0' | xargs -0 -r du -sb 2>/dev/null | awk '{s+=$1} END{printf "%.0f", s+0}')
  printf '\n%s  %s  (%d 处)\n' "$name" "$(mb "${total:-0}")" "$(printf '%s\n' "$list" | wc -l)"
  printf '%s\n' "$list" | while IFS= read -r p; do
    [ -n "$p" ] && printf '    %8s  %s\n' "$(du -sh "$p" 2>/dev/null | cut -f1)" "$p"
  done
}

echo "工作区：$ROOT"
echo "总量  ：$(du -sh . 2>/dev/null | cut -f1)"

report "L1 安装残骸（安全删）"        "$L1_LIST"
report "L2 构建产物（删后需重 build）" "$L2_LIST"
report "L3 依赖（删后需重 install）"   "$L3_LIST"

T1=$(printf '%s\n' "$L1_LIST" | tr '\n' '\0' | xargs -0 -r du -sb 2>/dev/null | awk '{s+=$1} END{print s+0}')
T2=$(printf '%s\n' "$L2_LIST" | tr '\n' '\0' | xargs -0 -r du -sb 2>/dev/null | awk '{s+=$1} END{print s+0}')
T3=$(printf '%s\n' "$L3_LIST" | tr '\n' '\0' | xargs -0 -r du -sb 2>/dev/null | awk '{s+=$1} END{print s+0}')
echo
echo "合计：L1 $(mb "${T1:-0}")   L2 $(mb "${T2:-0}")   L3 $(mb "${T3:-0}")"

if [ "$DO" -eq 0 ]; then
  echo
  echo "（只报告。要删：$0 -r L1   或   $0 -r L1,L2 ）"
  exit 0
fi

# ── 删除 ────────────────────────────────────────────────────────────────────
for lvl in L1 L2 L3; do
  has "$lvl" || continue
  case "$lvl" in
    L1) list="$L1_LIST" ;;
    L2) list="$L2_LIST" ;;
    L3) list="$L3_LIST" ;;
  esac
  [ -z "$list" ] && continue
  echo
  echo "删除 $lvl："
  printf '%s\n' "$list" | while IFS= read -r p; do
    [ -z "$p" ] && continue
    case "$p" in
      /*|"$ROOT"*) echo "  跳过（路径可疑）：$p"; continue ;;
    esac
    # 再确认一次是要删的那类目录，防止变量被污染
    base=$(basename "$p")
    case "$lvl:$base" in
      L1:node_modules.incomplete-*|L1:node_modules.link-repair-*|L1:node_modules.bak*|L1:node_modules.old*) ;;
      L2:dist|L2:out|L2:release|L2:.next|L2:.cache|L2:.turbo|L2:.parcel-cache|L2:.vite) ;;
      L3:node_modules) ;;
      *) echo "  跳过（不匹配规则）：$p"; continue ;;
    esac
    rm -rf -- "$p" && echo "  已删 $p"
  done
done

echo
echo "清理后：$(du -sh . 2>/dev/null | cut -f1)"
