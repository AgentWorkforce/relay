#!/usr/bin/env bash
#
# Sync the AgentWorkforce agents' graphics (avatar/banner/card/card-sm PNGs)
# from the agents repo into public/agents/<slug>/ so the /agents gallery can
# serve them as static assets.
#
# Source of truth: ../../agents/<dir>/{avatar,banner,card,card-sm}.png
# Run from anywhere; paths are resolved relative to this script.
#
# Usage: web/scripts/sync-agent-assets.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENTS_REPO="$(cd "$WEB_DIR/../../agents" && pwd)"
DEST_ROOT="$WEB_DIR/public/agents"

# Agent dir in the agents repo  ->  url slug used under /agents/<slug>
AGENTS=(
  "review:review"
  "repo-hygiene:repo-hygiene"
  "granola:granola"
  "linear:linear"
  "hn-monitor:hn-monitor"
  "spotify-releases:spotify-releases"
  "vendor-monitor:vendor-monitor"
)

ASSETS=(avatar banner card card-sm)

echo "Syncing agent assets from $AGENTS_REPO -> $DEST_ROOT"
for entry in "${AGENTS[@]}"; do
  src_dir="${entry%%:*}"
  slug="${entry##*:}"
  dest="$DEST_ROOT/$slug"
  mkdir -p "$dest"
  for asset in "${ASSETS[@]}"; do
    src="$AGENTS_REPO/$src_dir/$asset.png"
    if [ -f "$src" ]; then
      cp "$src" "$dest/$asset.png"
      echo "  $slug/$asset.png"
    else
      echo "  WARN: missing $src" >&2
    fi
  done
done
echo "Done."
