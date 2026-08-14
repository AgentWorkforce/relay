#!/usr/bin/env bash
# proof/start-scratch-node.sh — start a named scratch broker with a pinned
# broker binary, isolated state dir, and the fleet's workspace key copied in.
#
# Purpose: run the positive/control arms of the terminal-attach proof by
# giving each broker a distinct identity while joining the same production
# workspace.
#
# Usage:
#   proof/start-scratch-node.sh --name proof-fixed-0815 \
#     --binary /Users/khaliqgant/Projects/AgentWorkforce/relay/lane-proof/target/debug/agent-relay-broker \
#     --state-dir /tmp/proof-fixed
#
# The state dir is created if missing. If it already exists it is left alone
# (workspace-key.json is only copied when absent, so re-running is idempotent).
#
# Does NOT push to the fleet — that happens as a side effect of `agent-relay
# node up` and is exactly what the proof needs. Do run
# proof/stop-scratch-node.sh after each use to avoid stale fleet entries.

set -euo pipefail

NAME=""
BINARY=""
STATE_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)      NAME="$2";      shift 2 ;;
    --binary)    BINARY="$2";    shift 2 ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$NAME"      ]] || { echo "--name required" >&2;      exit 2; }
[[ -n "$BINARY"    ]] || { echo "--binary required" >&2;    exit 2; }
[[ -n "$STATE_DIR" ]] || { echo "--state-dir required" >&2; exit 2; }

# Fail fast on absent binary. Path-check the exact file we intend to run so a
# stale symlink or missing debug build shows up as an error, not a fallback
# to whichever agent-relay-broker $PATH resolves to next.
[[ -x "$BINARY" ]] || { echo "not an executable: $BINARY" >&2; exit 3; }

# Real (non-symlink) canonical path, so we can compare against the running
# process below by absolute path rather than by what argv[0] happened to be.
BINARY_ABS="$(cd "$(dirname "$BINARY")" && pwd -P)/$(basename "$BINARY")"
echo "start-scratch-node: name=$NAME"
echo "start-scratch-node: binary=$BINARY_ABS"
echo "start-scratch-node: state-dir=$STATE_DIR"
echo "start-scratch-node: binary-sha256=$(shasum -a 256 "$BINARY_ABS" | cut -d' ' -f1)"

mkdir -p "$STATE_DIR"

# Copy the fleet workspace key iff the scratch state dir does not already
# have one — this is what makes the scratch node join the existing fleet
# workspace rather than mint a fresh one (issue #1378: fresh node up
# silently mints a workspace). Never pass the key on argv; that would
# leak via `ps` output until #1380 lands.
FLEET_KEY="$HOME/.agentworkforce/relay/workspace-key.json"
SCRATCH_KEY="$STATE_DIR/workspace-key.json"
if [[ ! -f "$SCRATCH_KEY" ]]; then
  [[ -f "$FLEET_KEY" ]] || { echo "no fleet workspace-key.json at $FLEET_KEY" >&2; exit 4; }
  cp "$FLEET_KEY" "$SCRATCH_KEY"
  chmod 600 "$SCRATCH_KEY"
fi

# Explicit env scrub: unset every AGENT_RELAY_* var that could bind this
# scratch node to sf-mini's identity. AGENT_RELAY_CLOUD_WORKSPACE_ID is
# derived from the copied workspace-key anyway. AGENT_RELAY_BIN is pinned
# to force the CLI to spawn the exact broker we care about, not whatever
# $PATH-resolved agent-relay-broker the CLI would pick otherwise. RUST_LOG
# ensures relay_broker::terminal traces are on — the bug that motivated
# this proof hid because that target was off in prod.
LOG_FILE="$STATE_DIR/node.log"
echo "start-scratch-node: starting in background, logs -> $LOG_FILE"

env \
  -u AGENT_RELAY_BROKER_NAME \
  -u AGENT_RELAY_BROKER_PORT \
  -u AGENT_RELAY_ENROLLED_NODE_ID \
  -u AGENT_RELAY_MACHINE_ID \
  -u AGENT_RELAY_DISTINCT_ID \
  -u AGENT_RELAY_CLOUD_WORKSPACE_ID \
  AGENT_RELAY_BIN="$BINARY_ABS" \
  RUST_LOG="relay_broker::terminal=debug,relay_broker=info" \
  agent-relay node up \
    --broker-name "$NAME" \
    --state-dir "$STATE_DIR" \
    --no-spawn \
    --background \
    --log-file "$LOG_FILE" \
    --log-json

echo "start-scratch-node: node up returned; sleeping 3s so registration completes"
sleep 3

# Positive assertion: the running broker process's exe path resolves to
# BINARY_ABS. Matches the "check the binary, not your intention" rule —
# we're not comparing two possibly-empty values, we're asserting a
# specific path is present in the process listing.
BROKER_PATH="$(ps -o pid=,command= -ax | awk -v pat="$BINARY_ABS" -v name="$NAME" '
  $0 ~ pat && $0 ~ name { print $2; exit }
')"
if [[ -z "$BROKER_PATH" ]]; then
  echo "start-scratch-node: WARNING — broker process at $BINARY_ABS with name $NAME not found in ps" >&2
  ps -ax | grep -E "agent-relay-broker|node up" | grep -v grep || true
  exit 5
fi
echo "start-scratch-node: confirmed live broker binary at $BROKER_PATH"
