#!/bin/bash
set -euo pipefail

STANDALONE_CLI="${1:?usage: $0 /path/to/agent-relay-standalone}"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agent-relay-workflow-smoke.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

mkdir -p "$TMP_ROOT/node_modules/@relayflows/cli/dist"
cat > "$TMP_ROOT/node_modules/@relayflows/cli/package.json" <<'JSON'
{"name":"@relayflows/cli","version":"0.0.0-smoke","type":"module","exports":"./dist/cli.js"}
JSON
cat > "$TMP_ROOT/node_modules/@relayflows/cli/dist/cli.js" <<'JS'
console.log(`no-allocation workflow completed: ${process.argv.slice(2).join(' ')}`);
JS
cat > "$TMP_ROOT/workflow.yaml" <<'YAML'
version: "1.0"
workflows: []
YAML

run_output="$(cd "$TMP_ROOT" && AGENT_RELAY_TELEMETRY_DISABLED=1 "$STANDALONE_CLI" node workflow run workflow.yaml)"
printf '%s\n' "$run_output"
run_id="$(printf '%s\n' "$run_output" | sed -n 's/^Run created: //p')"
if [ -z "$run_id" ]; then
  echo "ERROR: standalone workflow smoke did not create a run" >&2
  exit 1
fi

logs_output="$(cd "$TMP_ROOT" && AGENT_RELAY_TELEMETRY_DISABLED=1 "$STANDALONE_CLI" node workflow logs "$run_id" --follow --poll-interval 1)"
printf '%s\n' "$logs_output"
if ! printf '%s\n' "$logs_output" | grep -q 'no-allocation workflow completed'; then
  echo "ERROR: standalone workflow smoke did not surface terminal logs" >&2
  exit 1
fi

status_output="$(cd "$TMP_ROOT" && AGENT_RELAY_TELEMETRY_DISABLED=1 "$STANDALONE_CLI" node workflow logs "$run_id" --json)"
printf '%s\n' "$status_output"
if ! printf '%s\n' "$status_output" | grep -q '"status": "completed"'; then
  echo "ERROR: standalone workflow smoke did not reach completed status" >&2
  exit 1
fi

echo "Standalone workflow smoke passed"

# Cloud worker archives intentionally omit node_modules. Exercise the
# standalone binary's bundled relayflows-core path from a project with no
# dependency tree at all, which is the Cloud assignment shape.
BUNDLED_ROOT="$TMP_ROOT/bundled-cloud"
mkdir -p "$BUNDLED_ROOT"
cat > "$BUNDLED_ROOT/workflow.yaml" <<'YAML'
version: "1.0"
name: "standalone-cloud-smoke"
swarm:
  pattern: sequential
agents: []
workflows:
  - name: smoke
    steps:
      - name: noop
        type: deterministic
        command: "printf bundled-workflow-ok"
YAML

bundled_output="$(cd "$BUNDLED_ROOT" && AGENT_RELAY_TELEMETRY_DISABLED=1 "$STANDALONE_CLI" __bundled-workflow run workflow.yaml)"
printf '%s\n' "$bundled_output"
if ! printf '%s\n' "$bundled_output" | grep -q 'Workflow completed successfully'; then
  echo "ERROR: standalone bundled workflow smoke did not complete" >&2
  exit 1
fi

echo "Standalone bundled Cloud workflow smoke passed"
