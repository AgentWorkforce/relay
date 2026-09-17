#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <package-spec>..." >&2
  exit 2
fi

ATTEMPTS="${RETRY_ATTEMPTS:-60}"
DELAY="${RETRY_DELAY_SECONDS:-10}"

for attempt in $(seq 1 "$ATTEMPTS"); do
  missing=()
  for spec in "$@"; do
    if ! npm view "$spec" version >/dev/null 2>&1; then
      missing+=("$spec (metadata)")
      continue
    fi

    tarball_url="$(npm view "$spec" dist.tarball 2>/dev/null || true)"
    if [ -z "$tarball_url" ]; then
      missing+=("$spec (no tarball URL)")
      continue
    fi
    status="$(curl -fsSIL --connect-timeout 5 --max-time 15 -o /dev/null -w '%{http_code}' "$tarball_url" || true)"
    if [ "$status" != "200" ]; then
      missing+=("$spec (tarball HTTP ${status:-000})")
    fi
  done

  if [ "${#missing[@]}" -eq 0 ]; then
    echo "npm metadata and tarballs are available: $*"
    exit 0
  fi

  echo "[$attempt/$ATTEMPTS] waiting for npm propagation: ${missing[*]}"
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep "$DELAY"
  fi
done

echo "Timed out waiting for npm metadata/tarballs: ${missing[*]}" >&2
exit 1
