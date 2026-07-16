# Plan 001 fresh-context adversarial review 1

## Verdict

**REJECT - changes required before final acceptance or commit.**

The implementation has five release-blocking correctness and contract gaps. The focused suites pass, but they do not exercise the failing seams described below. This review was read-only with respect to source code; only this review artifact was added.

## Findings

### P1 - Duplicate broker redelivery is accepted by the session but never acknowledged again

Evidence:

- `packages/harnesses/src/ai-sdk/sidecar.ts:183-201` stores the current `delivery_id`, calls `receiveMessage`, and relies exclusively on a later `delivery.accepted` event to emit `delivery_ack`.
- `packages/harnesses/src/ai-sdk/sidecar.ts:137-147` is the only `delivery_ack` path.
- `packages/harnesses/src/ai-sdk/relay-session.ts:391-393` returns a cached receipt for a duplicate idempotency key without re-emitting `delivery.accepted`.
- `packages/harnesses/src/ai-sdk/sidecar.test.ts:73-119` tests semantic-command deduplication, but sends only one `deliver_relay` frame.

Reproduction reasoning:

1. The broker sends delivery `D`; the sidecar accepts it, emits `delivery_ack`, and the session caches the accepted receipt.
2. If that acknowledgement is lost or the broker redelivers `D` before persisting it, the sidecar overwrites `relayDeliveries[D]` and `receiveMessage` returns the cached accepted receipt.
3. No `delivery.accepted` event is emitted on the cached path, so the sidecar never sends the second acknowledgement.
4. The broker can retry and eventually dead-letter work that the adapter already accepted, violating truthful durable receipt and idempotent delivery semantics.

Required fix:

- When `receiveMessage` returns an already-accepted receipt, send `delivery_ack` immediately for the current broker frame. Preserve deferred behavior, and add a sidecar-level test that sends the same `deliver_relay` frame twice and requires two broker acknowledgements with only one adapter injection.

### P1 - `agent_spawned` can erase semantic startup history emitted by the new sidecar

Evidence:

- `crates/broker/src/replay_buffer.rs:79-87` clears semantic history for `agent_spawned`, `agent_released`, and `agent_exited`.
- `crates/broker/src/worker.rs:825-857` starts the child, starts stdout readers, registers the handle, and sends `init_worker` before the HTTP spawn path publishes `agent_spawned`.
- `crates/broker/src/runtime/api.rs:586-611` publishes `agent_spawned` only after `spawn_agent` has returned.
- `packages/harnesses/src/ai-sdk/sidecar.ts:92-127` creates and starts the host before reading `init_worker`; `HarnessHost.start()` emits `session.starting` and `session.started` during that interval.

Reproduction reasoning:

The semantic child can emit startup events through its already-running stdout reader before the outer spawn request publishes `agent_spawned`. Those events enter the semantic replay buffer, then `agent_spawned` removes the just-created history. A later attach therefore cannot replay the session start, even though the sidecar produced it successfully. This violates ordered, gap-free semantic history and the lifecycle replay done criterion.

Required fix:

- Reset stale semantic history before launching/registering a replacement worker, keyed to a new runtime generation or session id. Do not clear current-generation history in the broadcast `agent_spawned` path. Add an integration test where semantic events arrive before the spawn event and remain present afterward.

### P1 - The broker stream never receives the advertised activity transitions or capability-discovery event

Evidence:

- `packages/harnesses/src/ai-sdk/sidecar.ts:101-125` forwards raw `HarnessHost` events and diagnostics directly.
- `packages/harnesses/src/ai-sdk/sidecar.ts:127-148` creates `RelayHarnessSession` only after `host.start()` and listens only for `delivery.accepted`; it does not forward mapped semantic events, reducer transitions, or `observability.capabilities`.
- `packages/harnesses/src/ai-sdk/relay-session.ts:299-307` is where canonical mapping and `reduceAgentActivity` actually occur.
- `packages/harnesses/src/ai-sdk/relay-session.ts:311-323` is where capability discovery is emitted to listeners.
- `packages/cli/src/cli/lib/attach-semantic.ts:50-53` expects `activity.changed`, but the sidecar's broker-facing path cannot emit it.

Reproduction reasoning:

Starting a semantic sidecar yields raw host events such as `turn.started`, `text.delta`, and `turn.settled`. The activity reducer runs inside `RelayHarnessSession`, but its output is discarded by the sidecar listener except for delivery acknowledgements. Capability discovery is likewise never transported. Semantic attach therefore cannot display current activity, and observer consumers cannot discover fidelity/capability coverage, despite both being public Plan 001 promises.

Required fix:

