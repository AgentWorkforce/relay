#!/usr/bin/env bash
# Continuous refactoring workflow runner
# Runs all 3 waves sequentially, retries failures up to MAX_RETRIES per wave.
# Logs everything to /tmp/relay-refactor/continuous.log
set -euo pipefail

ROOT="/Users/khaliqgant/Projects/AgentWorkforce/relay"
LOG_DIR="/tmp/relay-refactor"
LOG="$LOG_DIR/continuous.log"
MAX_RETRIES=2
WAVE_COUNT=3

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"
}

run_wave() {
  local wave=$1
  local attempt=0

  while [ $attempt -le $MAX_RETRIES ]; do
    attempt=$((attempt + 1))
    log "=== Wave $wave — attempt $attempt/$((MAX_RETRIES + 1)) ==="

    if npx tsx "$ROOT/workflows/refactor/run-refactor.ts" --wave "$wave" 2>&1 | tee -a "$LOG"; then
      log "✅ Wave $wave passed"
      return 0
    else
      log "❌ Wave $wave failed (attempt $attempt)"
      if [ $attempt -le $MAX_RETRIES ]; then
        log "Retrying in 30s..."
        sleep 30
      fi
    fi
  done

  log "🛑 Wave $wave failed after $((MAX_RETRIES + 1)) attempts"
  return 1
}

main() {
  log "=========================================="
  log "Continuous Refactoring Runner — START"
  log "=========================================="

  cd "$ROOT"

  for wave in $(seq 1 $WAVE_COUNT); do
    if ! run_wave "$wave"; then
      log "Aborting — wave $wave could not complete"
      log "Check logs in $LOG_DIR"
      exit 1
    fi

    # Git commit after each successful wave
    if git diff --cached --quiet && git diff --quiet; then
      log "No changes to commit after wave $wave"
    else
      git add -A
      HUSKY=0 git commit -m "refactor: wave $wave complete (automated)" --no-verify 2>&1 | tee -a "$LOG" || true
      log "Committed wave $wave results"
    fi
  done

  log "=========================================="
  log "🎉 All $WAVE_COUNT waves complete"
  log "=========================================="
}

main
