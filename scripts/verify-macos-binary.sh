#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 4 ] || [ "$3" != "--" ]; then
  echo "Usage: $0 <binary> <expected-arch> -- <smoke-args...>" >&2
  echo "Expected arch values: arm64, x86_64" >&2
  exit 2
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "macOS binary verification must run on a Darwin runner" >&2
  exit 1
fi

BINARY="$1"
EXPECTED_ARCH="$2"
shift 3
SMOKE_ARGS=("$@")

if [ ! -s "$BINARY" ]; then
  echo "Binary missing or empty: $BINARY" >&2
  exit 1
fi

chmod +x "$BINARY"

FILE_OUTPUT="$(file "$BINARY")"
echo "$FILE_OUTPUT"

case "$EXPECTED_ARCH" in
  arm64)
    if ! grep -q "Mach-O 64-bit executable arm64" <<<"$FILE_OUTPUT"; then
      echo "Expected an arm64 Mach-O executable" >&2
      exit 1
    fi
    ;;
  x86_64)
    if ! grep -q "Mach-O 64-bit executable x86_64" <<<"$FILE_OUTPUT"; then
      echo "Expected an x86_64 Mach-O executable" >&2
      exit 1
    fi
    ;;
  *)
    echo "Unsupported expected arch: $EXPECTED_ARCH" >&2
    exit 2
    ;;
esac

if ! codesign --verify --verbose=4 "$BINARY"; then
  echo "Code signature verification failed for $BINARY" >&2
  codesign -dv --verbose=4 "$BINARY" >&2 || true
  otool -l "$BINARY" | grep -A4 -B2 LC_CODE_SIGNATURE >&2 || true
  exit 1
fi

HOST_ARCH="$(uname -m)"
RUNNER=()

if [ "$EXPECTED_ARCH" = "$HOST_ARCH" ]; then
  RUNNER=("$BINARY")
elif [ "$EXPECTED_ARCH" = "x86_64" ] && [ "$HOST_ARCH" = "arm64" ] && arch -x86_64 /usr/bin/true 2>/dev/null; then
  RUNNER=(arch -x86_64 "$BINARY")
fi

if [ "${#RUNNER[@]}" -eq 0 ]; then
  echo "Skipping smoke execution for $EXPECTED_ARCH binary on $HOST_ARCH host after signature verification"
  exit 0
fi

"${RUNNER[@]}" "${SMOKE_ARGS[@]}"
echo "Verified macOS binary: $BINARY"
