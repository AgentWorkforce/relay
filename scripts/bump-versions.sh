#!/bin/bash
# Bump version for all @agent-relay packages
# Usage: ./scripts/bump-versions.sh <patch|minor|major>
#
# Example: ./scripts/bump-versions.sh patch  # 0.1.0 -> 0.1.1

set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

BUMP_TYPE="${1:-patch}"

if [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major)$ ]]; then
  echo "Usage: $0 <patch|minor|major>"
  echo "  patch: 0.1.0 -> 0.1.1"
  echo "  minor: 0.1.0 -> 0.2.0"
  echo "  major: 0.1.0 -> 1.0.0"
  exit 1
fi

echo "📦 Bumping all packages ($BUMP_TYPE)..."
echo ""

# Get list of package directories
packages=(
  "protocol"
  "utils"
  "config"
  "api-types"
  "storage"
  "state"
  "policy"
  "trajectory"
  "hooks"
  "memory"
  "continuity"
  "resiliency"
  "user-directory"
  "spawner"
  "mcp"
  "wrapper"
  "bridge"
  "cloud"
  "daemon"
  "sdk"
  "dashboard"
  "dashboard-server"
)

for pkg in "${packages[@]}"; do
  pkgdir="$ROOT_DIR/packages/$pkg"
  if [ -d "$pkgdir" ]; then
    oldver=$(node -p "require('$pkgdir/package.json').version")
    (cd "$pkgdir" && npm version "$BUMP_TYPE" --no-git-tag-version) >/dev/null
    newver=$(node -p "require('$pkgdir/package.json').version")
    echo "  @agent-relay/$pkg: $oldver -> $newver"
  fi
done

# Also bump root package
oldver=$(node -p "require('./package.json').version")
npm version "$BUMP_TYPE" --no-git-tag-version >/dev/null
newver=$(node -p "require('./package.json').version")
echo "  agent-relay (root): $oldver -> $newver"

echo ""
echo "✅ All packages bumped to $BUMP_TYPE version"
echo ""
echo "Next steps:"
echo "  1. Review changes: git diff"
echo "  2. Commit: git add -A && git commit -m 'chore: bump versions to $newver'"
echo "  3. Publish: ./scripts/publish-npm.sh"
