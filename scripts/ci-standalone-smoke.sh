#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <cli-binary> <broker-binary>" >&2
  exit 2
fi

if [ -z "${RELAY_WORKSPACE_KEY:-}" ]; then
  echo "ERROR: RELAY_WORKSPACE_KEY must name the dedicated standalone-smoke CI workspace." >&2
  echo "Refusing to start without it because node up would create an undeletable throwaway workspace." >&2
  exit 2
fi

# The broker gives a multi-workspace session higher precedence than the single
# key. This smoke intentionally exercises one dedicated workspace, so do not
# let an ambient developer/runner session silently replace the CI credential.
unset RELAY_WORKSPACES_JSON

CLI_BIN="$1"
BROKER_BIN="$2"
BROKER_NAME="${AGENT_RELAY_STANDALONE_BROKER_NAME:-relay-ci-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${GITHUB_JOB:-standalone}-$$}"

validate_binary() {
  local label="$1"
  local path="$2"
  local dir

  if [ ! -e "$path" ]; then
    dir="$(dirname "$path")"
    echo "ERROR: $label binary not found: $path" >&2
    echo "Directory listing for $dir:" >&2
    ls -la "$dir/" 2>/dev/null >&2 || echo "  (directory does not exist)" >&2
    exit 1
  fi

  if [ ! -f "$path" ]; then
    echo "ERROR: $label binary is not a regular file: $path" >&2
    ls -ld "$path" >&2 || true
    exit 1
  fi

  if [ ! -x "$path" ]; then
    echo "ERROR: $label binary is not executable: $path" >&2
    ls -l "$path" >&2 || true
    echo "Hint: run chmod +x \"$path\" or rebuild the binary with executable permissions." >&2
    exit 1
  fi
}

validate_binary "CLI" "$CLI_BIN"
validate_binary "BROKER" "$BROKER_BIN"

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
      AGENT_RELAY_STARTUP_DEBUG=1 \
      AGENT_RELAY_TELEMETRY_DISABLED=1 \
      "$CLI_BIN" node down --force --timeout 5000 >/dev/null 2>&1 || true
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
      AGENT_RELAY_STARTUP_DEBUG=1 \
      AGENT_RELAY_TELEMETRY_DISABLED=1 \
      "$CLI_BIN" "$@"
  )
}

print_output_excerpt() {
  local output="$1"
  local total_lines

  total_lines="$(printf '%s\n' "$output" | wc -l | tr -d ' ')"
  if [ "$total_lines" -le 80 ]; then
    echo "--- output ---" >&2
    printf '%s\n' "$output" >&2
    return
  fi

  echo "--- output (first 40 lines) ---" >&2
  printf '%s\n' "$output" | sed -n '1,40p' >&2
  echo "--- output (last 40 lines; $total_lines total) ---" >&2
  printf '%s\n' "$output" | tail -n 40 >&2
}

assert_exact_count() {
  local output="$1"
  local pattern="$2"
  local expected="$3"
  local label="$4"
  local count

  count="$(printf '%s\n' "$output" | grep -E -c "$pattern" || true)"
  if [ "$count" -ne "$expected" ]; then
    if [ "$label" = "broker start line" ]; then
      echo "Broker startup readiness line missing or duplicated: expected $expected, got $count" >&2
      echo "Expected pattern: $pattern" >&2
      echo "AGENT_RELAY_STARTUP_DEBUG=1 was enabled for startup diagnostics." >&2
    else
      echo "Unexpected $label count: expected $expected, got $count" >&2
    fi
    print_output_excerpt "$output"
    exit 1
  fi
}

echo "=== Smoke: standalone status ==="
STATUS_OUTPUT="$(run_cli node status 2>&1 || true)"
assert_exact_count "$STATUS_OUTPUT" '^Status: STOPPED$' 1 'status line'

echo "=== Smoke: standalone down --force ==="
DOWN_OUTPUT="$(run_cli node down --force 2>&1 || true)"
assert_exact_count "$DOWN_OUTPUT" '^Cleaned up \(was not running\)$' 1 'down cleanup line'

echo "=== Smoke: standalone up ==="
UP_LOG="$TMP_ROOT/up.log"
run_cli node up --broker-name "$BROKER_NAME" >"$UP_LOG" 2>&1 &
UP_PID=$!

UP_EXIT=""
UP_READY=false
# Startup can legitimately need to retry a Relaycast handshake on a loaded
# macOS runner. Do not begin teardown on a fixed timer while that retry is in
# flight; wait for the CLI's explicit readiness line instead.
STARTUP_TIMEOUT_SECONDS="${AGENT_RELAY_STANDALONE_STARTUP_TIMEOUT_SECONDS:-30}"
STARTUP_DEADLINE=$((SECONDS + STARTUP_TIMEOUT_SECONDS))
while true; do
  if grep -q 'Broker started\.' "$UP_LOG"; then
    UP_READY=true
    break
  fi
  if ! kill -0 "$UP_PID" 2>/dev/null; then
    break
  fi
  if [ "$SECONDS" -ge "$STARTUP_DEADLINE" ]; then
    echo "Standalone broker did not report readiness within ${STARTUP_TIMEOUT_SECONDS}s" >&2
    break
  fi
  sleep 0.25
done

if kill -0 "$UP_PID" 2>/dev/null; then
  run_cli node down --force --timeout 5000 >/dev/null 2>&1 || true
  # Hard-kill after 15s if down --force didn't terminate the process (e.g. macOS 26 hang)
  ( sleep 15 && kill -9 "$UP_PID" 2>/dev/null || true ) &
  KILLER_PID=$!
  wait "$UP_PID" || true
  kill "$KILLER_PID" 2>/dev/null || true
else
  if wait "$UP_PID"; then
    UP_EXIT=0
  else
    UP_EXIT=$?
  fi
fi

UP_OUTPUT="$(cat "$UP_LOG")"
if [ -n "$UP_EXIT" ] && [ "$UP_EXIT" -ne 0 ]; then
  echo "Standalone broker startup command exited early with status $UP_EXIT" >&2
  echo "AGENT_RELAY_STARTUP_DEBUG=1 was enabled for startup diagnostics." >&2
  print_output_excerpt "$UP_OUTPUT"
  exit "$UP_EXIT"
fi

if [ "$UP_READY" != true ]; then
  echo "Standalone broker startup command did not become ready" >&2
  echo "AGENT_RELAY_STARTUP_DEBUG=1 was enabled for startup diagnostics." >&2
  print_output_excerpt "$UP_OUTPUT"
  exit 1
fi

assert_exact_count "$UP_OUTPUT" 'Broker started\.' 1 'broker start line'
# The literal dollar sign proves which environment variable won selection.
# shellcheck disable=SC2016
assert_exact_count "$UP_OUTPUT" 'Workspace source: environment \(\$RELAY_WORKSPACE_KEY\)' 1 'workspace source line'

if printf '%s\n' "$UP_OUTPUT" | grep -q 'Workspace: created new workspace'; then
  echo "Standalone smoke created a workspace instead of reusing the dedicated CI workspace" >&2
  print_output_excerpt "$UP_OUTPUT"
  exit 1
fi

assert_exact_count "$UP_OUTPUT" '^Workspace: joined ' 1 'workspace joined line'

if printf '%s\n' "$UP_OUTPUT" | grep -q 'Broker already running for this project'; then
  echo "Standalone CLI reported a false already-running error" >&2
  echo "--- output ---" >&2
  printf '%s\n' "$UP_OUTPUT" >&2
  exit 1
fi

echo "Standalone smoke passed"
