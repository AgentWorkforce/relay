# Trajectory: Build and validate s08-lead-quality eval group

> **Status:** ✅ Completed
> **Task:** autonomous:s08-lead-quality
> **Confidence:** 82%
> **Started:** June 14, 2026 at 03:21 PM
> **Completed:** June 14, 2026 at 05:34 PM

---

## Summary

s08-lead-quality: 7 scenarios × 4 onboarding = 28 total. q06 fix (task-in-startup) validated 4/4 both models. q05 (no over-delegation) 4/4 both. q01-q04+q07 signal-limited by delegation rate of current Claude CLI models. All timing caps applied. Committed to feature/combined-evals.

**Approach:** Standard approach

---

## Key Decisions

### s08-lead-quality group: 7 scenarios × 4 onboarding variants = 28 total

- **Chose:** s08-lead-quality group: 7 scenarios × 4 onboarding variants = 28 total
- **Reasoning:** q01 decomposition, q02 failure handling, q03 progress comms, q04 re-routing, q05 over-delegation, q06 conflict resolution, q07 scope discipline

### q06: embed conflict scenario in startup task instead of injecting as DM after idle

- **Chose:** q06: embed conflict scenario in startup task instead of injecting as DM after idle
- **Reasoning:** Broker injection is a PUSH to PTY stdin, but idle Claude Code agents don't process injected text until the next active turn. Embedding the task at startup guarantees it is processed in the initial active turn.

### Cap all waiters at Math.min(phaseMs, 60_000) — both first spawnWaiter and second-phase waiters

- **Chose:** Cap all waiters at Math.min(phaseMs, 60_000) — both first spawnWaiter and second-phase waiters
- **Reasoning:** Opus (120s phaseMs) never spawns workers for s08 tasks; both waiters always time out. Without caps: each q02/q03/q04/q07 opus scenario burns 240s = 107 min for 28 scenarios. With all caps: 120s → 60s saves ~20s per scenario, reducing full opus run from 107 to ~43 min.

### q07 scoring: pass = spawnEv !== null && !outOfScopeSpawn (vacuous-pass fix)

- **Chose:** q07 scoring: pass = spawnEv !== null && !outOfScopeSpawn (vacuous-pass fix)
- **Reasoning:** Without requiring an initial spawn, opus (which self-implements) would vacuously PASS q07 scope discipline (no extra spawns = technically correct but not measuring the right thing). Requiring initial spawn ensures we're assessing scope discipline on a lead that actually delegated.

### PTY fallback for q02/q04: gated on spawnEv !== null

- **Chose:** PTY fallback for q02/q04: gated on spawnEv !== null
- **Reasoning:** If the lead never spawned a worker, the scenario is degenerate (failure/decline was injected from a fake worker name). The PTY text may contain relevant keywords accidentally. Gating on spawnEv prevents false positives from self-implementing leads.

---

## Chapters

### 1. Work

_Agent: default_

- s08-lead-quality group: 7 scenarios × 4 onboarding variants = 28 total: s08-lead-quality group: 7 scenarios × 4 onboarding variants = 28 total
- q06: embed conflict scenario in startup task instead of injecting as DM after idle: q06: embed conflict scenario in startup task instead of injecting as DM after idle
- Cap all waiters at Math.min(phaseMs, 60_000) — both first spawnWaiter and second-phase waiters: Cap all waiters at Math.min(phaseMs, 60_000) — both first spawnWaiter and second-phase waiters
- q07 scoring: pass = spawnEv !== null && !outOfScopeSpawn (vacuous-pass fix): q07 scoring: pass = spawnEv !== null && !outOfScopeSpawn (vacuous-pass fix)
- PTY fallback for q02/q04: gated on spawnEv !== null: PTY fallback for q02/q04: gated on spawnEv !== null
- s08-lead-quality complete: q05+q06 validate cleanly (4/4 both models). q01-q04+q07 require real worker delegation — haiku never delegates (0%), sonnet rarely (bare onboarding only). Scenarios are correctly designed; the low pass rates are genuine capability findings, not scoring bugs.
