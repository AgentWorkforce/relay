# Release resilience: upstream prerequisite, no Relay PR

Inspected Relay `dadaf85` on `lane/release-resilience-0907` and Relaycast
`04fc9bc602c99388ffc0f8e2db8062ba8918a6f5` on 2026-09-07.

## Disposition

No production change and no Relay PR. The requested leak fix is **not
implemented**. Adding automatic replay to the current name-addressed release
would violate the assignment's stronger constraint: never release a replacement
worker. The remaining prerequisite belongs in the Relaycast release contract
and distribution. Work was restricted to this checkout; no live identity was
released and no other repository was modified.

Relaycast #377 already implements token-generation checks. This is newer than
the unresolved review on Relay #1672; that review's statement that upstream has
no guard is now obsolete. However, the current guarded method uses the same
endpoint as older servers, which silently discard the condition. A broker
cannot turn that request into a fail-closed operation by attaching an extra
field, checking a stable agent ID, or checking server version in a separate
request. A mixed rollout can route the destructive request to an older server.

The smallest upstream prerequisite is a distinct conditional-release endpoint
(or an equivalently enforced request-version contract): require the generation
condition on that endpoint and return an error on unsupported deployments.
Old servers must return 404/unsupported, never perform an unconditional release.
Publish its Rust SDK surface. Then broker persistence and the existing 3-attempt
retry helper can be wired to that contract without an unsafe fallback.

## Evidence

