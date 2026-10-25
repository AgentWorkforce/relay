#!/usr/bin/env bash
#
# package-dmg.sh -- wrap "Agent Relay.app" in a compressed disk image with the
# usual drag-to-/Applications layout, and write the image's SHA-256 next to it.
#
# Writes FILE.dmg and FILE.dmg.sha256 (a `sha256sum` format line naming the
# image's own file name, so `shasum -a 256 -c FILE.dmg.sha256` works from the
# directory the download landed in).
#
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_VOLUME_NAME="Agent Relay"

usage() {
  cat <<EOF
Usage:
  ${SCRIPT_NAME} --app "path/to/Agent Relay.app" --out path/to/FILE.dmg [--volname NAME]

Options:
  --app PATH       The .app bundle to package. Required.
  --out FILE.dmg   Disk image to write. Its directory is created when missing
                   and an existing image at that path is replaced. Required.
  --volname NAME   Volume name shown when the image is mounted.
                   Defaults to "${DEFAULT_VOLUME_NAME}".
  -h, --help       Show this help.

Requires dmgbuild (see scripts/dmg-requirements.txt), Swift and macOS tools.
EOF
}

die() {
  printf '%s: error: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

note() {
  printf '%s: %s\n' "$SCRIPT_NAME" "$*"
}

sha256_write() {
  # usage: sha256_write FILE  (run from the file's directory)
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1"
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    die "neither shasum nor sha256sum is available; cannot checksum the disk image"
  fi
}

APP_PATH=""
OUT_PATH=""
VOLUME_NAME="$DEFAULT_VOLUME_NAME"

while [ $# -gt 0 ]; do
  case "$1" in
    --app)
      [ $# -ge 2 ] || die "--app needs a path to an .app bundle"
      APP_PATH="$2"
      shift 2
      ;;
    --out)
      [ $# -ge 2 ] || die "--out needs a path ending in .dmg"
      OUT_PATH="$2"
      shift 2
      ;;
    --volname)
      [ $# -ge 2 ] || die "--volname needs a name"
      VOLUME_NAME="$2"
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

[ -n "$APP_PATH" ] || { usage >&2; die "--app is required"; }
[ -n "$OUT_PATH" ] || { usage >&2; die "--out is required"; }

[ "$(uname -s)" = "Darwin" ] || die "this script only runs on macOS (hdiutil, ditto)"
for tool in hdiutil ditto swift tiffutil dmgbuild; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool '$tool' not found"
done

[ -d "$APP_PATH" ] || die "no app bundle at $APP_PATH"
case "$APP_PATH" in
  *.app|*.app/) : ;;
  *) die "--app must point at a .app bundle, got: $APP_PATH" ;;
esac
case "$OUT_PATH" in
  *.dmg) : ;;
  *) die "--out must end in .dmg, got: $OUT_PATH" ;;
esac

APP_PATH="${APP_PATH%/}"
APP_BASENAME="$(basename "$APP_PATH")"

OUT_DIR="$(dirname "$OUT_PATH")"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
OUT_BASENAME="$(basename "$OUT_PATH")"
OUT_PATH="$OUT_DIR/$OUT_BASENAME"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/package-dmg.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

STAGING_DIR="$TMP_DIR/staging"
mkdir -p "$STAGING_DIR"

# ditto, not cp: it preserves the code signature, extended attributes and
# symlinks inside the bundle.
note "staging $APP_BASENAME"
ditto "$APP_PATH" "$STAGING_DIR/$APP_BASENAME"

note "rendering the Retina installer background"
swift "$SCRIPT_DIR/render-dmg-background.swift" "$TMP_DIR"
tiffutil -cathidpicheck "$TMP_DIR/background.png" "$TMP_DIR/background@2x.png" \
  -out "$TMP_DIR/background.tiff"

rm -f "$OUT_PATH"
note "creating $OUT_PATH"
# dmgbuild writes the Finder metadata directly, including fixed icon positions
# and a background alias. This also works on CI without a logged-in Finder.
dmgbuild \
  -s "$SCRIPT_DIR/dmg-settings.py" \
  -D "app=$STAGING_DIR/$APP_BASENAME" \
  -D "background=$TMP_DIR/background.tiff" \
  "$VOLUME_NAME" \
  "$OUT_PATH"

[ -f "$OUT_PATH" ] || die "hdiutil reported success but no image at $OUT_PATH"
hdiutil verify "$OUT_PATH"

( cd "$OUT_DIR" && sha256_write "$OUT_BASENAME" > "$OUT_BASENAME.sha256" )
chmod 0644 "$OUT_PATH.sha256"

note "wrote $OUT_PATH"
note "wrote $OUT_PATH.sha256"
