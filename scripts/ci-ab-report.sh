#!/usr/bin/env bash
# Per-job queue and run times for CI runner A/B runs (ci-ab-runners.yml).
#   scripts/ci-ab-report.sh <run-id> [<run-id>...]
#   scripts/ci-ab-report.sh $(gh run list -w ci-ab-runners.yml -b ci-ab/graphide -L 5 --json databaseId -q '.[].databaseId')
# queue = created_at -> started_at, run = started_at -> completed_at (seconds).
set -euo pipefail
repo="${REPO:-AgentWorkforce/relay}"
[ $# -gt 0 ] || { echo "usage: $0 <run-id>..." >&2; exit 2; }

for id in "$@"; do
  gh api --paginate "repos/$repo/actions/runs/$id/jobs?per_page=100" \
    --jq '.jobs[] | select(.started_at != null and .completed_at != null) | [
      (.name | capture("^(?<job>[^ ]+).*\\((?<runner>[^)]+)\\)$")) as $n
      | $n.runner, $n.job, '"$id"', .conclusion,
      ((.started_at | fromdateiso8601) - (.created_at | fromdateiso8601)),
      ((.completed_at | fromdateiso8601) - (.started_at | fromdateiso8601))
    ] | @tsv'
done | sort | awk -F'\t' '
  BEGIN { printf "%-30s %-11s %-12s %-9s %7s %7s\n", "runner", "job", "run", "result", "queue", "run" }
  {
    printf "%-30s %-11s %-12s %-9s %6ss %6ss\n", $1, $2, $3, $4, $5, $6
    k = $1 SUBSEP $2; n[k]++; q[k] += $5; r[k] += $6
  }
  END {
    print ""
    printf "%-30s %-11s %4s %10s %10s\n", "runner", "job", "n", "avg queue", "avg run"
    for (k in n) { split(k, p, SUBSEP); printf "%-30s %-11s %4d %9.0fs %9.0fs\n", p[1], p[2], n[k], q[k]/n[k], r[k]/n[k] }
  }'
