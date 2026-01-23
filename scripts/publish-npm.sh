#!/bin/bash
# Publish all @agent-relay packages to npm
# Usage: ./scripts/publish-npm.sh [--dry-run]
#
# Prerequisites:
#   - npm login (must be authenticated)
#   - All tests passing
#   - Clean git working tree

set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

DRY_RUN=""
if [ "$1" = "--dry-run" ]; then
  DRY_RUN="--dry-run"
  echo "🏃 DRY RUN MODE - No actual publishing"
fi

echo "🔍 Checking prerequisites..."

# Check if logged in to npm
if ! npm whoami &>/dev/null; then
  echo "❌ Not logged in to npm. Run 'npm login' first."
  exit 1
fi

echo "✅ Logged in as: $(npm whoami)"

echo ""
echo "🔨 Building all packages..."
npm run build

# Packages in dependency order (leaf dependencies first)
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

echo ""
echo "📦 Publishing packages to npm..."
echo ""

failed=()
succeeded=()

for pkg in "${packages[@]}"; do
  pkgdir="$ROOT_DIR/packages/$pkg"
  if [ -d "$pkgdir" ]; then
    pkgname=$(node -p "require('$pkgdir/package.json').name")
    version=$(node -p "require('$pkgdir/package.json').version")
    echo "  Publishing $pkgname@$version..."

    if (cd "$pkgdir" && npm publish --access public $DRY_RUN 2>&1); then
      succeeded+=("$pkgname@$version")
    else
      echo "    ⚠️  Failed to publish $pkgname"
      failed+=("$pkgname@$version")
    fi
  fi
done

# Also publish root package
rootname=$(node -p "require('./package.json').name")
rootversion=$(node -p "require('./package.json').version")
echo "  Publishing $rootname@$rootversion (root)..."
if npm publish --access public $DRY_RUN 2>&1; then
  succeeded+=("$rootname@$rootversion")
else
  echo "    ⚠️  Failed to publish root package"
  failed+=("$rootname@$rootversion")
fi

echo ""
echo "=========================================="
echo "📊 PUBLISH SUMMARY"
echo "=========================================="
echo ""
echo "✅ Succeeded (${#succeeded[@]}):"
for pkg in "${succeeded[@]}"; do
  echo "   $pkg"
done

if [ ${#failed[@]} -gt 0 ]; then
  echo ""
  echo "❌ Failed (${#failed[@]}):"
  for pkg in "${failed[@]}"; do
    echo "   $pkg"
  done
  echo ""
  echo "Note: Failures usually mean the version already exists on npm."
  echo "Bump versions in package.json files before republishing."
fi

echo ""
echo "Done!"
