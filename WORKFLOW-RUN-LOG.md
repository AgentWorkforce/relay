# Workflow Run Log

Autonomous run started. User asleep — all decisions made independently.

## Goals

1. `relay.integration-tests.yaml` → runs to completion
2. `relay.workflow-hardening.yaml` → runs to completion

## Known fixes already applied

- `requestTimeoutMs: 60_000` in runner for spawn operations
- Spawn stagger: 2s delay × step index when wave > 3 steps
- Broker name uniqueness: `<project>-<runId[0:8]>` per run
- Preflight: ignores `.trajectories/` and `relay.integration-tests.yaml`
- Channel posts: task content stripped, only assignment notification sent

## Issues & Fixes

<!-- Appended as runs progress -->

---
