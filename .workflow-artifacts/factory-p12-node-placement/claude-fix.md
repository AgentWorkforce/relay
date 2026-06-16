# Fix Report — factory p12 (node-targeted placement; reject-and-reconcile)

**Owner:** claude-fix (non-interactive)
**Branch:** `ricky/factory-p12-node-placement`
**Source review:** `.workflow-artifacts/factory-p12-node-placement/claude-review.md`

The review's verdict was "implementation correct and spec-aligned"; all findings
were improvements (one repo-rule miss, four test gaps, one code-smell, one nit).
Every valid finding is now fixed. No finding was skipped.

---

## Fixes applied

### F1 — [Medium] CHANGELOG `[Unreleased]` curated ✅
- **File:** `CHANGELOG.md`
- Added one impact-first bullet under `### Added`:
  `` `@agent-relay/sdk` adds `placement.spawn({ capability, node?, repo? })` — targeted/`self`/least-eligible node placement with capability+repo-key gating, bounded-TTL queueing, and reconcile events; capability mismatch throws the exported `RelayPlacementError`. ``
- Verify: `grep -n placement.spawn CHANGELOG.md` → line 19.

### F2 — [Medium] AC #4 "two nodes, no bleed" now has a dedicated test ✅
- **File:** `packages/sdk/src/messaging/placement.test.mts`
- Added test `places exactly once when two nodes are simultaneously eligible (no bleed)`:
  two live nodes both advertising `spawn:claude` and both mapping `relay`; asserts
  `invoke` is called exactly once (`toHaveBeenCalledTimes(1)`), `ack.placement.node`
  is one of the two, and the placement is `{ queued: false, attempts: 1 }`.

### F3 — [Medium] Queue-overflow and fail-fast paths fixed + tested ✅
- **Code fix** (`relaycast.ts`): the `placement_queue_full` branch now emits
  `reconcilePlacement(..., { action: 'failed', reason })` **before** throwing, so every
  non-placed outcome reaches the reconcile hook (consistent with the TTL-expired path).
- **Tests** (`placement.test.mts`):
  - `rejects with placement_queue_full and reconciles a failed event when the queue is full`:
    client built with `maxQueuedPlacements: 0`; asserts the spawn rejects with
    `code === 'placement_queue_full'`, `attempts === 1`, `invoke` never called, the
    `onReconcile` hook fires `{ action: 'failed', reason: 'no_eligible_node' }`, and the
    "placement queue full" log line is emitted.
  - `fails fast with no eligible node after a single attempt and reconciles failed`:
    `failFast: true` with no eligible node rejects with `placement_ttl_expired` after a
    single attempt and fires exactly one `onReconcile({ action: 'failed' })`.

### F4 — [Low] Misleading `reason` on targeted offline / unregistered selections fixed ✅
- **File:** `relaycast.ts`
- Chose the reviewer's "drop `reason` from non-`hardFail`" option (cleaner than widening
  the union). `PlacementSelection` is now a three-arm union: the node arm, a `hardFail: true`
  arm that carries `reason: 'capability_mismatch'` (the thrown error code), and a retryable
  arm that carries only `reconcileReason`. All non-`hardFail` returns in
  `selectPlacementNode` had their dead/misleading `reason` field removed, so no future code
  can read `decision.reason` on a queued selection and mislabel an offline target as an
  unmapped repo. Extracted a shared `PlacementReconcileReason` alias.
- Also corrected two queued-path messages from "Placement rejected" → "Placement queued"
  (the targeted-unmapped and untargeted-unmapped branches both queue, not reject).
- **Test:** `queues a targeted offline node with reason target_offline and drains once it
  is live` asserts the reconcile event is `{ action: 'queued', reason: 'target_offline' }`,
  covering the previously-uncovered offline-target branch and guarding the labeling.

### F5 — [Low] Targeted unmapped-repo branch now covered ✅
- **File:** `placement.test.mts`
- Added `queues a targeted node that does not map the repo and drains once the repo map
  updates`: targets a live, capable node whose `repo_keys` omit the requested repo; asserts
  it queues (`onReconcile` fires `reason: 'unmapped_repo'`, log contains
  `does not map repo "relay"`) and then resolves once the node's repo map is updated to
  include it — proving the **targeted** reject-and-reconcile, not just the untargeted one.

### F6 — [Nit] TTL-boundary busy-spin floored ✅
- **File:** `relaycast.ts:1190`
- Floored the queued poll delay at a small minimum:
  `delay(Math.max(5, Math.min(pollIntervalMs, ttlMs - elapsed)))`, so a near-zero remaining
  TTL can no longer produce near-zero-delay loop iterations before the next expiry check.

---

## Commands run (all clean)

```
npx vitest run --config packages/sdk/src/messaging/vitest.placement.config.mts
  → Test Files 1 passed (1) | Tests 11 passed (11)   (was 6 — added 5 tests: F2, F3a, F3b, F4, F5)

npm run --workspace @agent-relay/sdk check   # tsc -p tsconfig.json --noEmit
  → clean (no output)

npx prettier --check packages/sdk/src/messaging/relaycast.ts \
  packages/sdk/src/messaging/placement.test.mts CHANGELOG.md
  → All matched files use Prettier code style!
```

## Files changed
- `CHANGELOG.md` — F1 changelog bullet.
- `packages/sdk/src/messaging/relaycast.ts` — F3 reconcile-on-overflow, F4 union/reason
  cleanup + message wording, F6 delay floor.
- `packages/sdk/src/messaging/placement.test.mts` — F2/F3/F4/F5 tests (6 → 11).

All findings resolved; no skips.
