#!/usr/bin/env bash
# run-task-exit-evals.sh — task-exit eval runner across harness/model matrix
#
# Tests whether each model correctly self-releases after completing a task:
# the worker is given a task via relay message and instructed to call
# mcp__agent-relay__remove_agent with its own name once done (the s08
# scenario). PASS = task message sent AND agent_released event observed.
#
# Models under test:
#   Claude:  haiku, sonnet, opus
#   Codex:   gpt-4.5, gpt-4.1, o3, o4-mini  (verify against `codex list-models`)
#   OpenCode: default model
#
# Usage:
#   cd tests/integration/broker && ./evals/run-task-exit-evals.sh
#   ./evals/run-task-exit-evals.sh --repeat=5     # more repeats for reliability
#   ./evals/run-task-exit-evals.sh --claude-only  # skip codex / opencode
#
# Logs land in /tmp/eval-task-exit-*.log
# Reports land in evals-reports/ alongside other eval output.
set -euo pipefail

RUNNER="node --experimental-vm-modules dist/evals/runner.js"
LOG_DIR="/tmp/eval-task-exit"
BATCH_SIZE=3
REPEAT=3

# Parse optional flags
for arg in "$@"; do
  case "$arg" in
    --repeat=*) REPEAT="${arg#*=}" ;;
    --claude-only) CLAUDE_ONLY=1 ;;
  esac
done

mkdir -p "$LOG_DIR"
mkdir -p evals-reports

# ── Model matrix ──────────────────────────────────────────────────────────────

CLAUDE_MODELS=(
  "haiku"    # claude-haiku-4-5-20251001
  "sonnet"   # claude-sonnet-4-6
  "opus"     # claude-opus-4-8
)

# Raw OpenAI model names passed to the codex CLI.
# Verify available models with: codex list-models
CODEX_MODELS=(
  "gpt-4.5"
  "gpt-4.1"
  "o3"
  "o4-mini"
)

# OpenCode: bare harness uses the default OPENCODE_MODEL env var.
# Add specific model variants below if needed:
#   "opencode:deepseek-v4-flash"
OPENCODE_MODELS=(
  "opencode"
)

# ── Helpers ───────────────────────────────────────────────────────────────────

PIDS=()

flush_batch() {
  for pid in "${PIDS[@]:-}"; do
    wait "$pid" 2>/dev/null || true
  done
  PIDS=()
}

run_eval() {
  local harness="$1"
  local label
  label="$(echo "$harness" | tr ':/' '--')"
  local log="$LOG_DIR/${label}.log"
  echo "[$(date +%H:%M:%S)] Starting $harness (group=task-exit repeat=$REPEAT)"
  RELAY_INTEGRATION_REAL_CLI=1 $RUNNER \
    --harness="$harness" \
    --group=task-exit \
    --repeat="$REPEAT" \
    > "$log" 2>&1 &
  PIDS+=($!)

  if [[ ${#PIDS[@]} -ge $BATCH_SIZE ]]; then
    flush_batch
  fi
}

# ── Phase: Claude ─────────────────────────────────────────────────────────────

echo ""
echo "═══ Phase 1: Claude (haiku / sonnet / opus) ════════════════════════════"
for model in "${CLAUDE_MODELS[@]}"; do
  run_eval "claude:$model"
done
flush_batch

echo ""
echo "Results for Claude models:"
for model in "${CLAUDE_MODELS[@]}"; do
  label="claude--$model"
  log="$LOG_DIR/${label}.log"
  if [[ -f "$log" ]]; then
    echo "  claude:$model — $(grep -E 'PASS|FAIL|pass|fail|exit' "$log" | tail -5 | tr '\n' ' ')"
  fi
done

if [[ "${CLAUDE_ONLY:-0}" == "1" ]]; then
  echo ""
  echo "Skipping codex and opencode (--claude-only)."
  exit 0
fi

# ── Phase: OpenAI Codex ───────────────────────────────────────────────────────

echo ""
echo "═══ Phase 2: OpenAI Codex ══════════════════════════════════════════════"
for model in "${CODEX_MODELS[@]}"; do
  run_eval "codex:$model"
done
flush_batch

echo ""
echo "Results for Codex models:"
for model in "${CODEX_MODELS[@]}"; do
  label="codex--$model"
  log="$LOG_DIR/${label}.log"
  if [[ -f "$log" ]]; then
    echo "  codex:$model — $(grep -E 'PASS|FAIL|pass|fail|exit' "$log" | tail -5 | tr '\n' ' ')"
  fi
done

# ── Phase: OpenCode ───────────────────────────────────────────────────────────

echo ""
echo "═══ Phase 3: OpenCode ══════════════════════════════════════════════════"
for harness in "${OPENCODE_MODELS[@]}"; do
  run_eval "$harness"
done
flush_batch

echo ""
echo "Results for OpenCode:"
for harness in "${OPENCODE_MODELS[@]}"; do
  label="$(echo "$harness" | tr ':/' '--')"
  log="$LOG_DIR/${label}.log"
  if [[ -f "$log" ]]; then
    echo "  $harness — $(grep -E 'PASS|FAIL|pass|fail|exit' "$log" | tail -5 | tr '\n' ' ')"
  fi
done

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "═══ All logs in $LOG_DIR ════════════════════════════════════════════════"
echo "    Reports written to evals-reports/"
