#!/usr/bin/env bash
# proof/stop-scratch-node.sh — stop a scratch broker started by
# start-scratch-node.sh and clean up its state dir.
#
# Usage:
#   proof/stop-scratch-node.sh --name proof-fixed-0815 --state-dir /tmp/proof-fixed
#
# Explicit cleanup, per the lead brief's "kill every node and agent you
# start, remove scratch state dirs".

set -euo pipefail

NAME=""
STATE_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)      NAME="$2";      shift 2 ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$NAME"      ]] || { echo "--name required" >&2;      exit 2; }
[[ -n "$STATE_DIR" ]] || { echo "--state-dir required" >&2; exit 2; }

echo "stop-scratch-node: name=$NAME state-dir=$STATE_DIR"

# Stop the broker via the CLI (uses connection.json in the state dir).
agent-relay node down --state-dir "$STATE_DIR" || echo "stop-scratch-node: node down returned nonzero (may already be down)"

# Give it a moment to write out its shutdown, then remove the state dir.
sleep 2
rm -rf "$STATE_DIR"

# Belt-and-braces: kill any broker still running under the scratch name.
# `pgrep -f` matches the command line, so this catches `agent-relay-broker
# ... --broker-name proof-fixed-0815` reliably.
if pgrep -f "agent-relay-broker.*--broker-name $NAME" >/dev/null 2>&1; then
  echo "stop-scratch-node: leftover broker with name $NAME, killing"
  pkill -f "agent-relay-broker.*--broker-name $NAME" || true
fi

echo "stop-scratch-node: done"
