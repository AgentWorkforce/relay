#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <cli-binary> <broker-binary>" >&2
  exit 2
fi

# The standalone smoke is deliberately pinned to the trusted hosted Relaycast
# engine. Do not make this caller-selectable: the workspace key created below
# is scoped to this origin and must never be sent to an arbitrary endpoint.
TRUSTED_RELAY_BASE_URL="https://cast.agentrelay.com"

# The broker gives a multi-workspace session higher precedence than the single
# key. This smoke intentionally exercises one ephemeral workspace, so do not
# let an ambient developer/runner session silently replace the CI credential.
unset RELAY_WORKSPACES_JSON RELAY_WORKSPACE_KEY AGENT_RELAY_WORKSPACE_KEY RELAY_API_KEY \
  RELAYCAST_BASE_URL RELAY_AGENT_TOKEN RELAY_WORKSPACE

# Startup can legitimately consume the broker's 40-second aggregate Relaycast
# handshake budget on a loaded macOS runner. Keep the outer supervisor at
# least ten seconds above that bound so an override cannot reintroduce the race
# this smoke is meant to catch.
MIN_STARTUP_TIMEOUT_SECONDS=60
# Keep every accepted startup override inside the ephemeral workspace lease,
# with a full minute left for shutdown and deletion verification.
WORKSPACE_LEASE_SECONDS=300
MAX_STARTUP_TIMEOUT_SECONDS=240
CURL_CONNECT_TIMEOUT_SECONDS=10
CURL_MAX_TIME_SECONDS=60
CLEANUP_VERIFY_MAX_ATTEMPTS=3
CLEANUP_VERIFY_MAX_TIME_SECONDS=10
CLEANUP_VERIFY_FALLBACK_DELAY_SECONDS=2
STARTUP_TIMEOUT_SECONDS="${AGENT_RELAY_STANDALONE_STARTUP_TIMEOUT_SECONDS:-60}"
if ! [[ "$STARTUP_TIMEOUT_SECONDS" =~ ^[1-9][0-9]{0,4}$ ]]; then
  echo "ERROR: AGENT_RELAY_STANDALONE_STARTUP_TIMEOUT_SECONDS must be a base-10 integer between ${MIN_STARTUP_TIMEOUT_SECONDS}s and ${MAX_STARTUP_TIMEOUT_SECONDS}s without leading zeros." >&2
  exit 2
fi
if [ "$STARTUP_TIMEOUT_SECONDS" -lt "$MIN_STARTUP_TIMEOUT_SECONDS" ]; then
  echo "ERROR: AGENT_RELAY_STANDALONE_STARTUP_TIMEOUT_SECONDS must be at least ${MIN_STARTUP_TIMEOUT_SECONDS}s to cover the broker handshake budget." >&2
  exit 2
fi
if [ "$STARTUP_TIMEOUT_SECONDS" -gt "$MAX_STARTUP_TIMEOUT_SECONDS" ]; then
  echo "ERROR: AGENT_RELAY_STANDALONE_STARTUP_TIMEOUT_SECONDS must be no more than ${MAX_STARTUP_TIMEOUT_SECONDS}s." >&2
  exit 2
fi

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
WORKSPACE_RESPONSE="$TMP_ROOT/workspace-response.json"
DELETE_RESPONSE="$TMP_ROOT/delete-response.json"
VERIFY_HEADERS="$TMP_ROOT/verify-headers.txt"

mkdir -p "$HOME_DIR" "$PROJECT_DIR"

