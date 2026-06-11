#!/usr/bin/env bash
#
# Sync the AgentWorkforce agents' graphics (banner/card/card-sm PNGs)
# from the agents repo into public/agent-art/<slug>/ so the /agents gallery can
# serve them as static assets.
#
# NOTE: the destination is public/agent-art, NOT public/agents — SST/OpenNext
# turns each top-level public/ folder into a CloudFront → S3 behavior, so a
# public/agents/ folder would shadow the /agents page routes (every /agents*
# path would 403 from S3).
#
# Source of truth: ../../agents/<dir>/{banner,card,card-sm}.png
# Run from anywhere; paths are resolved relative to this script.
#
# Usage: web/scripts/sync-agent-assets.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENTS_REPO="$(cd "$WEB_DIR/../../agents" && pwd)"
DEST_ROOT="$WEB_DIR/public/agent-art"

# Agent dir in the agents repo  ->  url slug used under /agent-art/<slug>
AGENTS=(
  "review:review"
  "repo-hygiene:repo-hygiene"
  "granola:granola"
  "linear:linear"
  "hn-monitor:hn-monitor"
  "spotify-releases:spotify-releases"
  "vendor-monitor:vendor-monitor"
)

ASSETS=(banner card card-sm)

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
