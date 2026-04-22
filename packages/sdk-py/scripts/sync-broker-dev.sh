#!/usr/bin/env bash
# Copy a locally-built agent-relay-broker into the wheel tree so that an
# editable install (`pip install -e packages/sdk-py`) can find it without
# needing to set BROKER_BINARY_PATH or place it on PATH.
#
# Run after `cargo build --release --bin agent-relay-broker`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SRC_RELEASE="$REPO_ROOT/target/release/agent-relay-broker"
SRC_DEBUG="$REPO_ROOT/target/debug/agent-relay-broker"
DEST_DIR="$REPO_ROOT/packages/sdk-py/src/agent_relay/bin"
DEST="$DEST_DIR/agent-relay-broker"

if [ -f "$SRC_RELEASE" ]; then
  SRC="$SRC_RELEASE"
elif [ -f "$SRC_DEBUG" ]; then
  SRC="$SRC_DEBUG"
else
  echo "error: no agent-relay-broker built at $SRC_RELEASE or $SRC_DEBUG" >&2
  echo "run: cargo build --release --bin agent-relay-broker" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
cp "$SRC" "$DEST"
chmod +x "$DEST"
echo "synced $SRC -> $DEST"
