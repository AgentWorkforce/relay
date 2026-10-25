#!/usr/bin/env bash
#
# build-app.sh -- build the SwiftPM executable and assemble "Agent Relay.app".
#
# Produces the bundle layout from docs/plan.md section 4:
#
#   Agent Relay.app/Contents/
#     Info.plist                        from macos/Info.plist.template
#     PkgInfo                           APPL????
#     MacOS/RelayDesktop                swift build product
#     Helpers/Agent Relay Helper        agent-relay-probe: the relay core, 0755,
#                                       named for Activity Monitor
#     Helpers/Agent Relay Helper (Sessions)
#                                       a hard link to it the core runs its
#                                       session collector as
#     Library/LaunchAgents/<label>.plist the core's LaunchAgent (SMAppService.agent)
#     Resources/AppIcon.icns            rendered by scripts/render-icon.swift
#     Resources/agent-relay-probe.sha256
#     Resources/probe-version.txt
#
# Signing is picked from the environment, never from flags:
#   Developer ID  CSC_LINK (base64 .p12) + CSC_KEY_PASSWORD
#   notarization  additionally APPLE_API_KEY_BASE64 (base64 .p8),
#                 APPLE_API_KEY_ID and APPLE_API_ISSUER
#   otherwise     ad-hoc, with a printed Gatekeeper warning
#
# Secret values are never echoed and the decoded .p12 lives in a 0600 file
# inside the temporary directory, which the exit trap removes.
#
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

APP_NAME="Agent Relay"
EXECUTABLE_NAME="RelayDesktop"
PROBE_NAME="agent-relay-probe"
# The bundled core's file name, which Activity Monitor shows for it and the
# uploader it starts. Its code signature keeps the identifier $PROBE_NAME, the
# designated requirement the command-line copy in ~/.local/bin is checked
# against.
HELPER_NAME="$APP_NAME Helper"

usage() {
  cat <<EOF
Usage:
  ${SCRIPT_NAME} --arch arm64|x64 --version X.Y.Z --probe DIR --out DIR [--build N] [--debug]

Options:
  --arch arm64|x64   Architecture to build for. Maps to 'swift build --arch
                     arm64' / '--arch x86_64'. Required.
  --version X.Y.Z    Marketing version; substituted for __VERSION__ in
                     macos/Info.plist.template. Required.
  --probe DIR        Directory produced by scripts/build-probe.sh, holding
                     ${PROBE_NAME}, ${PROBE_NAME}.sha256 and probe-version.txt.
                     Required.
  --out DIR          Directory the "${APP_NAME}.app" bundle is written into.
                     Created when missing. Required.
  --dev-site-url URL Build Agent Relay Dev, pinned to an HTTP localhost/127.0.0.1 origin.
  --build N          Build number; substituted for __BUILD__ in the Info.plist
                     template. Defaults to \$GITHUB_RUN_NUMBER, else 1.
  --debug            Local development build: a debug Swift build that
                     scripts/dev-reload.sh rebuilds incrementally, signed with
                     the keychain's Apple Development identity when there is
                     one so Keychain access survives rebuilds, else ad-hoc.
                     Developer ID credentials are not used.
  -h, --help         Show this help.

Environment (all optional, read but never printed):
  CSC_LINK, CSC_KEY_PASSWORD
  APPLE_API_KEY_BASE64, APPLE_API_KEY_ID, APPLE_API_ISSUER
EOF
}

