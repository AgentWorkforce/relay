# Fresh-Eyes Review — factory p12 (node-targeted placement; reject-and-reconcile)

**Reviewer:** claude (non-interactive)
**Branch:** `ricky/factory-p12-node-placement`
**Scope reviewed:** `packages/sdk/src/messaging/{types.ts,relaycast.ts,index.ts}`,
`placement.test.mts`, `vitest.placement.config.mts`, spec
`linear-issue-factory-fleet-p12-node-placement.md`, repo rules (CLAUDE.md,
`.claude/rules/*`).

## Verdict

**Implementation is correct and spec-aligned.** All four acceptance criteria are
implemented; the placement engine filters on capability → liveness → repo key
before invoking, hard-fails capability mismatch before any side effect, and
routes the no-eligible-node / unmapped-repo paths through a bounded TTL queue
with reconcile events and log lines (never a silent drop).

Verified locally (re-ran, not just trusting the self-reflection):
- `npx vitest run --config packages/sdk/src/messaging/vitest.placement.config.mts` → **6 passed**
- `npm run --workspace @agent-relay/sdk check` (tsc --noEmit) → **clean**
- New required field `RelayNode.live` is safe: `RelayNode` is only constructed via
  `toRelayNode`, and `RelayListNodesOptions` already exposes `capability`/`name`.

The findings below are improvements (one repo-rule miss, several test gaps, one
latent code smell). None block correctness, but the test gaps leave two
spec-mandated behaviors (`bounded-queue-then-fail` overflow, AC #4 no-bleed with
two eligible nodes) entirely unproven.

---

## Findings

### F1 — [Medium] CHANGELOG `[Unreleased]` not curated for the new public SDK surface
- **File:** `CHANGELOG.md`
- **Problem:** CLAUDE.md requires curating `[Unreleased]` as changes land. This PR
  adds user-visible `@agent-relay/sdk` API — `RelaycastMessagingClient.placement.spawn`,
  the exported `RelayPlacementError`, and the `RelaySpawnPlacementInput/Ack`,
  `RelayPlacementReconcileEvent` types — but `[Unreleased]` has no entry for it.
- **Required fix:** Add one impact-first bullet under `### Added`, e.g.:
  `` `@agent-relay/sdk` adds `placement.spawn({ capability, node?, repo? })` — targeted/`self`/least-eligible node placement with capability+repo-key gating, bounded-TTL queueing, and reconcile events; capability mismatch throws `RelayPlacementError`. ``
- **Required test:** none (doc change). Confirm with `grep -n placement.spawn CHANGELOG.md`.

### F2 — [Medium] AC #4 ("two nodes, no bleed") has no dedicated test
- **File:** `packages/sdk/src/messaging/placement.test.mts`
- **Problem:** Acceptance criterion #4 — "Two nodes in one workspace: work lands on a
  live eligible one without bleed" — is only indirectly exercised. The "reconciles
  an unmapped repo" test has two nodes but only **one** is ever eligible. No test
  asserts behavior when **two simultaneously-eligible** nodes exist (that exactly one
  is selected and the spawn action is invoked exactly once).
- **Required fix:** none in source (untargeted selection already picks `eligible[0]`
  in `selectPlacementNode`, relaycast.ts:1267-1271).
- **Required test:** Add a case with two live nodes both advertising `spawn:claude`
  and both mapping `relay`; assert `invoke` is called exactly once
  (`expect(invoke).toHaveBeenCalledTimes(1)`) and `ack.placement.node` is one of the
  two — proving a single placement with no cross-node double-dispatch.

### F3 — [Medium] Untested spec paths: queue-overflow and fail-fast
- **File:** `packages/sdk/src/messaging/placement.test.mts` (+ relaycast.ts:1166-1176, 1147)
- **Problem:** The spec mandates "bounded-queue then fail." The `placement_queue_full`
  branch (cap = `maxQueuedPlacements`) and the `failFast` short-circuit are both
  completely uncovered. The queue-full path also throws **without** emitting an
  `onReconcile({ action: 'failed' })` event (only `logPlacement`), so a caller relying
  on the reconcile hook for Slack surfacing would not see an overflow rejection — worth
  deciding deliberately and pinning with a test.
