#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ARTIFACTS_DIR="$REPO_ROOT/.e2e-artifacts"
SUMMARY_JSON="$ARTIFACTS_DIR/ci-summary.json"
SUMMARY_MD="$ARTIFACTS_DIR/ci-summary.md"
mkdir -p "$ARTIFACTS_DIR"

cleanup() {
  if command -v agent-relay >/dev/null 2>&1; then
    agent-relay down >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export RELAY_CLEANROOM_CI=1

run_id=""
status="failed"
if output=$(env PATH="$PATH" agent-relay run workflows/relay-clean-room-e2e-validation.ts 2>&1); then
  status="completed"
else
  status="failed"
fi
printf '%s
' "$output" | tee "$ARTIFACTS_DIR/ci-run.log"

run_id=$(printf '%s
' "$output" | sed -n 's/^  Run ID:[[:space:]]*//p' | tail -n 1 | xargs || true)
verdict_file="$ARTIFACTS_DIR/verdict.md"
if [[ -f "$verdict_file" ]]; then
  overall=$(grep -E '^\*\*Overall verdict:' "$verdict_file" | head -n1 | sed 's/^\*\*Overall verdict:[[:space:]]*//; s/\*\*$//' || true)
else
  overall="missing"
fi

python3 - <<PY
import json, pathlib
root = pathlib.Path(${SUMMARY_JSON@Q})
data = {
  "status": ${status@Q},
  "runId": ${run_id@Q},
  "verdict": ${overall@Q},
  "artifactsDir": ${ARTIFACTS_DIR@Q},
  "verdictFile": ${verdict_file@Q},
}
root.write_text(json.dumps(data, indent=2) + "\n")
PY

cat > "$SUMMARY_MD" <<EOF
# Relay Clean-Room CI Summary

- Status: **$status**
- Run ID: \
  - \
    \
${run_id:-unknown}
- Verdict: **${overall:-missing}**
- Artifacts: \
  - \
    \
$ARTIFACTS_DIR

## Notes
- This CI wrapper runs the clean-room validation workflow directly.
- It is most useful as a hardening check for install/bootstrap/local-mode changes.
- A conditional verdict can still be useful when the only gap is worker-auth in an isolated environment.
EOF

if [[ "$status" != "completed" ]]; then
  exit 1
fi