die() {
  printf '%s: error: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

note() {
  printf '%s: %s\n' "$SCRIPT_NAME" "$*"
}

warn() {
  printf '%s: warning: %s\n' "$SCRIPT_NAME" "$*" >&2
}

ARCH=""
VERSION=""
PROBE_DIR=""
OUT_DIR=""
BUILD_NUMBER=""
DEV_SITE_URL=""
CONFIGURATION="release"

while [ $# -gt 0 ]; do
  case "$1" in
    --arch)
      [ $# -ge 2 ] || die "--arch needs a value (arm64 or x64)"
      ARCH="$2"
      shift 2
      ;;
    --version)
      [ $# -ge 2 ] || die "--version needs a value (for example 1.2.3)"
      VERSION="$2"
      shift 2
      ;;
    --probe)
      [ $# -ge 2 ] || die "--probe needs a directory"
      PROBE_DIR="$2"
      shift 2
      ;;
    --out)
      [ $# -ge 2 ] || die "--out needs a directory"
      OUT_DIR="$2"
      shift 2
      ;;
    --dev-site-url)
      [ $# -ge 2 ] || die "--dev-site-url needs a loopback origin"
      DEV_SITE_URL="$2"
      shift 2
      ;;
    --build)
      [ $# -ge 2 ] || die "--build needs a number"
      BUILD_NUMBER="$2"
      shift 2
      ;;
    --debug)
      CONFIGURATION="debug"
      shift
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

[ -n "$ARCH" ] || { usage >&2; die "--arch is required"; }
[ -n "$VERSION" ] || { usage >&2; die "--version is required"; }
[ -n "$PROBE_DIR" ] || { usage >&2; die "--probe is required"; }
[ -n "$OUT_DIR" ] || { usage >&2; die "--out is required"; }

case "$ARCH" in
  arm64) SWIFT_ARCH="arm64" ;;
  x64)   SWIFT_ARCH="x86_64" ;;
  *)     die "--arch must be arm64 or x64, got: $ARCH" ;;
esac

# CFBundleShortVersionString accepts up to three dot-separated integers; allow a
# prerelease suffix so 1.2.3-rc.1 tags do not need a second code path.
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) : ;;
  *) die "--version must look like X.Y.Z, got: $VERSION" ;;
esac

