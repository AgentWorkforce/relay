#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <binary>" >&2
  exit 2
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "macOS signing must run on a Darwin runner" >&2
  exit 1
fi

BINARY="$1"

if [ ! -f "$BINARY" ]; then
  echo "Binary not found: $BINARY" >&2
  exit 1
fi

chmod +x "$BINARY"

# Bun-compiled Mach-O files can contain an LC_CODE_SIGNATURE that macOS reports
# as invalid or unsupported. codesign --force cannot repair that state directly,
# so remove any existing signature first and then apply an ad-hoc signature.
codesign --remove-signature "$BINARY" 2>/dev/null || true
codesign --force --sign - "$BINARY"
codesign --verify --verbose=4 "$BINARY"

echo "Signed macOS binary: $BINARY"
