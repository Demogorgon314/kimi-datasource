#!/usr/bin/env bash
# Build (optional) and install kimi-datasource CLI + Agent Skill.
#
# Usage:
#   ./install/install.sh              # build with bun, install to ~/.local/bin
#   ./install/install.sh --no-build   # install existing dist/ or use bun source runner
#   ./install/install.sh --prefix /usr/local
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${PREFIX:-$HOME/.local}"
DO_BUILD=1
SKILL_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build) DO_BUILD=0; shift ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --prefix=*) PREFIX="${1#--prefix=}"; shift ;;
    --skill-only) SKILL_ONLY=1; shift ;;
    --help|-h)
      echo "Usage: $0 [--no-build] [--prefix DIR] [--skill-only]"
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

BIN_DIR="$PREFIX/bin"
SKILL_DIRS=(
  "$HOME/.agents/skills/kimi-datasource"
  "$HOME/.claude/skills/kimi-datasource"
  "$HOME/.codex/skills/kimi-datasource"
  "$HOME/.grok/skills/kimi-datasource"
)

install_skill() {
  for d in "${SKILL_DIRS[@]}"; do
    mkdir -p "$d"
    cp -f "$ROOT/SKILL.md" "$d/SKILL.md"
    cp -f "$ROOT/watchlist.json" "$d/watchlist.json"
    echo "skill → $d"
  done
}

if [[ "$SKILL_ONLY" -eq 1 ]]; then
  install_skill
  exit 0
fi

mkdir -p "$BIN_DIR"
DIST_BIN="$ROOT/dist/kimi-datasource"

if [[ "$DO_BUILD" -eq 1 ]]; then
  if ! command -v bun >/dev/null 2>&1; then
    echo "error: bun is required to build. Install from https://bun.sh" >&2
    exit 1
  fi
  bun "$ROOT/scripts/build.mjs" --outfile "$DIST_BIN"
fi

if [[ -x "$DIST_BIN" ]]; then
  cp -f "$DIST_BIN" "$BIN_DIR/kimi-datasource"
  chmod +x "$BIN_DIR/kimi-datasource"
  # Keep skill next to binary for skill-path fallback
  cp -f "$ROOT/SKILL.md" "$BIN_DIR/SKILL.md" 2>/dev/null || true
  cp -f "$ROOT/watchlist.json" "$BIN_DIR/watchlist.json" 2>/dev/null || true
  echo "binary → $BIN_DIR/kimi-datasource"
else
  # Fallback wrapper invoking bun on source
  cat >"$BIN_DIR/kimi-datasource" <<EOF
#!/usr/bin/env bash
exec bun "$ROOT/bin/kimi-datasource.mjs" "\$@"
EOF
  chmod +x "$BIN_DIR/kimi-datasource"
  echo "wrapper → $BIN_DIR/kimi-datasource (bun + source)"
fi

install_skill

echo ""
echo "Ensure $BIN_DIR is on PATH, then:"
echo "  kimi-datasource status"
echo "  kimi-datasource desc arxiv"
echo "  kimi-datasource login   # if needed"