- Establish one canonical broker-facing event publisher from `RelayHarnessSession`, including the initial capability event and every reducer transition, with a single strictly monotonic per-agent sequence. Avoid double-publishing raw and mapped forms. Add sidecar-to-broker tests asserting capability discovery plus `starting -> thinking -> typing/using_tool/waiting -> idle` activity events survive replay.

### P1 - Lifecycle capabilities are advertised but not reachable through the sidecar/broker public control surface

Evidence:

- `packages/harnesses/src/ai-sdk/adapter-registry.ts:78-88` advertises compact, continue, suspend, detach, stop, and destroy for the full lifecycle.
- `packages/harnesses/src/define.ts:220-229` publishes those registry lifecycle claims as `semanticCapabilities` runtime metadata.
- `packages/harness-driver/src/protocol.ts:99-105` exposes only user message, interrupt, approve/reject, and release command kinds.
- `packages/harnesses/src/ai-sdk/sidecar.ts:237-264` handles only those same commands.
- `packages/harnesses/src/ai-sdk/harness-host.ts:464-565` implements compact/suspend/continue/detach/stop internally, but no broker or `AgentSession` API can invoke them.
- `tests/integration/ai-sdk-harnesses/adapter-contract.test.ts:60-145` proves lifecycle only by constructing and calling `HarnessHost` directly, bypassing the shipped broker/sidecar path.

Reproduction reasoning:

An attach or API consumer can discover `detach: true`, `stop: true`, `suspendTurn: true`, and related claims, yet no semantic command exists to request those operations or resume the returned state. The tests pass because they exercise an internal host object unavailable to real broker clients. This is capability-inaccurate behavior and fails the lifecycle and broker-control done criteria.

Required fix:

- Either add versioned, correlated sidecar commands and durable/resumable state handling for each advertised operation, or mark inaccessible operations unavailable in the public runtime capability profile. Extend contract tests through `HarnessDriverClient` and the broker, not only `HarnessHost`.

### P1 - The local-host provider is not cross-platform and does not actually hold exclusive bridge ports

Evidence:

- `packages/harnesses/src/ai-sdk/local-host-sandbox.ts:68-81` binds a loopback server only long enough to discover a port, closes it, then returns the number.
- `packages/harnesses/src/ai-sdk/local-host-sandbox.ts:349-352` records that now-unbound number only in an in-process `Set`; no OS lease remains until the adapter binds.
- `packages/harnesses/src/ai-sdk/local-host-sandbox.ts:205-210` and `421-424` hardcode `/bin/sh -lc` for normal execution and preflight.
- `packages/harnesses/src/ai-sdk/harness-host.ts:344-348` also depends on shell `mkdir -p` during every start.
- `packages/harnesses/src/ai-sdk/local-host-sandbox.test.ts:39-50` checks only that two returned numbers differ; it never races an external bind or runs on Windows.

Reproduction reasoning:

On Windows, `/bin/sh` generally does not exist, so preflight and the first host start fail even though Relay publishes a Windows broker package and the migration claims package-wide Node 22 support. On every OS, another process can bind the selected bridge port after the temporary server closes and before the adapter listens. The provider's `Set` prevents only duplicate choices inside one provider instance, not external or cross-process collision, so the plan's exclusive-port guarantee and promotion soak assumptions are false.

Required fix:

- Replace hardcoded POSIX shell and `mkdir -p` with cross-platform process execution/filesystem APIs (or explicitly remove Windows support everywhere, including packages/docs/CI). Implement a real port handoff/reservation strategy supported by the adapter contract, or retry typed bind collisions until the adapter owns the port. Add Windows coverage and an external competing-bind test.

## Validation and false-confidence assessment

Focused command:

```text
npx vitest run packages/harnesses/src/ai-sdk/sidecar.test.ts packages/harnesses/src/ai-sdk/local-host-sandbox.test.ts packages/cli/src/cli/lib/attach-semantic.test.ts tests/integration/ai-sdk-harnesses/semantic-attach-order.test.ts tests/integration/ai-sdk-harnesses/adapter-contract.test.ts
```

Result outside the filesystem/network sandbox: **5 files passed, 53 tests passed**. The first sandboxed attempt failed because loopback bind was denied with `listen EPERM`, not because of product behavior. The green rerun demonstrates that the current suite does not cover the five failures above.

## Done-criterion impact

These findings block the Plan 001 criteria for truthful delivery ordering/deduplication, broker-supervised authenticated replay and acknowledged input, public activity/capability publication, capability-accurate HarnessV1 lifecycle operations, exclusive loopback/process ownership, semantic attach activity rendering, and full acceptance suites providing meaningful confidence.
