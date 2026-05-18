#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <description> <command...>" >&2
  exit 2
fi

DESCRIPTION="$1"
shift

ATTEMPTS="${RETRY_ATTEMPTS:-8}"
BASE_DELAY="${RETRY_BASE_DELAY_SECONDS:-10}"
MAX_DELAY="${RETRY_MAX_DELAY_SECONDS:-60}"

for attempt in $(seq 1 "$ATTEMPTS"); do
  echo "[$attempt/$ATTEMPTS] ${DESCRIPTION}"
  if "$@"; then
    echo "Success: ${DESCRIPTION}"
    exit 0
  fi

  if [ "$attempt" -eq "$ATTEMPTS" ]; then
    break
  fi

  delay=$(( BASE_DELAY * attempt ))
  if [ "$delay" -gt "$MAX_DELAY" ]; then
    delay="$MAX_DELAY"
  fi

  echo "Retrying in ${delay}s..."
  sleep "$delay"
done

echo "ERROR: ${DESCRIPTION} failed after ${ATTEMPTS} attempts" >&2
exit 1