- **Required fix:** Optional but recommended — emit a `reconcilePlacement(..., { action: 'failed', reason })`
  before throwing `placement_queue_full`, so every non-placed outcome reaches the
  reconcile hook (consistent with the TTL-expired path at relaycast.ts:1149).
- **Required test:** (a) construct a client with `maxQueuedPlacements: 0` (or 1 with a
  second concurrent queued placement) and assert the spawn rejects with
  `code === 'placement_queue_full'`; (b) a `failFast: true` placement with no eligible
  node rejects with `placement_ttl_expired` after a single attempt and fires
  `onReconcile({ action: 'failed' })`.

### F4 — [Low] Misleading `reason` on targeted offline / unregistered selections
- **File:** `packages/sdk/src/messaging/relaycast.ts:1233-1256`
- **Problem:** When a targeted node is unregistered or offline, the returned selection
  carries `reason: 'unmapped_repo'` while `reconcileReason: 'target_offline'`. The
  `reason` field is currently dead on non-`hardFail` selections (only `reconcileReason`
  is consumed in the queue/fail path, and the TTL error hard-codes
  `'placement_ttl_expired'`), so this is latent — but it is a trap: any future code
  that reads `decision.reason` on a queued selection will mislabel an offline target as
  an unmapped repo.
- **Required fix:** Either drop `reason` from the non-`hardFail` branch of the
  `PlacementSelection` union (make it `hardFail`-only), or set an accurate value
  (e.g. add `'target_offline'`/`'no_eligible_node'` to the `reason` union and use it).
- **Required test:** Add a targeted-offline placement test asserting the reconcile event
  is `{ action: 'queued', reason: 'target_offline' }` — this both covers the uncovered
  offline-target branch and guards the labeling.

### F5 — [Low] Targeted unmapped-repo branch is uncovered
- **File:** `packages/sdk/src/messaging/relaycast.ts:1257-1263`; test file
- **Problem:** The unmapped-repo reconcile is only tested via the **untargeted** path.
  The targeted branch (node live + capable but repo not in `repoKeys`) — which queues
  with `reconcileReason: 'unmapped_repo'` — has no proof.
- **Required fix:** none in source.
- **Required test:** Targeted placement at a live, capable node whose `repo_keys` omit
  the requested repo; assert it queues (`onReconcile` fires `reason: 'unmapped_repo'`)
  and then resolves once the node's repo map is updated to include it, or fails at TTL —
  proving the targeted reject-and-reconcile, not just the untargeted one.

### F6 — [Nit] Possible brief busy-spin at the TTL boundary
- **File:** `packages/sdk/src/messaging/relaycast.ts:1190`
- **Problem:** `delay(Math.min(pollIntervalMs, Math.max(0, ttlMs - elapsed)))` can compute
  ~0ms as the deadline approaches, yielding one or two near-zero-delay loop iterations
  before the `elapsed >= ttlMs` check fails the placement. Negligible in practice.
- **Required fix:** none required; if touched, floor the queued delay at a small minimum
  (e.g. `Math.max(5, ...)`) once past the first poll.
- **Required test:** none.

---

## Spec / rule compliance checks (pass)
- AC #1 named placement + capability-mismatch hard fail — **covered** (test:104-125).
- AC #2 unmapped-repo reject-and-reconcile with log line — **covered for untargeted**
  (test:156-203); targeted variant untested (F5).
- AC #3 no-eligible → bounded-queue → drain / TTL-fail — **drain + TTL covered**
  (test:205-241); overflow branch untested (F3).
- AC #4 two-node no-bleed — **partially covered**, needs F2.
- Git rule: stayed on feature branch, no main push. **OK.**
- `.agentworkforce/trajectories/` not gitignored. **OK.**
- Out-of-scope items (least-loaded, persistence, node-side `repoPaths` push)
  correctly deferred and documented in self-reflection. **OK.**

## Recommended action before merge
Land F1 (changelog) and at least the F2 + F3 tests — they pin the two acceptance-
criteria behaviors (no-bleed selection, bounded-queue overflow/fail) that currently
have zero coverage. F4/F5/F6 are polish.
