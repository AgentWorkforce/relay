#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <cli-binary> <broker-binary>" >&2
  exit 2
fi

CLI_BIN="$1"
BROKER_BIN="$2"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agent-relay-standalone-smoke.XXXXXX")"
HOME_DIR="$TMP_ROOT/home"
PROJECT_DIR="$TMP_ROOT/project"

mkdir -p "$HOME_DIR" "$PROJECT_DIR"

cleanup() {
  (
    cd "$PROJECT_DIR"
    HOME="$HOME_DIR" \
      AGENT_RELAY_BIN="$BROKER_BIN" \
      AGENT_RELAY_SKIP_UPDATE_CHECK=1 \
      AGENT_RELAY_TELEMETRY_DISABLED=1 \
      "$CLI_BIN" down --force --timeout 5000 >/dev/null 2>&1 || true
  )
  rm -rf "$TMP_ROOT"
}

trap cleanup EXIT

run_cli() {
  (
    cd "$PROJECT_DIR"
    HOME="$HOME_DIR" \
      AGENT_RELAY_BIN="$BROKER_BIN" \
      AGENT_RELAY_SKIP_UPDATE_CHECK=1 \
      AGENT_RELAY_TELEMETRY_DISABLED=1 \
      "$CLI_BIN" "$@"
  )
}

assert_exact_count() {
  local output="$1"
  local pattern="$2"
  local expected="$3"
  local label="$4"
  local count

  count="$(printf '%s\n' "$output" | grep -E -c "$pattern" || true)"
  if [ "$count" -ne "$expected" ]; then
    echo "Unexpected $label count: expected $expected, got $count" >&2
    echo "--- output ---" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
}

echo "=== Smoke: standalone status ==="
STATUS_OUTPUT="$(run_cli status 2>&1 || true)"
assert_exact_count "$STATUS_OUTPUT" '^Status: STOPPED$' 1 'status line'

echo "=== Smoke: standalone down --force ==="
DOWN_OUTPUT="$(run_cli down --force 2>&1 || true)"
assert_exact_count "$DOWN_OUTPUT" '^Cleaned up \(was not running\)$' 1 'down cleanup line'

echo "=== Smoke: standalone up --no-dashboard ==="
UP_LOG="$TMP_ROOT/up.log"
set +e
run_cli up --no-dashboard >"$UP_LOG" 2>&1 &
UP_PID=$!
set -e

sleep 8
if kill -0 "$UP_PID" 2>/dev/null; then
  run_cli down --force --timeout 5000 >/dev/null 2>&1 || true
  wait "$UP_PID" || true
else
  wait "$UP_PID" || true
fi

UP_OUTPUT="$(cat "$UP_LOG")"
assert_exact_count "$UP_OUTPUT" '^\[broker\] Starting:' 1 'broker start line'

if printf '%s\n' "$UP_OUTPUT" | grep -q 'Broker already running for this project'; then
  echo "Standalone CLI reported a false already-running error" >&2
  echo "--- output ---" >&2
  printf '%s\n' "$UP_OUTPUT" >&2
  exit 1
fi

echo "Standalone smoke passed"