- [Relay startup retry precedent](https://github.com/AgentWorkforce/relay/blob/dadaf85/crates/broker/src/relaycast/auth.rs#L916): 200/400 ms backoffs; only
  500/502/503/504; final diagnostics and total attempts preserved; no transport
  retries. This should be reused after release is safely replayable.
- [Current broker release](https://github.com/AgentWorkforce/relay/blob/dadaf85/crates/broker/src/relaycast/ws.rs#L931) invalidates the cached credential, then
  submits only name, reason, and the default non-delete behavior. An accepted
  invocation is treated as success without proving terminal completion.
- [HTTP release cleanup](https://github.com/AgentWorkforce/relay/blob/dadaf85/crates/broker/src/runtime/api.rs#L893) removes persisted worker state even after
  identity release fails. The retry branch sends the name again. Neither branch
  retains a durable generation-bound cleanup intent.
- [Pre-guard Relaycast route](https://github.com/AgentWorkforce/relaycast/blob/234ca1cabd964d3c2171e96abd990f7bf4e4b60b/packages/engine/src/routes/agent.ts#L935)
  reconstructs the dispatch input from name, reason, and delete_agent only.
  Thus even a supplied generation field is discarded before dispatch.
- [Current route](https://github.com/AgentWorkforce/relaycast/blob/04fc9bc602c99388ffc0f8e2db8062ba8918a6f5/packages/engine/src/routes/agent.ts#L935)
  forwards optional expected_token_hash. [Engine enforcement](https://github.com/AgentWorkforce/relaycast/blob/04fc9bc602c99388ffc0f8e2db8062ba8918a6f5/packages/engine/src/engine/action.ts#L1059)
  checks the token generation and conditions completion mutations atomically.
  [PR #377](https://github.com/AgentWorkforce/relaycast/pull/377) merged September
  6 and is listed in [v8.5.0](https://github.com/AgentWorkforce/relaycast/releases/tag/v8.5.0).
- [Upstream Rust method](https://github.com/AgentWorkforce/relaycast/blob/04fc9bc602c99388ffc0f8e2db8062ba8918a6f5/packages/sdk-rust/src/relay.rs#L546)
  `release_agent_if_token_hash` is present in source, but absent from this
  checkout's installed/pinned SDK 8.0.0. The latest listed Rust release remains
  sdk-rust-v8.0.0; the crates.io sparse index also reports 8.0.0 as the latest
  non-yanked version. A local HTTP adapter could encode the field, but would not fix
  the old-server behavior above.
- The no-host release branch requires delete_agent=true to complete locally;
  otherwise it returns agent_host_unavailable (503). Blind retries cannot fix
  that permanent state. Both branches still require exact generation ownership.
- [Released rows are tombstones](https://github.com/AgentWorkforce/relaycast/blob/04fc9bc602c99388ffc0f8e2db8062ba8918a6f5/packages/engine/src/engine/agent.ts#L601)
  to preserve history attribution. [Roster queries exclude them](https://github.com/AgentWorkforce/relaycast/blob/04fc9bc602c99388ffc0f8e2db8062ba8918a6f5/packages/engine/src/engine/agent.ts#L315).
  Correct release removes leaked roster membership, but does not physically
  shrink the agents table. The reported 4,481 offline count was supplied by the
  assignment; it was not remeasured here. Its relation to database overload
  requires server-side query/storage evidence, not inference from the count alone.

## Required recovery record after the prerequisite

Persist an intent **before terminating the worker**, independently of the
ordinary persisted worker map and ephemeral-runtime cleanup. Use a durable,
per-broker journal with atomic replacement plus file/directory synchronization;
refuse teardown if the initial write fails. Include schema version, operation
ID, workspace ID, server identity, worker name, immutable agent ID, original
issued-token generation hash, creation time, lifecycle phase, invocation ID
when available, attempt count, and sanitized last error code/status/request ID.
Do not store raw tokens or workspace credentials. Do not expose the generation
hash in normal diagnostics.

The captured generation must come from the worker's issued credential before
cache invalidation. Never resolve a fresh token by name during recovery. Keep
pending intents separate from same-name replacement state so spawn, reaping,
and broker restart cannot erase or overwrite them. An operator/sweep needs
explicit list and retry operations keyed by operation ID, not just name.

Use the existing 200/400 ms helper for the conditional submission, without
silently changing its status or transport policy. Exhaustion returns a hard
error naming the durable operation and the recovery command. Pending or
dispatched invocation receipts remain pending; clear the intent only on proven
terminal cleanup. Preserve ambiguous outcomes for reconciliation by invocation
ID. A generation conflict must never retry with a new generation; retain an
explicit superseded/conflict result so the operator can account for it.

Required behavioral tests include persistent 503 followed by broker restart and
successful recovery; same-ID takeover before retry; takeover between dispatch
and completion; old server rejecting conditional release without mutation;
record-write failure before process teardown; pending receipt versus completed
cleanup; absent original identity; 501 and transport failures; and no diagnostic
credential leakage. These are proposed tests, not claimed executed tests.

## Executed red/green contract check

Command: `python3 .agentworkforce/trajectories/release-resilience-0907/verify_contract.py`

The script fetches pinned source through read-only GitHub API calls and executes
the actual release route's JavaScript input projection with a synthetic fixture.
It makes no release request. This verifies the compatibility gap; it is **not**
red/green evidence for a broker implementation or for deployed server behavior.

```text
RED: pre-guard route (234ca1cabd964d3c2171e96abd990f7bf4e4b60b)
release route retains generation guard: false
FAIL: conditional release becomes unconditional
exit code: 1
GREEN: current upstream route (04fc9bc602c99388ffc0f8e2db8062ba8918a6f5)
release route retains generation guard: true
PASS: release route forwards generation guard
exit code: 0
Current upstream Rust source contains release_agent_if_token_hash.
This audit does not demonstrate a broker fix, server rollout, or live cleanup.
```

## Related issues and review

Read [#1114](https://github.com/AgentWorkforce/relay/issues/1114),
[#1125](https://github.com/AgentWorkforce/relay/issues/1125),
[#1671](https://github.com/AgentWorkforce/relay/issues/1671), and the complete diff
of [#1672](https://github.com/AgentWorkforce/relay/pull/1672). #1125 has a June 24
audit comment saying its local process/name cleanup appeared fixed; it is not
evidence that remote lifecycle cleanup is durable.

Queried GraphQL `reviewThreads(first:100)` with `hasNextPage=false`. #1672 has
one unresolved [generation-guard P1](https://github.com/AgentWorkforce/relay/pull/1672#discussion_r3943190504).
It must remain unresolved on that PR: its stable-ID GET followed by a
name-addressed POST does not bind cleanup to a token generation. This audit
does not modify someone else's PR or mark the thread resolved. No new PR exists
for this lane, so there are no lane review threads or lane PR CI results.

Per-job results for the inspected #1672 head are recorded in
`pr-1672-checks.json` and the generated `pr-1672-checks.md`. Those are evidence
about that PR, not successful validation of a new fix. SKIPPED means absent
coverage, not passed.

## Local validation

- `cargo fmt --check`: exit 0, no output.
- `cargo clippy --workspace --all-targets -- -D warnings`: exit 0.

```text
    Checking relaycast v8.0.0
    Checking agent-relay-broker v3.0.0
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 39.45s
```

No Rust product files changed. No runtime release regression suite or live
cleanup test was run; the executed red/green check is the source-contract audit
above. There is no claim that this audit stopped the leak.