if [ -n "$DEV_SITE_URL" ]; then
  [[ "$DEV_SITE_URL" =~ ^http://(localhost|127\.0\.0\.1):([0-9]+)$ ]] || die "--dev-site-url must be an HTTP loopback origin with a port"
  DEV_PORT="${BASH_REMATCH[2]}"
  (( 10#$DEV_PORT >= 1024 && 10#$DEV_PORT <= 65535 )) || die "--dev-site-url port must be between 1024 and 65535"
  APP_NAME="Agent Relay Dev"
  HELPER_NAME="$APP_NAME Helper"
fi

BUILD_NUMBER="${BUILD_NUMBER:-${GITHUB_RUN_NUMBER:-1}}"
case "$BUILD_NUMBER" in
  ''|*[!0-9]*) die "--build must be a positive integer, got: $BUILD_NUMBER" ;;
esac

[ "$(uname -s)" = "Darwin" ] || die "this script only runs on macOS (swift build --arch, codesign, iconutil)"
for tool in swift codesign iconutil plutil ditto; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool '$tool' not found; install the Xcode command line tools"
done

MACOS_DIR="$REPO_ROOT/macos"
[ -f "$MACOS_DIR/Package.swift" ] || die "no SwiftPM package at $MACOS_DIR/Package.swift"
INFO_PLIST_TEMPLATE="$MACOS_DIR/Info.plist.template"
[ -f "$INFO_PLIST_TEMPLATE" ] || die "no Info.plist template at $INFO_PLIST_TEMPLATE"

PROBE_BINARY="$PROBE_DIR/$PROBE_NAME"
PROBE_CHECKSUM="$PROBE_DIR/$PROBE_NAME.sha256"
[ -f "$PROBE_BINARY" ] || die "no $PROBE_NAME in $PROBE_DIR; run scripts/build-probe.sh first"
[ -f "$PROBE_CHECKSUM" ] || die "no $PROBE_NAME.sha256 in $PROBE_DIR; run scripts/build-probe.sh first"

bash "$SCRIPT_DIR/check-probe-bridge.sh" "$PROBE_BINARY" "$ARCH"

PROBE_VERSION="unknown"
if [ -f "$PROBE_DIR/probe-version.txt" ]; then
  PROBE_VERSION="$(tr -d '\n\r' < "$PROBE_DIR/probe-version.txt")"
else
  warn "no probe-version.txt in $PROBE_DIR; recording the probe version as 'unknown'"
fi

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
APP_BUNDLE="$OUT_DIR/$APP_NAME.app"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/build-app.XXXXXX")"
KEYCHAIN_PATH=""
cleanup() {
  if [ -n "$KEYCHAIN_PATH" ]; then
    # Also drops the keychain from the user search list.
    security delete-keychain "$KEYCHAIN_PATH" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# --- 1. build the executable -------------------------------------------------

SWIFT_FLAGS=(-c "$CONFIGURATION" --arch "$SWIFT_ARCH" --package-path "$MACOS_DIR")

note "swift build -c $CONFIGURATION --arch $SWIFT_ARCH"
swift build "${SWIFT_FLAGS[@]}"

BIN_PATH="$(swift build "${SWIFT_FLAGS[@]}" --show-bin-path | tail -n 1)"
BUILT_EXECUTABLE="$BIN_PATH/$EXECUTABLE_NAME"
if [ ! -f "$BUILT_EXECUTABLE" ]; then
  # --show-bin-path is the reliable answer, but fall back to the conventional
  # layouts so a SwiftPM change does not silently break packaging.
  for candidate in \
    "$MACOS_DIR/.build/$SWIFT_ARCH-apple-macosx/$CONFIGURATION/$EXECUTABLE_NAME" \
    "$MACOS_DIR/.build/$CONFIGURATION/$EXECUTABLE_NAME"
  do
    if [ -f "$candidate" ]; then
      BIN_PATH="$(dirname "$candidate")"
      BUILT_EXECUTABLE="$candidate"
      break
    fi
  done
fi
[ -f "$BUILT_EXECUTABLE" ] || die "swift build succeeded but no '$EXECUTABLE_NAME' product was found under $BIN_PATH"

# --- 2. assemble the bundle --------------------------------------------------

note "assembling $APP_BUNDLE"
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Helpers" "$APP_BUNDLE/Contents/Resources"

install -m 0755 "$BUILT_EXECUTABLE" "$APP_BUNDLE/Contents/MacOS/$EXECUTABLE_NAME"
install -m 0755 "$PROBE_BINARY" "$APP_BUNDLE/Contents/Helpers/$HELPER_NAME"
install -m 0644 "$PROBE_CHECKSUM" "$APP_BUNDLE/Contents/Resources/$PROBE_NAME.sha256"
# The project license and the bundled agent icons' license ship with the app.
install -m 0644 "$REPO_ROOT/LICENSE" "$APP_BUNDLE/Contents/Resources/LICENSE"
install -m 0644 "$REPO_ROOT/assets/agent-icons-LICENSE.txt" "$APP_BUNDLE/Contents/Resources/agent-icons-LICENSE.txt"

# Both release diagnostics and local builds identify the desktop source revision.
BUILD_REVISION="$(git -C "$MACOS_DIR" rev-parse --short=12 HEAD 2>/dev/null || printf unknown)"
printf '%s\n' "$BUILD_REVISION" > "$APP_BUNDLE/Contents/Resources/build-revision.txt"

printf '%s\n' "$PROBE_VERSION" > "$APP_BUNDLE/Contents/Resources/probe-version.txt"
# Classic four-character type/creator pair; no trailing newline.
printf 'APPL????' > "$APP_BUNDLE/Contents/PkgInfo"

# SwiftPM emits resource bundles next to the executable; carry any along.
for resource_bundle in "$BIN_PATH"/*.bundle; do
  [ -e "$resource_bundle" ] || continue
  cp -R "$resource_bundle" "$APP_BUNDLE/Contents/Resources/"
done

# --- 3. Info.plist -----------------------------------------------------------

sed -e "s|__VERSION__|$VERSION|g" -e "s|__BUILD__|$BUILD_NUMBER|g" \
  "$INFO_PLIST_TEMPLATE" > "$APP_BUNDLE/Contents/Info.plist"

if grep -q -e '__VERSION__' -e '__BUILD__' "$APP_BUNDLE/Contents/Info.plist"; then
  die "__VERSION__/__BUILD__ survived substitution in the generated Info.plist"
fi
if grep -q '__[A-Z0-9_]\{2,\}__' "$APP_BUNDLE/Contents/Info.plist"; then
  warn "the generated Info.plist still contains __PLACEHOLDER__ style tokens"
fi
if [ -n "$DEV_SITE_URL" ]; then
  plutil -replace CFBundleIdentifier -string com.agentrelay.desktop.dev "$APP_BUNDLE/Contents/Info.plist"
  plutil -replace CFBundleName -string "$APP_NAME" "$APP_BUNDLE/Contents/Info.plist"
  plutil -replace CFBundleDisplayName -string "$APP_NAME" "$APP_BUNDLE/Contents/Info.plist"
  plutil -replace CFBundleURLTypes.0.CFBundleURLSchemes.0 -string agentrelay-dev "$APP_BUNDLE/Contents/Info.plist"
  printf '%s\n' "$DEV_SITE_URL" > "$APP_BUNDLE/Contents/Resources/site-url.txt"
fi
plutil -lint "$APP_BUNDLE/Contents/Info.plist" >/dev/null || \
  die "the generated Info.plist is not a valid property list"

# --- 4. the core's LaunchAgent ----------------------------------------------
#
# launchd runs Helpers/$HELPER_NAME `relay serve` at login, keeps it
# alive, and restarts it from this bundle after an update. Agent Relay Dev
# has its own label, socket and data directory (relative names resolve
# beside the defaults; a property list cannot expand ~).

BUNDLE_ID="com.agentrelay.desktop"
CORE_ARGS=("$HELPER_NAME" relay serve)
if [ -n "$DEV_SITE_URL" ]; then
  BUNDLE_ID="com.agentrelay.desktop.dev"
  CORE_ARGS+=(--socket core.dev.sock --app-data-dir com.agentrelay.desktop.dev --site-url "$DEV_SITE_URL")
fi
CORE_LABEL="$BUNDLE_ID.core"
AGENT_PLIST="$APP_BUNDLE/Contents/Library/LaunchAgents/$CORE_LABEL.plist"
mkdir -p "$(dirname "$AGENT_PLIST")"
{
  printf '<?xml version="1.0" encoding="UTF-8"?>\n'
  printf '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
  printf '<plist version="1.0">\n<dict>\n'
  printf '  <key>Label</key>\n  <string>%s</string>\n' "$CORE_LABEL"
  printf '  <key>BundleProgram</key>\n  <string>Contents/Helpers/%s</string>\n' "$HELPER_NAME"
  printf '  <key>ProgramArguments</key>\n  <array>\n'
  for arg in "${CORE_ARGS[@]}"; do printf '    <string>%s</string>\n' "$arg"; done
  printf '  </array>\n'
  printf '  <key>AssociatedBundleIdentifiers</key>\n  <array>\n    <string>%s</string>\n  </array>\n' "$BUNDLE_ID"
  printf '  <key>RunAtLoad</key>\n  <true/>\n'
  printf '  <key>KeepAlive</key>\n  <true/>\n'
  printf '</dict>\n</plist>\n'
} > "$AGENT_PLIST"
plutil -lint "$AGENT_PLIST" >/dev/null || die "the generated LaunchAgent is not a valid property list"

# --- 5. icon -----------------------------------------------------------------

note "rendering AppIcon.icns"
ICON_WORK_DIR="$TMP_DIR/icon"
mkdir -p "$ICON_WORK_DIR"
swift "$SCRIPT_DIR/render-icon.swift" "$ICON_WORK_DIR"
[ -d "$ICON_WORK_DIR/AppIcon.iconset" ] || die "render-icon.swift did not produce $ICON_WORK_DIR/AppIcon.iconset"
iconutil -c icns "$ICON_WORK_DIR/AppIcon.iconset" -o "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
[ -f "$APP_BUNDLE/Contents/Resources/AppIcon.icns" ] || die "iconutil did not write AppIcon.icns"

# --- 6. signing --------------------------------------------------------------

ENTITLEMENTS="$MACOS_DIR/$EXECUTABLE_NAME.entitlements"
if [ ! -f "$ENTITLEMENTS" ]; then
  warn "no $ENTITLEMENTS; signing with an empty entitlements dictionary"
  ENTITLEMENTS="$TMP_DIR/$EXECUTABLE_NAME.entitlements"
  cat > "$ENTITLEMENTS" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict/>
</plist>
PLIST
fi

CSC_LINK="${CSC_LINK:-}"
CSC_KEY_PASSWORD="${CSC_KEY_PASSWORD:-}"
APPLE_API_KEY_BASE64="${APPLE_API_KEY_BASE64:-}"
APPLE_API_KEY_ID="${APPLE_API_KEY_ID:-}"
APPLE_API_ISSUER="${APPLE_API_ISSUER:-}"
MACOS_SIGNING_IDENTITY=""

import_signing_certificate() {
  local p12_file="$TMP_DIR/signing-certificate.p12"
  local certificate_data="$CSC_LINK"
  local keychain_password
  local original_keychains

  # Create the file first, then lock it down, then write through the existing
  # (0600) inode -- so the decoded certificate is never world readable.
  : > "$p12_file"
  chmod 600 "$p12_file"
  # electron-builder accepts either raw base64 or a base64 data URL in CSC_LINK.
  if [[ "$certificate_data" == data:*';base64,'* ]]; then
    certificate_data="${certificate_data#*,}"
  fi
  if ! printf '%s' "$certificate_data" | base64 --decode > "$p12_file" 2>/dev/null; then
    # BSD base64 before macOS 13 spells the flag -D.
    printf '%s' "$certificate_data" | base64 -D > "$p12_file"
  fi
  [ -s "$p12_file" ] || die "CSC_LINK did not base64-decode to anything"

  keychain_password="$(uuidgen)"
  KEYCHAIN_PATH="$TMP_DIR/relay-desktop-signing.keychain-db"

  security create-keychain -p "$keychain_password" "$KEYCHAIN_PATH" >/dev/null
  security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH" >/dev/null
  security unlock-keychain -p "$keychain_password" "$KEYCHAIN_PATH" >/dev/null
  if ! security import "$p12_file" -k "$KEYCHAIN_PATH" -P "$CSC_KEY_PASSWORD" \
      -T /usr/bin/codesign -T /usr/bin/security -f pkcs12 >/dev/null; then
    die "could not import the signing certificate; check CSC_LINK and CSC_KEY_PASSWORD"
  fi
  # Without this codesign prompts for keychain access and hangs on a runner.
  # It is chatty and occasionally returns nonzero while still having done its
  # job, so warn rather than abort -- a genuine failure surfaces as a codesign
  # hang or error a few lines later.
  if ! security set-key-partition-list -S apple-tool:,apple:,codesign: \
      -s -k "$keychain_password" "$KEYCHAIN_PATH" >/dev/null 2>&1; then
    warn "security set-key-partition-list returned nonzero; codesign may prompt for keychain access"
  fi

  # Keep the login keychain reachable; the temporary one is deleted by the trap.
  # shellcheck disable=SC2207
  original_keychains=($(security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"$//'))
  if [ "${#original_keychains[@]}" -gt 0 ]; then
    security list-keychains -d user -s "$KEYCHAIN_PATH" "${original_keychains[@]}" >/dev/null
  else
    security list-keychains -d user -s "$KEYCHAIN_PATH" >/dev/null
  fi

  rm -f "$p12_file"
  MACOS_SIGNING_IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN_PATH" | awk '/"Developer ID Application:/{print $2; exit}')"
  [ -n "$MACOS_SIGNING_IDENTITY" ] || die "CSC_LINK contains no valid Developer ID Application signing identity"
}

# A hard link, made once the helper is signed (re-signing replaces the file
# and would leave the link on the old bytes): the session collector the core
# starts runs as it, so Activity Monitor lists it apart from the core. Not a
# symlink, which the process would be named after the target of; not a copy,
# which would add the whole core to the download.
link_sessions_helper() {
  ln "$APP_BUNDLE/Contents/Helpers/$HELPER_NAME" "$APP_BUNDLE/Contents/Helpers/$HELPER_NAME (Sessions)"
}

codesign_with_identity() {
  # usage: codesign_with_identity TARGET [EXTRA CODESIGN ARGS...]
  local target="$1"
  shift
  codesign --force --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" \
    --keychain "$KEYCHAIN_PATH" \
    --sign "$MACOS_SIGNING_IDENTITY" \
    "$@" "$target"
}

notarize_bundle() {
  local zip_path="$TMP_DIR/$EXECUTABLE_NAME-notarize.zip"
  local api_key_path="$TMP_DIR/AuthKey.p8"
  : > "$api_key_path"
  chmod 600 "$api_key_path"
  if ! printf '%s' "$APPLE_API_KEY_BASE64" | base64 --decode > "$api_key_path" 2>/dev/null; then
    printf '%s' "$APPLE_API_KEY_BASE64" | base64 -D > "$api_key_path"
  fi
  [ -s "$api_key_path" ] || die "APPLE_API_KEY_BASE64 did not base64-decode to anything"
  note "submitting the bundle to the notary service (this waits for the verdict)"
  ditto -c -k --keepParent "$APP_BUNDLE" "$zip_path"
  if ! xcrun notarytool submit "$zip_path" \
      --key "$api_key_path" \
      --key-id "$APPLE_API_KEY_ID" \
      --issuer "$APPLE_API_ISSUER" \
      --wait; then
    die "notarization failed; run 'xcrun notarytool log <submission-id>' with the same API key for the reason"
  fi
  # Stapling is the real gate: it fails unless the ticket exists.
  xcrun stapler staple "$APP_BUNDLE"
  xcrun stapler validate "$APP_BUNDLE"
  rm -f "$zip_path"
  note "notarized and stapled"
}

SIGNING_MODE="adhoc"
DEVELOPMENT_IDENTITY=""
if [ "$CONFIGURATION" = "debug" ]; then
  # Debug bundles are re-signed by dev-reload.sh, so they need an identity
  # that outlives this script: never the Developer ID from the temporary
  # keychain. An ad-hoc signature changes with every build, and Keychain asks
  # again for each one; a development certificate keeps the identity stable.
  DEVELOPMENT_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | awk '/"Apple Development: /{print $2; exit}')"
  if [ -n "$DEVELOPMENT_IDENTITY" ]; then
    SIGNING_MODE="development"
  fi
elif [ -n "$CSC_LINK" ] && [ -n "$CSC_KEY_PASSWORD" ]; then
  SIGNING_MODE="developer-id"
elif [ -n "$CSC_LINK" ] || [ -n "$CSC_KEY_PASSWORD" ]; then
  warn "partial Developer ID configuration: CSC_LINK and CSC_KEY_PASSWORD are both required; falling back to ad-hoc signing"
fi

if [ "$SIGNING_MODE" = "developer-id" ]; then
  import_signing_certificate
  note "signing with the Developer ID identity from CSC_LINK"
  # Nested code first: the outer signature seals whatever is inside it.
  codesign_with_identity "$APP_BUNDLE/Contents/Helpers/$HELPER_NAME" --identifier "$PROBE_NAME"
  link_sessions_helper
  codesign_with_identity "$APP_BUNDLE"
  codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"

  if [ -n "$APPLE_API_KEY_BASE64" ] && [ -n "$APPLE_API_KEY_ID" ] && [ -n "$APPLE_API_ISSUER" ]; then
    notarize_bundle
  else
    warn "APPLE_API_KEY_BASE64 / APPLE_API_KEY_ID / APPLE_API_ISSUER are not all set: the bundle is signed but NOT notarized, so first launch still shows a Gatekeeper warning"
  fi
elif [ "$SIGNING_MODE" = "development" ]; then
  note "signing with the keychain's Apple Development identity"
  # Not --deep, which would name the helper's signature after its file.
  codesign --force --identifier "$PROBE_NAME" --sign "$DEVELOPMENT_IDENTITY" "$APP_BUNDLE/Contents/Helpers/$HELPER_NAME"
  link_sessions_helper
  codesign --force --sign "$DEVELOPMENT_IDENTITY" "$APP_BUNDLE"
  codesign --verify --deep --strict "$APP_BUNDLE"
else
  note "ad-hoc signing (no Developer ID credentials in the environment)"
  codesign --force --identifier "$PROBE_NAME" --sign - "$APP_BUNDLE/Contents/Helpers/$HELPER_NAME"
  link_sessions_helper
  codesign --force --sign - "$APP_BUNDLE"
  codesign --verify --deep --strict "$APP_BUNDLE"
  cat >&2 <<EOF

  ****************************************************************************
  NOTICE: "$APP_NAME.app" is ad-hoc signed and not notarized.
  macOS will refuse to open it with "cannot be opened because it is from an
  unidentified developer". Users have to right-click the app and choose Open
  once (README.md documents this). Set CSC_LINK and CSC_KEY_PASSWORD (plus
  APPLE_API_KEY_BASE64, APPLE_API_KEY_ID and APPLE_API_ISSUER) to produce a
  distributable build.
  ****************************************************************************

EOF
fi

note "built $APP_BUNDLE"
note "  version      $VERSION (build $BUILD_NUMBER)"
note "  architecture $ARCH"
note "  probe        $PROBE_VERSION"
note "  signing      $SIGNING_MODE"