CLEANUP_STARTED=false
WORKSPACE_KEY=""
WORKSPACE_ID=""
cleanup() {
  if [ "$CLEANUP_STARTED" = true ]; then
    return 0
  fi
  CLEANUP_STARTED=true
  local cleanup_status=0
  # Disarm before entering the cleanup subshell. Some Bash exit paths can
  # otherwise inherit this EXIT trap and recursively run node down again.
  trap - EXIT
  (
    cd "$PROJECT_DIR"
    HOME="$HOME_DIR" \
      RELAY_BASE_URL="$TRUSTED_RELAY_BASE_URL" \
      AGENT_RELAY_BIN="$BROKER_BIN" \
      AGENT_RELAY_SKIP_UPDATE_CHECK=1 \
      AGENT_RELAY_STARTUP_DEBUG=1 \
      AGENT_RELAY_TELEMETRY_DISABLED=1 \
      RELAY_WORKSPACE_KEY="$WORKSPACE_KEY" \
      "$CLI_BIN" node down --force --timeout 5000 >/dev/null 2>&1 || true
  )
  if [ -n "$WORKSPACE_KEY" ]; then
    local delete_status delete_error_code delete_error_code_raw verify_status verify_attempt verify_delay
    delete_status="$(curl --silent --show-error --output "$DELETE_RESPONSE" --write-out '%{http_code}' \
      --connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS" --max-time "$CURL_MAX_TIME_SECONDS" \
      --request DELETE \
      --header "Authorization: Bearer $WORKSPACE_KEY" \
      "$TRUSTED_RELAY_BASE_URL/v1/workspace" 2>/dev/null || true)"
    delete_error_code_raw="$(jq -er '.error.code // .code // empty' "$DELETE_RESPONSE" 2>/dev/null || true)"
    delete_error_code=""
    case "$delete_error_code_raw" in
      internal_error|workspace_storage_unavailable|database_overloaded|file_storage_delete_unsupported)
        delete_error_code="$delete_error_code_raw"
        ;;
      ?*) delete_error_code="other" ;;
    esac
    if [ "$delete_status" = "200" ] || [ "$delete_status" = "204" ]; then
      # The engine only returns success after its atomic deletion batch commits.
      # A second database read would add an unrelated availability dependency.
      echo "Ephemeral workspace deletion verified"
    else
      verify_attempt=1
      while [ "$verify_attempt" -le "$CLEANUP_VERIFY_MAX_ATTEMPTS" ]; do
        verify_status="$(curl --silent --show-error --output /dev/null --dump-header "$VERIFY_HEADERS" \
          --write-out '%{http_code}' \
          --connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS" --max-time "$CLEANUP_VERIFY_MAX_TIME_SECONDS" \
          --request GET \
          --header "Authorization: Bearer $WORKSPACE_KEY" \
          "$TRUSTED_RELAY_BASE_URL/v1/workspace" 2>/dev/null || true)"
        case "$verify_status" in
          401) break ;;
          000|429|5??)
            if [ "$verify_attempt" -lt "$CLEANUP_VERIFY_MAX_ATTEMPTS" ]; then
              # Relaycast advertises integer Retry-After values from 2–8s for
              # database overload. Accept only that bounded vocabulary; a
              # malformed, date-form, or excessive value falls back to 2s.
              verify_delay="$(awk '
                {
                  line = $0
                  gsub(/\r/, "", line)
                }
                tolower(line) ~ /^retry-after:[[:space:]]*/ {
                  sub(/^[^:]*:[[:space:]]*/, "", line)
                  value = line
                }
                END { print value }
              ' "$VERIFY_HEADERS" 2>/dev/null || true)"
              case "$verify_delay" in
                0|1|2|3|4|5|6|7|8) ;;
                *) verify_delay="$CLEANUP_VERIFY_FALLBACK_DELAY_SECONDS" ;;
              esac
              sleep "$verify_delay"
              verify_attempt=$((verify_attempt + 1))
              continue
            fi
            ;;
        esac
        break
      done
      # A 5xx response can be lost after the database commit. The workspace key
      # was proven valid by the lifecycle above, so 401 from the same key is the
      # authoritative absence check. Transient verification reads get a bounded
      # retry window; any readable or still-unverifiable state remains a hard
      # failure.
      if [ "$verify_status" = "401" ]; then
        echo "Ephemeral workspace deletion verified after ambiguous DELETE HTTP ${delete_status:-unknown}${delete_error_code:+, error code $delete_error_code}"
      else
        echo "ERROR: ephemeral workspace cleanup returned HTTP ${delete_status:-unknown}${delete_error_code:+, error code $delete_error_code}." >&2
        echo "ERROR: ephemeral workspace deletion was not proved (follow-up HTTP ${verify_status:-unknown})." >&2
        echo "The workspace id is ${WORKSPACE_ID:-unknown}; remove it manually from the trusted smoke shard." >&2
        cleanup_status=1
      fi
    fi
  fi
  rm -rf "$TMP_ROOT"
  return "$cleanup_status"
}

trap cleanup EXIT

run_cli() {
  (
    cd "$PROJECT_DIR"
    HOME="$HOME_DIR" \
      RELAY_BASE_URL="$TRUSTED_RELAY_BASE_URL" \
      RELAY_WORKSPACE_KEY="$WORKSPACE_KEY" \
      AGENT_RELAY_BIN="$BROKER_BIN" \
      AGENT_RELAY_SKIP_UPDATE_CHECK=1 \
      AGENT_RELAY_STARTUP_DEBUG=1 \
      AGENT_RELAY_TELEMETRY_DISABLED=1 \
      "$CLI_BIN" "$@"
  )
}

if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl is required to create and delete the ephemeral smoke workspace." >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required to parse the ephemeral smoke workspace response." >&2
  exit 2
