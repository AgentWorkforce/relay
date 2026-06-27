#!/usr/bin/env bash
# run-opencode-models.sh — batch eval runner for opencode model tiers
#
# Two-phase strategy:
#   Phase 1 (screen): s03 one-liner only, repeat=3 — fast directional signal.
#                     Models that score 2/3+ pass (≥67%) advance to Phase 2.
#   Phase 2 (full):   s01–s04 lifecycle, repeat=5 — authoritative per-run rates.
#
# Usage:
#   cd tests/integration/broker && ./evals/run-opencode-models.sh
#   ./evals/run-opencode-models.sh --phase1-only     # just screen all models
#   ./evals/run-opencode-models.sh --full-only MODEL  # skip screen, full run one model
#
# Runs batches of BATCH_SIZE processes in parallel. All logs go to /tmp/eval-opencode-*.
# Reports land in evals-reports/ alongside other eval output.
#
# No LLM coordinator needed — this is a plain shell loop.
set -euo pipefail

RUNNER="node --experimental-vm-modules dist/evals/runner.js"
LOG_DIR="/tmp/eval-opencode"
BATCH_SIZE=3
SCREEN_REPEAT=3
FULL_REPEAT=5

mkdir -p "$LOG_DIR"

# ── Model list ────────────────────────────────────────────────────────────────
# Curated from `opencode models` output. Grouped by family for readability.
# Already tested: mimo-v2.5-free (100% s03 bare — relay-native, best bare result).

PHASE1_MODELS=(
  # DeepSeek (Chinese — strong coding models)
  "deepseek-v4-flash"
  "deepseek-v4-flash-free"
  "deepseek-v4-pro"

  # Kimi (Moonshot AI, Chinese)
  "kimi-k2.5"
  "kimi-k2.6"

  # Qwen (Alibaba, Chinese)
  "qwen3.6-plus"
  "qwen3.5-plus"

  # Minimax (Chinese)
  "minimax-m2.5"
  "minimax-m2.7"

  # GLM (Zhipu AI, Chinese)
  "glm-5"
  "glm-5.1"

  # MiMo (Xiaomi, Chinese — already tested bare; re-test one-liner for completeness)
  "mimo-v2.5-free"

  # Grok via opencode (different path than direct grok CLI)
  "grok-build-0.1"

  # Gemini via opencode (different routing than direct gemini CLI)
  "gemini-3.5-flash"
  "gemini-3.1-pro"
  "gemini-3-flash"

  # Specialty / unknown
  "nemotron-3-ultra-free"
  "north-mini-code-free"
  "big-pickle"
)

# ── Helpers ───────────────────────────────────────────────────────────────────

run_eval() {
  local model="$1"
  local group="$2"
  local repeat="$3"
  local log="$LOG_DIR/$(echo "$model" | tr '/' '-').log"
  echo "[$(date +%H:%M:%S)] Starting opencode:$model (group=$group repeat=$repeat)"
  RELAY_INTEGRATION_REAL_CLI=1 $RUNNER \
    --harness="opencode:$model" \
    --group="$group" \
    --repeat="$repeat" \
    > "$log" 2>&1 || echo "[$(date +%H:%M:%S)] FAILED  opencode:$model (see $log)"
  echo "[$(date +%H:%M:%S)] Done     opencode:$model → $log"
}

