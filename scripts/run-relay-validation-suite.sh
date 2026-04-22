#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

META_WORKFLOW="workflows/relay-e2e-meta-workflow.ts"
GENERATED_WORKFLOW="workflows/relay-clean-room-e2e-validation.ts"
ARTIFACT_DIR="$REPO_ROOT/.e2e-artifacts/master-run"
mkdir -p "$ARTIFACT_DIR"

log() {
  printf '[relay-validation-suite] %s\n' "$*"
}

run_workflow() {
  local name="$1"
  local file="$2"
  local log_file="$3"

  log "running $name: $file"
  if ! env PATH="$HOME/.local/bin:$PATH" agent-relay run "$file" 2>&1 | tee "$log_file"; then
    log "$name failed; see $log_file"
    return 1
  fi
}

log "repo: $REPO_ROOT"
log "starting ordered validation suite"

run_workflow "meta-workflow" "$META_WORKFLOW" "$ARTIFACT_DIR/meta-workflow.log"

if [[ ! -f "$GENERATED_WORKFLOW" ]]; then
  log "generated workflow missing after meta-workflow: $GENERATED_WORKFLOW"
  exit 1
fi

run_workflow "clean-room workflow" "$GENERATED_WORKFLOW" "$ARTIFACT_DIR/clean-room-workflow.log"

cat > "$ARTIFACT_DIR/summary.txt" <<EOF
relay validation suite completed successfully
completed_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
meta_workflow: $META_WORKFLOW
generated_workflow: $GENERATED_WORKFLOW
meta_log: $ARTIFACT_DIR/meta-workflow.log
clean_room_log: $ARTIFACT_DIR/clean-room-workflow.log
EOF

log "suite completed successfully"
log "summary: $ARTIFACT_DIR/summary.txt"