fi

WORKSPACE_NAME="relay-standalone-smoke-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"
CREATE_STATUS="$(curl --silent --show-error --output "$WORKSPACE_RESPONSE" --write-out '%{http_code}' \
  --connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS" --max-time "$CURL_MAX_TIME_SECONDS" \
  --request POST \
  --header 'Content-Type: application/json' \
  --data "$(jq -cn --arg name "$WORKSPACE_NAME" --argjson expires "$WORKSPACE_LEASE_SECONDS" '{name: $name, expires_in_seconds: $expires}')" \
  "$TRUSTED_RELAY_BASE_URL/v1/workspaces" 2>/dev/null || true)"
# Mask the key before extracting or using any other response field. Never log
# the response body: it contains the administrative workspace credential.
WORKSPACE_KEY="$(jq -er '.data.api_key // .api_key // empty' "$WORKSPACE_RESPONSE" 2>/dev/null || true)"
CREATE_ERROR_CODE="$(jq -er '.error.code // .code // empty' "$WORKSPACE_RESPONSE" 2>/dev/null || true)"
if [ -n "$WORKSPACE_KEY" ]; then
  printf '::add-mask::%s\n' "$WORKSPACE_KEY"
fi
if [ -z "$WORKSPACE_KEY" ]; then
  echo "ERROR: ephemeral smoke workspace response did not contain an API key (HTTP ${CREATE_STATUS:-unknown}${CREATE_ERROR_CODE:+, error code ${CREATE_ERROR_CODE}})." >&2
  exit 1
fi
if [[ ! "$WORKSPACE_KEY" =~ ^rk_live_[A-Za-z0-9_-]+$ ]]; then
  echo "ERROR: ephemeral smoke workspace response contained an invalid API key scheme." >&2
  exit 1
fi
WORKSPACE_ID="$(jq -er '.data.workspace_id // .workspace_id // empty' "$WORKSPACE_RESPONSE" 2>/dev/null || true)"
if [ -z "$WORKSPACE_ID" ]; then
  echo "ERROR: ephemeral smoke workspace response did not contain a workspace id." >&2
  exit 1
fi
if [ "$CREATE_STATUS" != "200" ] && [ "$CREATE_STATUS" != "201" ]; then
  echo "ERROR: ephemeral smoke workspace creation returned HTTP ${CREATE_STATUS:-unknown}." >&2
  exit 1
fi
echo "Ephemeral workspace created on trusted smoke shard (id ${WORKSPACE_ID})"

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
DOWN_OUTPUT="$(run_cli node down --force 2>&1)"
assert_exact_count "$DOWN_OUTPUT" '^No verified orphan broker found; retained existing state\.$' 1 'down preservation line'

echo "=== Smoke: standalone up ==="
UP_LOG="$TMP_ROOT/up.log"
run_cli node up --broker-name "$BROKER_NAME" >"$UP_LOG" 2>&1 &
UP_PID=$!

UP_EXIT=""
UP_READY=false
UP_EXITED_BEFORE_READY=false
STARTUP_DEADLINE=$((SECONDS + STARTUP_TIMEOUT_SECONDS))
while true; do
  if grep -q 'Broker started\.' "$UP_LOG"; then
    UP_READY=true
    break
  fi
  if ! kill -0 "$UP_PID" 2>/dev/null; then
    UP_EXITED_BEFORE_READY=true
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
  # Disarm before fork: cancellation can arrive before the child runs its
  # first command, when an inherited EXIT trap would delete the workspace.
  trap - EXIT
  ( sleep 15 && kill -9 "$UP_PID" 2>/dev/null || true ) >/dev/null 2>&1 &
  KILLER_PID=$!
  trap cleanup EXIT
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
# A short-lived CLI can write readiness and exit between the polling loop's
# log check and process-liveness check. Re-read the completed log only for
# that exit race; never accept readiness written after the startup deadline.
if [ "$UP_READY" != true ] && [ "$UP_EXITED_BEFORE_READY" = true ] && grep -q 'Broker started\.' "$UP_LOG"; then
  UP_READY=true
fi
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
echo "Workspace reuse verified: joined the dedicated CI workspace"

if printf '%s\n' "$UP_OUTPUT" | grep -q 'Broker already running for this project'; then
  echo "Standalone CLI reported a false already-running error" >&2
  echo "--- output ---" >&2
  printf '%s\n' "$UP_OUTPUT" >&2
  exit 1
fi

if ! cleanup; then
  echo "Standalone smoke lifecycle passed but ephemeral workspace cleanup was not proved" >&2
  exit 1
fi
echo "Standalone smoke passed"