run_batch() {
  local group="$1"
  local repeat="$2"
  shift 2
  local models=("$@")
  local pids=()

  for model in "${models[@]}"; do
    run_eval "$model" "$group" "$repeat" &
    pids+=($!)
    if (( ${#pids[@]} >= BATCH_SIZE )); then
      wait "${pids[0]}"
      pids=("${pids[@]:1}")
    fi
  done
  # Wait for remaining
  for pid in "${pids[@]}"; do wait "$pid"; done
}

# Extract scenario pass rate from a completed log: "scenarios=N/16" or "scenarios=N/4"
pass_rate() {
  local log="$LOG_DIR/$(echo "$1" | tr '/' '-').log"
  grep -oE 'scenarios=[0-9]+/[0-9]+' "$log" 2>/dev/null | tail -1 | cut -d= -f2
}

# ── Argument handling ─────────────────────────────────────────────────────────
PHASE1_ONLY=false
FULL_ONLY_MODEL=""

for arg in "$@"; do
  case "$arg" in
    --phase1-only) PHASE1_ONLY=true ;;
    --full-only=*) FULL_ONLY_MODEL="${arg#--full-only=}" ;;
  esac
done

# ── Phase 1: Screen ───────────────────────────────────────────────────────────
if [[ -z "$FULL_ONLY_MODEL" ]]; then
  echo ""
  echo "══════════════════════════════════════════════════════════"
  echo " Phase 1: Screening ${#PHASE1_MODELS[@]} models (s03 one-liner, repeat=$SCREEN_REPEAT)"
  echo "══════════════════════════════════════════════════════════"
  echo ""

  # Run in batches — uses scenario=s03-spawn-release-lifecycle + one-liner onboarding.
  # The runner's --group=lifecycle runs all 16 (4 scenarios × 4 variants). For the
  # screen we only care about s03:one-liner. Since we can't filter to one variant via
  # CLI flags, we run the full lifecycle group but with repeat=3 to keep it fast.
  # The key signal: did s03 one-liner pass 2/3 runs?
  run_batch "lifecycle" "$SCREEN_REPEAT" "${PHASE1_MODELS[@]}"

  echo ""
  echo "══════════════════════════════════════════════════════════"
  echo " Phase 1 Results"
  echo "══════════════════════════════════════════════════════════"
  printf "%-40s  %s\n" "Model" "Scenarios"
  printf "%-40s  %s\n" "─────" "─────────"

  PHASE2_MODELS=()
  for model in "${PHASE1_MODELS[@]}"; do
    rate=$(pass_rate "$model")
    if [[ -z "$rate" ]]; then
      printf "%-40s  ERROR (check %s)\n" "opencode/$model" "$LOG_DIR/$(echo "$model" | tr '/' '-').log"
      continue
    fi
    passed="${rate%/*}"
    total="${rate#*/}"
    printf "%-40s  %s\n" "opencode/$model" "$rate"
    # Advance if passed ≥ half the scenarios (screen threshold: 8/16 or 4/8 etc.)
    if (( passed * 2 >= total )); then
      PHASE2_MODELS+=("$model")
    fi
  done

  echo ""
  echo "Advancing to Phase 2: ${#PHASE2_MODELS[@]} models: ${PHASE2_MODELS[*]:-none}"
  echo ""

  if [[ "$PHASE1_ONLY" == "true" ]]; then
    echo "(--phase1-only set — stopping here)"
    exit 0
  fi
else
  # --full-only: skip Phase 1, run a single model at full depth
  PHASE2_MODELS=("$FULL_ONLY_MODEL")
  echo "Skipping Phase 1 — running full eval for: $FULL_ONLY_MODEL"
fi

# ── Phase 2: Full lifecycle ───────────────────────────────────────────────────
if [[ ${#PHASE2_MODELS[@]} -eq 0 ]]; then
  echo "No models advanced to Phase 2. Done."
  exit 0
fi

echo "══════════════════════════════════════════════════════════"
echo " Phase 2: Full lifecycle for ${#PHASE2_MODELS[@]} models (s01–s04, repeat=$FULL_REPEAT)"
echo "══════════════════════════════════════════════════════════"
echo ""

run_batch "lifecycle" "$FULL_REPEAT" "${PHASE2_MODELS[@]}"

echo ""
echo "══════════════════════════════════════════════════════════"
echo " Phase 2 Results"
echo "══════════════════════════════════════════════════════════"
printf "%-40s  %-12s  %s\n" "Model" "Scenarios" "Metrics"
printf "%-40s  %-12s  %s\n" "─────" "─────────" "───────"

for model in "${PHASE2_MODELS[@]}"; do
  log="$LOG_DIR/$(echo "$model" | tr '/' '-').log"
  rate=$(pass_rate "$model")
  metrics=$(grep -oE 'spawn=[^ ]+.*scenarios=' "$log" 2>/dev/null | tail -1 || echo "")
  printf "%-40s  %-12s  %s\n" "opencode/$model" "${rate:-ERROR}" "$metrics"
done

echo ""
echo "HTML reports: tests/integration/broker/evals-reports/report-*-opencode:*.html"
echo "Done."
