# Plan 001 fresh-context Codex adversarial review 1

## Verdict

**REJECT - three P1 blockers and one P2 correctness gap remain.**

The five Claude-review repairs are present and their focused regressions pass, but the implementation still does not meet Plan 001's Relaycast/public-listener or exclusive-port contracts. This review did not edit source code.

## Findings

### P1 - Canonical semantic events never reach Relaycast or `AgentRelay` listeners

Evidence:

- `packages/harnesses/src/ai-sdk/sidecar.ts:106-118` writes canonical session events only as `semantic_event` worker frames.
- `crates/broker/src/runtime/worker_events.rs:301-338` validates those frames and forwards them only through the broker-local `sdk_out_tx` event stream. This branch never uses `relaycast_http`, even though it is captured at line 10.
- No code under `crates/broker/src/runtime/relaycast_events.rs` handles `semantic_event`, `activity.changed`, or `observability.capabilities`.
- `packages/sdk/src/listeners.ts:646-663` can translate a supplied session event into `agent.activity.changed`, but `packages/sdk/src/listeners.ts:788-796` only dispatches events manually supplied through `emitSessionEvent`.
- `packages/sdk/src/agent-relay.ts:400-402` is the only production entry to that hub. Repository search finds no broker/Relaycast semantic-event adapter calling it; the existing listener tests call it manually (`packages/sdk/src/__tests__/listeners.test.ts:119-135`, `:167`).

Reproduction:

1. Start a semantic harness and subscribe with `relay.addListener('agent.activity.changed', handler)`.
2. Let the sidecar emit `observability.capabilities` and an `activity.changed` event.
3. The CLI semantic attach sees the broker-local `semantic_event`, but the Relaycast connection and `AgentRelay` listener hub receive nothing because neither transport feeds `emitSessionEvent`.

This directly falsifies the advertised changelog/README claim and the done criterion that Relaycast publishes activity transitions, canonical semantic events, and capability discovery.

Required fix:

- Publish validated canonical semantic events to Relaycast using the agent's authenticated identity and stable public event names, and/or wire the broker semantic stream into `AgentRelay`'s session-event hub. Add an end-to-end test that starts at a broker `semantic_event` frame and proves `relay.addListener('agent.activity.changed', ...)`, canonical session listeners, and capability discovery all fire without a manual `emitSessionEvent` call.

### P1 - The loopback reservation is released before the adapter owns the port

Evidence:

- `packages/harnesses/src/ai-sdk/local-host-sandbox.ts:75-91` creates the OS reservation.
- `packages/harnesses/src/ai-sdk/local-host-sandbox.ts:218-223` closes it when the command text or one exact environment value mentions the port.
- Only after awaiting that close does `packages/harnesses/src/ai-sdk/local-host-sandbox.ts:224-229` spawn `/bin/sh`. The bridge binds later, inside the child.
- `packages/harnesses/src/ai-sdk/local-host-sandbox.test.ts:54-73` proves only that the port is held before `spawn()` and that one immediate child bind succeeds. It never competes during the post-close/pre-bind interval.

Reproduction:

Call `session.spawn()` with a command that mentions the leased port but delays its bind (for example, `sleep 1; node <bridge-bind-script>`) and immediately bind an external `net.Server` after `spawn()` returns. The provider has already closed its reservation, so the competitor can own the port before the delayed bridge. The bridge then fails with `EADDRINUSE`.

The repair narrows the race but does not provide the plan's exclusive reservation/handoff guarantee or a typed retry on bind collision.

Required fix:

- Use a bridge contract that accepts an inherited listening socket/file descriptor, or implement a broker/provider handshake that retains the reservation until the child confirms ownership. If the adapters cannot inherit the socket, detect typed bind failure and reserve/retry a new port through a bounded start loop. Add the delayed-child plus competing-bind regression.

### P1 - The advertised restricted filesystem surface is bypassable through workspace symlinks

Evidence:

- `packages/harnesses/src/ai-sdk/local-host-sandbox.ts:49-52` and `:135-141` validate only the lexical resolved path.
- `readFile`, `writeFile`, and their text/binary variants then access that path without resolving or constraining symlink targets (`:147-207`).

Reproduction:

Create `workspace/link -> /outside`, then call `session.readTextFile({ path: 'link/secret' })` or `writeTextFile({ path: 'link/new-file', ... })`. The lexical path is inside the workspace, but the kernel follows the symlink outside it. This contradicts the plan's restricted file surface and the provider's explicit outside-path rejection behavior.

Required fix:

- Define the security contract honestly. If file APIs are intended to be workspace/runtime-root constrained, canonicalize existing ancestors with `realpath`, reject escaping symlinks, and use safe open/write patterns that prevent final-component and parent TOCTOU escapes. Add read and write symlink-escape tests. If no filesystem isolation is intended at all, remove the misleading restriction claim and tests from the public contract and documentation.

### P2 - Semantic command idempotency can acknowledge a different command without executing it

Evidence:

- `packages/harnesses/src/ai-sdk/sidecar.ts:161` creates an unbounded acknowledgement map keyed only by `idempotency_key`.
- `packages/harnesses/src/ai-sdk/sidecar.ts:245-254` returns the prior successful acknowledgement for every later command with that key without comparing command kind or payload.
- `packages/harnesses/src/ai-sdk/sidecar.ts:314` retains every key for the full sidecar lifetime.

Reproduction:

Send `compact` with idempotency key `K`, then send `release` or `submit_user_message` with the same key `K`. The second request receives `accepted: true, duplicate: true`, but its operation is never executed. A long-lived drive session also grows the map without bound.

Required fix:

- Cache a stable digest of the canonical command with each acknowledgement. Replay only an identical command; reject key reuse with different kind/payload as an idempotency conflict. Bound the cache with a documented retention policy and add conflict/eviction tests.

## Repair verification

- Duplicate delivery re-ack: repaired path at `packages/harnesses/src/ai-sdk/sidecar.ts:194-223`; focused test requires two acks and one injection.
- Broker generation/history reset: reset now precedes replacement launch at `crates/broker/src/runtime/api.rs:520-525`; `agent_spawned` no longer clears current history.
- Canonical sidecar sequencing: the session listener is installed before `host.start()` and serializes one sequence at `packages/harnesses/src/ai-sdk/sidecar.ts:103-159`.
- Public lifecycle truthfulness: public metadata disables unreachable state-token operations and exposes compact only according to the adapter contract (`packages/harnesses/src/define.ts:221-232`). The HTTP payload preserves compact instructions through the raw worker frame.
- Platform honesty: Windows semantic local-host creation fails with an explicit PTY fallback at `packages/harnesses/src/ai-sdk/local-host-sandbox.ts:400-405`.

## Executed evidence

- Focused semantic/sidecar/port/client suite outside the loopback-restricted sandbox: **4 files passed, 19 tests passed**.
- Focused Rust semantic suite: **8 semantic unit tests passed**, plus the filtered fleet wire fixture.
- The initial sandboxed Vitest run failed with `listen EPERM` for loopback binds; this was an environment restriction, not product evidence.

The green suites do not exercise Relaycast/AgentRelay delivery, a delayed bridge bind with an external competitor, symlink traversal, or conflicting idempotency-key reuse. Plan 001 must remain `IN PROGRESS`; signoff is withheld.
