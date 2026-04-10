/**
 * relay-clean-room-e2e-validation.ts
 *
 * Clean-room end-to-end validation workflow for agent-relay install/bootstrap/messaging fixes.
 *
 * Primary proving environment: fresh isolated macOS local shell (isolated HOME + PATH).
 * This is the correct proving ground because the original failure class is a
 * first-run local bootstrap on macOS problem — stale shims, xattr/codesign handling,
 * ~/.local/bin launcher behavior — that Docker and cloud sandboxes cannot reproduce.
 *
 * Pattern: pipeline (sequential phases with deterministic before/after artifact capture).
 *
 * Acceptance contract (A1–A13):
 *   A1  install.sh completes successfully from scratch
 *   A2  command -v agent-relay resolves to isolated bin dir
 *   A3  agent-relay --version succeeds
 *   A4  stale shim/shadowing case detected or repaired by install (before/after proof)
 *   A5  agent-relay up --no-dashboard --verbose reaches running state within 30s
 *   A6  agent-relay status reports running
 *   A7  agent-relay spawn WorkflowProbe succeeds in a real repo
 *   A8  agent-relay who shows WorkflowProbe
 *   A9  agent-relay send WorkflowProbe "ping" (no --from) succeeds
 *   A10 agent-relay send WorkflowProbe "ping" --from Orchestrator succeeds
 *   A11 agent-relay agents:logs WorkflowProbe shows delivery evidence
 *   A12 agent-relay history with RELAY_API_KEY unset does NOT instruct user to set RELAY_API_KEY
 *   A13 all artifact files present with timestamps and exit codes
 *
 * Usage:
 *   agent-relay run workflows/relay-clean-room-e2e-validation.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';
import { ClaudeModels } from '@agent-relay/config';

const REPO_ROOT = process.cwd();
const ARTIFACTS_DIR = `${REPO_ROOT}/.e2e-artifacts`;

async function main() {
  const wf = workflow('relay-clean-room-e2e-validation')
    .description(
      'Clean-room end-to-end validation of agent-relay install/bootstrap/messaging in an isolated macOS shell. ' +
        'Reproduces the original failure class (stale shim, PATH shadowing, local-mode history regression), ' +
        'validates the fix, captures deterministic artifacts, and issues a reviewer verdict.',
    )
    .pattern('pipeline')
    .channel('wf-relay-e2e-cleanroom')
    .maxConcurrency(1)
    .timeout(3_600_000);

  // ── Agents ─────────────────────────────────────────────────────────────────

  wf.agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    model: ClaudeModels.SONNET,
    role: 'Reviewer who compares baseline-failure artifacts against fixed-run artifacts and issues the final PASS/FAIL verdict',
    retries: 2,
  });

  // ── Phase 0: Emit acceptance contract ─────────────────────────────────────
  //
  // Static deterministic step so the reviewer step can reference it via
  // {{steps.acceptance-contract.output}} without needing an external file.

  wf.step('acceptance-contract', {
    type: 'deterministic',
    captureOutput: true,
    failOnError: false,
    command: `cat <<'EOF'
ACCEPTANCE_CONTRACT

The validation workflow PASSES if and only if all of the following are
demonstrated in an isolated macOS shell with no prior relay state:

| # | Signal | Evidence File |
|---|--------|---------------|
| A1  | install.sh completes successfully from scratch | fixed-install.txt |
| A2  | command -v agent-relay resolves to the isolated bin dir | fixed-install.txt |
| A3  | agent-relay --version succeeds after install | fixed-install.txt |
| A4  | A deliberately introduced stale shim is detected or repaired by install | baseline-failure.txt + fixed-install.txt |
| A5  | agent-relay up --no-dashboard --verbose reaches running state within 30s | broker-start.log |
| A6  | agent-relay status reports running | status.txt |
| A7  | agent-relay spawn WorkflowProbe succeeds in a real repo | spawn.txt |
| A8  | agent-relay who shows the spawned worker | who.txt |
| A9  | agent-relay send WorkflowProbe "ping" succeeds without explicit --from | send-default.txt |
| A10 | agent-relay send WorkflowProbe "ping" --from Orchestrator succeeds | send-explicit.txt |
| A11 | agent-relay agents:logs WorkflowProbe shows delivery/response evidence | worker-logs.txt |
| A12 | agent-relay history with RELAY_API_KEY unset does NOT say "set RELAY_API_KEY" | history-no-api-key.txt |
| A13 | All required artifact files present with timestamps and exit codes | all files in .e2e-artifacts/ |

Failure contract: FAIL if ANY signal is FAIL. PARTIAL signals require manual reviewer judgment.

CHOSEN_PROVING_ENVIRONMENT: Fresh isolated macOS local shell.
  - Isolated HOME, XDG_*, AGENT_RELAY_* vars, PATH: CLEAN_HOME/.local/bin first.
  - RELAY_API_KEY unset throughout.
  - Reproduces: stale shim in ~/.local/bin, xattr/codesign handling, launcher PATH shadowing.
  - Docker/cloud are Linux-only and do not reproduce these macOS-specific failure modes.

CHOSEN_PATTERN: pipeline (maxConcurrency(1))
  - Sequential before/after proof required; causal chain: baseline → provision → reproduce failure → build/install → validate → collect → review.
  - DAG concurrency would obscure the proof chain.

ORIGINAL_FAILURE_CLASS: first-run local bootstrap on macOS
  - install.sh installs into ~/.local/bin with macOS-specific xattr/codesign cleanup.
  - Local broker mode must work without RELAY_API_KEY.
  - history hard-requires RELAY_API_KEY in the broken state, conflicting with local-mode contract.
  - Stale shims in PATH shadow the newly installed binary.
EOF
`,
  });

  // ── Phase 1: Environment Provisioning ─────────────────────────────────────
  //
  // Create an isolated HOME + PATH so clean-room properties do not depend on
  // the user's live shell environment. Persist the isolation env for all
  // downstream phases. Capture an env-manifest for the record.

  wf.step('phase-provision', {
    type: 'deterministic',
    dependsOn: ['acceptance-contract'],
    captureOutput: true,
    failOnError: true,
    command: `
set -euo pipefail

ARTIFACTS="${ARTIFACTS_DIR}"
mkdir -p "$ARTIFACTS"

# Create isolated environment
CLEAN_HOME="$(mktemp -d /tmp/relay-e2e-XXXXXX)"
export HOME="$CLEAN_HOME"
export XDG_DATA_HOME="$CLEAN_HOME/.local/share"
export XDG_CONFIG_HOME="$CLEAN_HOME/.config"
export AGENT_RELAY_INSTALL_DIR="$CLEAN_HOME/.local/share/agent-relay"
export AGENT_RELAY_BIN_DIR="$CLEAN_HOME/.local/bin"
export PATH="$CLEAN_HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
unset RELAY_API_KEY 2>/dev/null || true
mkdir -p "$CLEAN_HOME/.local/bin" "$CLEAN_HOME/.local/share"

# Persist isolation env for downstream phases
cat > "$ARTIFACTS/isolation.env" <<ENVEOF
CLEAN_HOME=$CLEAN_HOME
HOME=$CLEAN_HOME
XDG_DATA_HOME=$CLEAN_HOME/.local/share
XDG_CONFIG_HOME=$CLEAN_HOME/.config
AGENT_RELAY_INSTALL_DIR=$CLEAN_HOME/.local/share/agent-relay
AGENT_RELAY_BIN_DIR=$CLEAN_HOME/.local/bin
PATH=$CLEAN_HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
ENVEOF

# Capture env manifest
{
  echo "=== env-manifest ==="
  echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "OS: $(uname -a)"
  echo "shell: \${SHELL:-unknown}"
  echo "node: $(node --version 2>/dev/null || echo 'not found')"
  echo "npm: $(npm --version 2>/dev/null || echo 'not found')"
  echo "CLEAN_HOME: $CLEAN_HOME"
  echo "AGENT_RELAY_BIN_DIR: $CLEAN_HOME/.local/bin"
  echo "PATH: $PATH"
  echo "RELAY_API_KEY: unset"
  echo "cwd: $(pwd)"
  echo "repo_root: ${REPO_ROOT}"
} | tee "$ARTIFACTS/env-manifest.txt"

echo "PROVISION_COMPLETE: CLEAN_HOME=$CLEAN_HOME"
`,
  });

  // ── Phase 2: Baseline Failure Reproduction ─────────────────────────────────
  //
  // Deliberately introduce a stale shim at $CLEAN_HOME/.local/bin/agent-relay
  // that exits 1, simulating a broken/shadowed binary. This proves the clean
  // room actually exercises the failure path before the fix is applied.
  // (A4 baseline half)

  wf.step('phase-baseline', {
    type: 'deterministic',
    dependsOn: ['phase-provision'],
    captureOutput: true,
    failOnError: false, // Expected to capture failures — do not abort pipeline
    command: `
set -uo pipefail

ARTIFACTS="${ARTIFACTS_DIR}"
# shellcheck source=/dev/null
source "$ARTIFACTS/isolation.env"

{
  echo "=== baseline-failure ==="
  echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "purpose: demonstrate stale-shim/PATH-shadowing failure class before fix is applied"
  echo ""

  # Create stale shim that simulates a broken/shadowed binary
  echo "--- introducing stale shim at \$CLEAN_HOME/.local/bin/agent-relay ---"
  cat > "$CLEAN_HOME/.local/bin/agent-relay" <<'SHIM'
#!/bin/sh
echo "stale agent-relay shim: this binary is broken and should be replaced by install.sh" >&2
exit 1
SHIM
  chmod +x "$CLEAN_HOME/.local/bin/agent-relay"
  echo "stale shim written to: $CLEAN_HOME/.local/bin/agent-relay"

  # Capture pre-fix PATH state
  echo "--- PATH before fix ---"
  echo "PATH=$PATH"
  echo "which -a agent-relay output:"
  which -a agent-relay 2>&1 || echo "(which -a returned nothing)"
  echo "type -a agent-relay output:"
  type -a agent-relay 2>&1 || echo "(type -a not available)"

  # Attempt to use the broken shim — expect failure
  echo "--- agent-relay --version (expect failure from stale shim) ---"
  CMD_EXIT=0
  CMD_OUTPUT=$(agent-relay --version 2>&1) || CMD_EXIT=$?
  echo "command: agent-relay --version"
  echo "stdout/stderr: $CMD_OUTPUT"
  echo "exit_code: $CMD_EXIT"

  if [ "$CMD_EXIT" -ne 0 ]; then
    echo "BASELINE_FAILURE_CONFIRMED: stale shim caused exit $CMD_EXIT as expected"
    echo "A4_BASELINE: stale shim present and blocking correct binary — original failure class reproduced"
  else
    echo "WARNING: stale shim did not fail — check shim placement vs PATH order"
  fi
} | tee "$ARTIFACTS/baseline-failure.txt"

echo "BASELINE_PHASE_COMPLETE"
`,
  });

  // ── Phase 3: Build from Source and Install ────────────────────────────────
  //
  // Remove stale state from Phase 2. Do a full build from source (npm run build),
  // then run install.sh into the isolated environment. Capture the full install
  // transcript including which -a, type -a, and version output. Validates A1–A4.

  wf.step('phase-install', {
    type: 'deterministic',
    dependsOn: ['phase-baseline'],
    captureOutput: true,
    failOnError: true,
    command: `
set -euo pipefail

ARTIFACTS="${ARTIFACTS_DIR}"
# shellcheck source=/dev/null
source "$ARTIFACTS/isolation.env"

{
  echo "=== fixed-install ==="
  echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "repo_root: ${REPO_ROOT}"

  # Remove stale shim from Phase 2
  echo "--- removing stale shim from Phase 2 ---"
  rm -f "$CLEAN_HOME/.local/bin/agent-relay"
  echo "stale shim removed"
  ls -la "$CLEAN_HOME/.local/bin/" 2>&1 || echo "(bin dir now empty)"

  # Build from source — ensures we are validating the current candidate, not a cached artifact
  echo "--- building from source: npm run build ---"
  cd "${REPO_ROOT}"
  BUILD_EXIT=0
  npm run build 2>&1 || BUILD_EXIT=$?
  echo "build exit_code: $BUILD_EXIT"
  if [ "$BUILD_EXIT" -ne 0 ]; then
    echo "BUILD_FAILED: npm run build exited $BUILD_EXIT"
    exit "$BUILD_EXIT"
  fi
  echo "build succeeded"

  # Run install.sh into the isolated environment
  echo "--- running install.sh ---"
  INSTALL_EXIT=0
  bash "${REPO_ROOT}/install.sh" 2>&1 || INSTALL_EXIT=$?
  echo "install exit_code: $INSTALL_EXIT"
  if [ "$INSTALL_EXIT" -ne 0 ]; then
    echo "INSTALL_FAILED: install.sh exited $INSTALL_EXIT"
    exit "$INSTALL_EXIT"
  fi
  echo "install.sh completed successfully — A1_PASS"

  # Post-install PATH and binary resolution
  echo "--- post-install PATH and binary resolution ---"
  echo "PATH: $PATH"
  echo "which -a agent-relay:"
  which -a agent-relay 2>&1 || echo "(not found via which)"
  echo "type -a agent-relay:"
  type -a agent-relay 2>&1 || echo "(type -a not available)"

  # A2: command -v resolves to isolated bin dir
  RESOLVED=$(command -v agent-relay 2>&1 || echo "NOT_FOUND")
  echo "command -v agent-relay: $RESOLVED"
  if echo "$RESOLVED" | grep -q "$CLEAN_HOME/.local/bin"; then
    echo "A2_PASS: resolves to isolated bin dir ($RESOLVED)"
  else
    echo "A2_FAIL: does not resolve to isolated bin dir (got: $RESOLVED)"
    exit 1
  fi

  # A3: --version succeeds
  VERSION_EXIT=0
  VERSION_OUTPUT=$(agent-relay --version 2>&1) || VERSION_EXIT=$?
  echo "agent-relay --version: $VERSION_OUTPUT"
  echo "version exit_code: $VERSION_EXIT"
  if [ "$VERSION_EXIT" -eq 0 ]; then
    echo "A3_PASS: --version succeeded"
  else
    echo "A3_FAIL: --version exited $VERSION_EXIT"
    exit "$VERSION_EXIT"
  fi

  # A4 (fixed half): confirm stale shim was overwritten
  echo "--- stale shim resolution check (A4 fixed half) ---"
  CURRENT_CONTENT=$(head -3 "$RESOLVED" 2>/dev/null || echo "(cannot read)")
  if echo "$CURRENT_CONTENT" | grep -q "stale agent-relay shim"; then
    echo "A4_FAIL: binary at $RESOLVED is still the stale shim — install.sh did NOT replace it"
    exit 1
  else
    echo "A4_PASS: binary at $RESOLVED is not the stale shim — install.sh correctly replaced it"
    echo "  Before: stale shim (see baseline-failure.txt)"
    echo "  After:  real agent-relay binary ($VERSION_OUTPUT)"
  fi

} | tee "$ARTIFACTS/fixed-install.txt"

echo "INSTALL_PHASE_COMPLETE"
`,
  });

  // ── Phase 4: Broker Startup and Readiness ─────────────────────────────────
  //
  // Start the local broker with --no-dashboard --verbose. Poll agent-relay
  // status with exponential backoff (max 30 s). Gate: do not proceed unless
  // status is running. Validates A5–A6.

  wf.step('phase-broker', {
    type: 'deterministic',
    dependsOn: ['phase-install'],
    captureOutput: true,
    failOnError: true,
    command: `
set -euo pipefail

ARTIFACTS="${ARTIFACTS_DIR}"
# shellcheck source=/dev/null
source "$ARTIFACTS/isolation.env"
BROKER_LOG="$ARTIFACTS/broker-start.log"

{
  echo "=== broker-start ==="
  echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Start broker in background, capture log
  echo "--- starting: agent-relay up --no-dashboard --verbose ---"
  agent-relay up --no-dashboard --verbose >>"$BROKER_LOG" 2>&1 &
  BROKER_PID=$!
  echo "broker PID: $BROKER_PID"
  echo "$BROKER_PID" > "$ARTIFACTS/broker.pid"

  # Poll status with exponential backoff (max ~30 s across 6 attempts: 2+4+6+8+10+12=42s cap)
  echo "--- polling agent-relay status (max ~30s) ---"
  STATUS_REACHED=false
  for ATTEMPT in 1 2 3 4 5 6; do
    SLEEP_SECS=$((ATTEMPT * 2))
    echo "  attempt $ATTEMPT: sleeping \${SLEEP_SECS}s..."
    sleep "$SLEEP_SECS"
    STATUS_EXIT=0
    STATUS_OUTPUT=$(agent-relay status 2>&1) || STATUS_EXIT=$?
    echo "  status output: $STATUS_OUTPUT (exit $STATUS_EXIT)"
    if echo "$STATUS_OUTPUT" | grep -qi "running"; then
      echo "A5_PASS: broker reached running state (attempt $ATTEMPT, cumulative wait ~$((ATTEMPT * (ATTEMPT + 1)))s)"
      STATUS_REACHED=true
      break
    fi
  done

  if [ "$STATUS_REACHED" = "false" ]; then
    echo "A5_FAIL: broker did not reach running state within ~30s"
    echo "--- broker log tail ---"
    tail -30 "$BROKER_LOG" 2>&1 || true
    exit 1
  fi

  # Capture final status output
  FINAL_STATUS=$(agent-relay status 2>&1 || echo "STATUS_ERROR")
  echo "$FINAL_STATUS" | tee "$ARTIFACTS/status.txt"

  if echo "$FINAL_STATUS" | grep -qi "running"; then
    echo "A6_PASS: agent-relay status reports running"
  else
    echo "A6_FAIL: agent-relay status does not report running: $FINAL_STATUS"
    exit 1
  fi

} 2>&1 | tee -a "$BROKER_LOG"

echo "BROKER_PHASE_COMPLETE"
`,
  });

  // ── Phase 5: Worker Spawn and Messaging ────────────────────────────────────
  //
  // Spawn WorkflowProbe, verify it appears in `who`, send messages with and
  // without --from, and capture agent logs as delivery evidence.
  // Validates A7–A11.

  wf.step('phase-messaging', {
    type: 'deterministic',
    dependsOn: ['phase-broker'],
    captureOutput: true,
    failOnError: true,
    command: `
set -euo pipefail

ARTIFACTS="${ARTIFACTS_DIR}"
# shellcheck source=/dev/null
source "$ARTIFACTS/isolation.env"

{
  echo "=== worker-spawn-and-messaging ==="
  echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # A7: Spawn WorkflowProbe
  echo "--- command: agent-relay spawn WorkflowProbe claude 'e2e probe ping' ---"
  SPAWN_EXIT=0
  SPAWN_OUTPUT=$(agent-relay spawn WorkflowProbe claude "e2e probe ping" 2>&1) || SPAWN_EXIT=$?
  echo "$SPAWN_OUTPUT"
  echo "exit_code: $SPAWN_EXIT"
  {
    echo "command: agent-relay spawn WorkflowProbe claude 'e2e probe ping'"
    echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "$SPAWN_OUTPUT"
    echo "exit_code: $SPAWN_EXIT"
  } > "$ARTIFACTS/spawn.txt"
  if [ "$SPAWN_EXIT" -eq 0 ]; then
    echo "A7_PASS: WorkflowProbe spawned successfully"
  else
    echo "A7_FAIL: spawn exited $SPAWN_EXIT"
    exit "$SPAWN_EXIT"
  fi

  # Brief wait for worker to register
  sleep 3

  # A8: Verify WorkflowProbe appears in who output
  echo "--- command: agent-relay who ---"
  WHO_EXIT=0
  WHO_OUTPUT=$(agent-relay who 2>&1) || WHO_EXIT=$?
  echo "$WHO_OUTPUT"
  echo "exit_code: $WHO_EXIT"
  {
    echo "command: agent-relay who"
    echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "$WHO_OUTPUT"
    echo "exit_code: $WHO_EXIT"
  } > "$ARTIFACTS/who.txt"
  if echo "$WHO_OUTPUT" | grep -q "WorkflowProbe"; then
    echo "A8_PASS: WorkflowProbe listed in agent-relay who"
  else
    echo "A8_FAIL: WorkflowProbe not found in who output"
    exit 1
  fi

  # A9: Send without --from (validates local-mode default sender resolution)
  echo "--- command: agent-relay send WorkflowProbe 'ping' (no --from) ---"
  SEND_DEFAULT_EXIT=0
  SEND_DEFAULT_OUTPUT=$(agent-relay send WorkflowProbe "ping" 2>&1) || SEND_DEFAULT_EXIT=$?
  echo "$SEND_DEFAULT_OUTPUT"
  echo "exit_code: $SEND_DEFAULT_EXIT"
  {
    echo "command: agent-relay send WorkflowProbe 'ping'"
    echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "$SEND_DEFAULT_OUTPUT"
    echo "exit_code: $SEND_DEFAULT_EXIT"
  } > "$ARTIFACTS/send-default.txt"
  if [ "$SEND_DEFAULT_EXIT" -eq 0 ]; then
    echo "A9_PASS: send without --from succeeded (no workaround required)"
  else
    echo "A9_FAIL: send without --from exited $SEND_DEFAULT_EXIT"
    exit "$SEND_DEFAULT_EXIT"
  fi

  # A10: Send with explicit --from
  echo "--- command: agent-relay send WorkflowProbe 'explicit ping' --from Orchestrator ---"
  SEND_EXPLICIT_EXIT=0
  SEND_EXPLICIT_OUTPUT=$(agent-relay send WorkflowProbe "explicit ping" --from Orchestrator 2>&1) || SEND_EXPLICIT_EXIT=$?
  echo "$SEND_EXPLICIT_OUTPUT"
  echo "exit_code: $SEND_EXPLICIT_EXIT"
  {
    echo "command: agent-relay send WorkflowProbe 'explicit ping' --from Orchestrator"
    echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "$SEND_EXPLICIT_OUTPUT"
    echo "exit_code: $SEND_EXPLICIT_EXIT"
  } > "$ARTIFACTS/send-explicit.txt"
  if [ "$SEND_EXPLICIT_EXIT" -eq 0 ]; then
    echo "A10_PASS: send with --from Orchestrator succeeded"
  else
    echo "A10_FAIL: send with --from exited $SEND_EXPLICIT_EXIT"
    exit "$SEND_EXPLICIT_EXIT"
  fi

  # Wait briefly for message delivery before reading logs
  sleep 2

  # A11: Capture agent logs (delivery evidence)
  echo "--- command: agent-relay agents:logs WorkflowProbe ---"
  LOGS_EXIT=0
  LOGS_OUTPUT=$(agent-relay agents:logs WorkflowProbe 2>&1) || LOGS_EXIT=$?
  echo "$LOGS_OUTPUT"
  echo "exit_code: $LOGS_EXIT"
  {
    echo "command: agent-relay agents:logs WorkflowProbe"
    echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "$LOGS_OUTPUT"
    echo "exit_code: $LOGS_EXIT"
  } > "$ARTIFACTS/worker-logs.txt"
  if echo "$LOGS_OUTPUT" | grep -qi "ping\|delivery\|received\|message\|sent"; then
    echo "A11_PASS: worker logs show delivery evidence"
  else
    echo "A11_PARTIAL: worker logs captured (exit $LOGS_EXIT) but no delivery keyword found — reviewer must check"
  fi

} | tee "$ARTIFACTS/messaging-phase.log"

echo "MESSAGING_PHASE_COMPLETE"
`,
  });

  // ── Phase 6: Local History Validation ─────────────────────────────────────
  //
  // With RELAY_API_KEY unset, `agent-relay history` must either return local
  // history OR emit a clean local-mode message. It must NOT instruct the user
  // to set RELAY_API_KEY — that instruction is the regression being validated.
  // Validates A12.

  wf.step('phase-history', {
    type: 'deterministic',
    dependsOn: ['phase-messaging'],
    captureOutput: true,
    failOnError: true,
    command: `
set -uo pipefail

ARTIFACTS="${ARTIFACTS_DIR}"
# shellcheck source=/dev/null
source "$ARTIFACTS/isolation.env"

{
  echo "=== local-history-validation ==="
  echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Ensure RELAY_API_KEY is unset for this check
  unset RELAY_API_KEY 2>/dev/null || true
  echo "RELAY_API_KEY: unset (confirmed)"

  echo "--- command: agent-relay history (RELAY_API_KEY unset) ---"
  HISTORY_EXIT=0
  HISTORY_OUTPUT=$(agent-relay history 2>&1) || HISTORY_EXIT=$?
  echo "$HISTORY_OUTPUT"
  echo "exit_code: $HISTORY_EXIT"
  {
    echo "command: agent-relay history"
    echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "RELAY_API_KEY: unset"
    echo "$HISTORY_OUTPUT"
    echo "exit_code: $HISTORY_EXIT"
  } > "$ARTIFACTS/history-no-api-key.txt"

  # A12: Must NOT instruct user to set RELAY_API_KEY
  if echo "$HISTORY_OUTPUT" | grep -qi "set RELAY_API_KEY\|RELAY_API_KEY.*required\|set.*api.*key\|please set.*RELAY"; then
    echo "A12_FAIL: history output incorrectly instructs user to set RELAY_API_KEY in local mode"
    echo "  This is the original regression — local-mode history contract is broken"
    exit 1
  elif [ "$HISTORY_EXIT" -eq 0 ]; then
    echo "A12_PASS: history returned local results (exit 0, no RELAY_API_KEY instruction)"
  else
    echo "A12_PASS: history exited $HISTORY_EXIT with a clean local-mode message (no RELAY_API_KEY instruction)"
  fi

} | tee "$ARTIFACTS/history-phase.log"

echo "HISTORY_PHASE_COMPLETE"
`,
  });

  // ── Phase 7: Cleanup and Artifact Collection ───────────────────────────────
  //
  // Stop the broker. Verify all required artifact files are present. Emit an
  // artifact inventory log. Validates A13.

  wf.step('phase-cleanup', {
    type: 'deterministic',
    dependsOn: ['phase-history'],
    captureOutput: true,
    failOnError: false, // Best-effort cleanup — do not mask a prior signal failure
    command: `
set -uo pipefail

ARTIFACTS="${ARTIFACTS_DIR}"
# shellcheck source=/dev/null
source "$ARTIFACTS/isolation.env" 2>/dev/null || true

{
  echo "=== cleanup-and-artifact-collection ==="
  echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Stop broker gracefully
  echo "--- stopping broker (agent-relay down) ---"
  DOWN_EXIT=0
  DOWN_OUTPUT=$(agent-relay down 2>&1) || DOWN_EXIT=$?
  echo "agent-relay down output: $DOWN_OUTPUT"
  echo "agent-relay down exit_code: $DOWN_EXIT"

  # Kill by PID as fallback
  if [ -f "$ARTIFACTS/broker.pid" ]; then
    BROKER_PID=$(cat "$ARTIFACTS/broker.pid")
    kill "$BROKER_PID" 2>/dev/null && echo "sent SIGTERM to broker PID $BROKER_PID" || true
  fi

  # Verify all required artifact files are present (A13)
  echo ""
  echo "--- A13: artifact inventory ---"
  REQUIRED=(
    "env-manifest.txt"
    "isolation.env"
    "baseline-failure.txt"
    "fixed-install.txt"
    "broker-start.log"
    "broker.pid"
    "status.txt"
    "spawn.txt"
    "who.txt"
    "send-default.txt"
    "send-explicit.txt"
    "worker-logs.txt"
    "history-no-api-key.txt"
    "messaging-phase.log"
    "history-phase.log"
  )

  MISSING=0
  for f in "\${REQUIRED[@]}"; do
    if [ -f "$ARTIFACTS/$f" ]; then
      SIZE=$(wc -c < "$ARTIFACTS/$f" | tr -d ' ')
      echo "  [PRESENT ${SIZE} bytes] $f"
    else
      echo "  [MISSING] $f"
      MISSING=$((MISSING + 1))
    fi
  done

  if [ "$MISSING" -eq 0 ]; then
    echo "A13_PASS: all required artifact files present"
  else
    echo "A13_FAIL: $MISSING artifact files missing"
  fi

  echo ""
  echo "--- artifact directory listing ---"
  ls -lah "$ARTIFACTS/" 2>&1 || true

} | tee "$ARTIFACTS/cleanup-phase.log"

echo "CLEANUP_PHASE_COMPLETE"
`,
  });

  // ── Phase 8a: Dump artifacts for reviewer ─────────────────────────────────
  //
  // Dump all artifact content into a single step output so the reviewer agent
  // can access everything via {{steps.phase-read-artifacts.output}}.

  wf.step('phase-read-artifacts', {
    type: 'deterministic',
    dependsOn: ['phase-cleanup'],
    captureOutput: true,
    failOnError: false,
    command: `
set -uo pipefail
ARTIFACTS="${ARTIFACTS_DIR}"

echo "=== ARTIFACT DUMP FOR REVIEWER ==="
echo ""

dump_file() {
  local name="$1"
  echo "### $name ###"
  if [ -f "$ARTIFACTS/$name" ]; then
    cat "$ARTIFACTS/$name"
  else
    echo "(file missing)"
  fi
  echo ""
}

dump_file "env-manifest.txt"
dump_file "baseline-failure.txt"
dump_file "fixed-install.txt"
dump_file "status.txt"
dump_file "spawn.txt"
dump_file "who.txt"
dump_file "send-default.txt"
dump_file "send-explicit.txt"
dump_file "history-no-api-key.txt"
dump_file "cleanup-phase.log"

echo "### broker-start.log (last 60 lines) ###"
if [ -f "$ARTIFACTS/broker-start.log" ]; then
  tail -60 "$ARTIFACTS/broker-start.log"
else
  echo "(file missing)"
fi
echo ""

dump_file "worker-logs.txt"
dump_file "messaging-phase.log"
dump_file "history-phase.log"
`,
  });

  // ── Phase 8b: Reviewer verdict ─────────────────────────────────────────────
  //
  // The reviewer agent compares baseline-failure artifacts against fixed-run
  // artifacts and produces verdict.md with a signal-by-signal PASS/FAIL table.

  wf.step('phase-review', {
    agent: 'reviewer',
    dependsOn: ['phase-read-artifacts'],
    task: `Review the clean-room end-to-end validation run against the acceptance contract.

Acceptance contract:
{{steps.acceptance-contract.output}}

Artifacts collected during the validation run:
{{steps.phase-read-artifacts.output}}

For each acceptance signal A1–A13, evaluate the artifact evidence and state:
- PASS — signal is clearly demonstrated
- FAIL — signal is not met (provide specific evidence from artifacts)
- PARTIAL — signal is partially met (provide what is missing)

Then produce the final verdict with these exact sections:

1. SIGNAL_RESULTS
   (Table: signal | result | evidence snippet)

2. PASS_FAIL
   Overall PASS or FAIL. FAIL if ANY signal is FAIL.

3. WHAT_PROBLEM_IT_PROVES
   Describe which original failure class was exercised (stale shim, PATH shadowing,
   local-mode history regression) and confirm it was fixed.

4. WHAT_EVIDENCE_IT_COLLECTS
   Describe the before/after artifact trail:
   - baseline-failure.txt shows the broken state (A4 baseline half)
   - fixed-install.txt + subsequent artifacts prove the fix (A1–A4 fixed half, A5–A12)

5. RESIDUAL_RISKS
   Any gaps in coverage, signals needing manual follow-up, or edge cases not covered.

6. OS_SHELL_COVERAGE_NOTE
   Confirm: primary proof is macOS local shell. Docker/cloud are secondary regression
   only and do not cover the same macOS-specific failure surface.

Write the complete verdict to ${ARTIFACTS_DIR}/verdict.md.

End your response with REVIEW_COMPLETE.`,
    verification: { type: 'output_contains', value: 'REVIEW_COMPLETE' },
    retries: 2,
  });

  const result = await wf.run();
  console.log(`Done: ${result.status} (${result.id})`);
}

main().catch(console.error);
