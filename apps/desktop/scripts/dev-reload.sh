#!/usr/bin/env bash
#
# dev-reload.sh -- rebuild the Swift app into an existing development bundle.
#
# Takes a bundle from `build-app.sh --debug`, runs the same incremental debug
# build, rebuilds its Rust helper, and replaces both executables and SwiftPM
# resource bundles. Info.plist, icon and site URL stay as built. The bundle is re-signed
# with the identity it already carries, so Keychain access survives reloads.
#
# Cloud's `npm run dev` runs this on every save under macos/ and relaunches the
# app; it also works by hand while the app is stopped.
#
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MACOS_DIR="$REPO_ROOT/macos"
EXECUTABLE_NAME="RelayDesktop"

usage() {
  cat <<EOF
Usage:
  ${SCRIPT_NAME} --app BUNDLE --arch arm64|x64

Options:
  --app BUNDLE       An .app produced by build-app.sh --debug. Required.
  --arch arm64|x64   Architecture the bundle was built for. Required.
  -h, --help         Show this help.
EOF
}

die() {
  printf '%s: error: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

note() {
  printf '%s: %s\n' "$SCRIPT_NAME" "$*"
}

APP_BUNDLE=""
ARCH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --app)
      [ $# -ge 2 ] || die "--app needs a bundle path"
      APP_BUNDLE="$2"
      shift 2
      ;;
    --arch)
      [ $# -ge 2 ] || die "--arch needs a value (arm64 or x64)"
      ARCH="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument: $1"
      ;;
  esac
done

[ -n "$APP_BUNDLE" ] || { usage >&2; die "--app is required"; }
case "$ARCH" in
  arm64) SWIFT_ARCH="arm64" ;;
  x64)   SWIFT_ARCH="x86_64" ;;
  *)     usage >&2; die "--arch must be arm64 or x64" ;;
esac
TARGET="$APP_BUNDLE/Contents/MacOS/$EXECUTABLE_NAME"
[ -f "$TARGET" ] || die "no $EXECUTABLE_NAME in $APP_BUNDLE; build it with build-app.sh --debug first"

SWIFT_FLAGS=(-c debug --arch "$SWIFT_ARCH" --package-path "$MACOS_DIR")
swift build "${SWIFT_FLAGS[@]}"
BIN_PATH="$(swift build "${SWIFT_FLAGS[@]}" --show-bin-path | tail -n 1)"
[ -f "$BIN_PATH/$EXECUTABLE_NAME" ] || die "swift build succeeded but no $EXECUTABLE_NAME is in $BIN_PATH"

# Rebuild the helper from this checkout as well: a freshly generated Swift
# contract must never be paired with the helper from the initial stack launch.
# Native reloads reuse Cargo's normal debug cache; cross builds name the target.
PROBE_TARGET_DIR="$REPO_ROOT/probe/target"
PROBE_FLAGS=(--locked --manifest-path "$REPO_ROOT/probe/Cargo.toml" --target-dir "$PROBE_TARGET_DIR" --bin agent-relay-probe)
PROBE_BINARY="$PROBE_TARGET_DIR/debug/agent-relay-probe"
if [ "$(uname -m)" != "$SWIFT_ARCH" ]; then
  if [ "$ARCH" = arm64 ]; then RUST_TARGET=aarch64-apple-darwin; else RUST_TARGET=x86_64-apple-darwin; fi
  PROBE_FLAGS+=(--target "$RUST_TARGET")
  PROBE_BINARY="$PROBE_TARGET_DIR/$RUST_TARGET/debug/agent-relay-probe"
fi
env -u CARGO_BUILD_TARGET cargo build "${PROBE_FLAGS[@]}"
bash "$SCRIPT_DIR/check-probe-bridge.sh" "$PROBE_BINARY" "$ARCH"
PROBE_VERSION="$("$PROBE_BINARY" --version)"
PROBE_VERSION="${PROBE_VERSION#agent-relay-probe }"
APP_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$APP_BUNDLE/Contents/Info.plist")"
HELPER="$APP_BUNDLE/Contents/Helpers/$APP_NAME Helper"
[ -f "$HELPER" ] || die "no bundled helper at $HELPER"

# Read the identity before the executable changes and invalidates the seal.
IDENTITY="-"
AUTHORITY="$(codesign -d --verbose=2 "$APP_BUNDLE" 2>&1 | sed -n 's/^Authority=//p' | head -n 1)"
if [ -n "$AUTHORITY" ]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null |
    awk -v name="\"$AUTHORITY\"" 'index($0, name) {print $2; exit}')"
  [ -n "$IDENTITY" ] || die "the keychain no longer has '$AUTHORITY'; rebuild with build-app.sh --debug"
fi

install -m 0755 "$BIN_PATH/$EXECUTABLE_NAME" "$TARGET"
for resource_bundle in "$BIN_PATH"/*.bundle; do
  [ -e "$resource_bundle" ] || continue
  rm -rf "$APP_BUNDLE/Contents/Resources/$(basename "$resource_bundle")"
  cp -R "$resource_bundle" "$APP_BUNDLE/Contents/Resources/"
done

# Both release diagnostics and local builds identify the desktop source revision.
BUILD_REVISION="$(git -C "$MACOS_DIR" rev-parse --short=12 HEAD 2>/dev/null || printf unknown)"
printf '%s\n' "$BUILD_REVISION" > "$APP_BUNDLE/Contents/Resources/build-revision.txt"

# Replace atomically so a running helper keeps its old inode until it retires.
HELPER_STAGED="$HELPER.reload"
trap 'rm -f "$HELPER_STAGED"' EXIT
install -m 0755 "$PROBE_BINARY" "$HELPER_STAGED"
codesign --force --identifier agent-relay-probe --sign "$IDENTITY" "$HELPER_STAGED"
mv -f "$HELPER_STAGED" "$HELPER"
printf '%s\n' "$PROBE_VERSION" > "$APP_BUNDLE/Contents/Resources/probe-version.txt"
shasum -a 256 "$PROBE_BINARY" | awk '{print $1 "  agent-relay-probe"}' > "$APP_BUNDLE/Contents/Resources/agent-relay-probe.sha256"

# Not --deep: sign the helper first, then seal the containing app.
codesign --force --sign "$IDENTITY" "$APP_BUNDLE"
note "reloaded $APP_BUNDLE"
