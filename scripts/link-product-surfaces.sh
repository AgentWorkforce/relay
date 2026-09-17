#!/usr/bin/env bash
#
# Link the sibling product SDK builds into this repo's node_modules so
# `agent-relay file|flows|sessions` run against local branches instead of the
# published packages.
#
# Why this exists: the mounted surfaces (`@relayfile/sdk/relay-cli`,
# `@relayflows/sdk/relay-cli`, `ai-hist/relay-cli`) are not published yet, so a
# clean install gives each group an "upgrade this package" message. This script
# is how the end-to-end mount is exercised before release. `npm install`
# replaces these links, so re-run it afterwards.
#
# Usage: scripts/link-product-surfaces.sh [workspaces-root]
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
RELAY="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODULES="$RELAY/node_modules"

link() {
  local name="$1" target="$2" build_dir="$3"
  if [ ! -d "$target" ]; then
    echo "skip $name: $target not found"
    return
  fi
  if [ ! -d "$target/dist" ]; then
    echo "building $name ..."
    (cd "$build_dir" && npm run build >/dev/null)
  fi
  mkdir -p "$(dirname "$MODULES/$name")"
  rm -rf "${MODULES:?}/$name"
  ln -s "$target" "$MODULES/$name"
  echo "linked $name -> $target"
}

link "@relayfile/sdk"             "$ROOT/relayfile/packages/sdk/typescript"        "$ROOT/relayfile/packages/sdk/typescript"
link "@relayflows/sdk"            "$ROOT/flows/packages/sdk"                       "$ROOT/flows/packages/sdk"
link "ai-hist"                    "$ROOT/relayhistory/sdk-ts"                      "$ROOT/relayhistory/sdk-ts"
link "@relayhistory/cloud-client" "$ROOT/relayhistory-cloud/packages/cloud-client" "$ROOT/relayhistory-cloud/packages/cloud-client"

echo
echo "Verify with:"
echo "  node packages/cli/dist/cli/index.js file --help"
echo "  node packages/cli/dist/cli/index.js flows --help"
echo "  node packages/cli/dist/cli/index.js sessions --help"
