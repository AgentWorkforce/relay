# Plan 001 final adversarial signoff 2

## Verdict

**REJECT - one P1 scope blocker and three P2 reliability/verification gaps remain.**

I reviewed Plan 001, the first final-signoff rejection and its resolution, the current implementation, the public docs/changelog, and the relevant tests. I did not edit product source. The latest repairs are real and useful: canonical AI SDK events now have a Relaycast agent-event write path; duplicate transport diagnostics are no longer published beside canonical diagnostics; Relaycast HTTP latency no longer blocks the worker event loop; the PTY observer subscribes before spawn and replays the real `agent_spawned` boundary; PTY publication is serialized; terminal broker events close runtime observers; and the filesystem boundary is now described honestly as best-effort rather than TOCTOU-safe isolation.

Those repairs do not make the current cross-runtime claim true.

## Blocking findings

### P1 - Canonical PTY activity exists only for one library wrapper, not for Relay's PTY runtime

The production translator is wired only by `definePtyHarness(...).create({ relay })`:

- `packages/harnesses/src/define.ts:137-194` creates the translator, observes broker events, and calls `relay.publishSessionEvent(...)`.
- Relay's normal CLI path bypasses that wrapper: `packages/cli/src/cli/commands/local-agent.ts` calls `spawnAgentWithClient`, and `packages/cli/src/cli/lib/client-factory.ts:71` calls `HarnessDriverClient.spawnPty(...)` directly.
- Fleet/SDK placement and direct `HarnessDriverClient.spawnPty(...)` callers likewise do not instantiate `createPtyObservabilityTranslator`.
- A repository-wide production search finds no broker-owned PTY canonical publisher and no other translator call site.

Therefore agents spawned by `agent-relay ... agent spawn`, fleet placement, the thin SDK, or direct harness-driver use still produce no canonical `activity.changed` events in Relaycast. The current work only covers consumers that explicitly use the `@agent-relay/harnesses` managed wrapper with an `AgentRelay` instance.

This contradicts the governing outcome that "Relaycast publishes the same canonical activity and semantic event vocabulary for every runtime," the Step 7 requirement that every PTY harness report the baseline, `packages/harnesses/README.md:47-49`, and `CHANGELOG.md:13` ("across AI SDK and PTY runtimes"). It also misses the user's core goal: Relay itself should look for and expose these statuses regardless of which supported spawn surface created the PTY agent.

Required repair: make PTY canonical translation broker-owned, or route every supported PTY spawn surface through one broker-owned observability component. Avoid double-publishing from the current TypeScript wrapper once the broker owns it. Add coverage for at least CLI/direct broker spawn as well as the wrapper path.

### P2 - Hosted AI SDK publication is ordered but best-effort, not durable delivery

`crates/broker/src/runtime/init.rs:221-238` uses one global 10,000-entry queue and one publisher task. `worker_events.rs` uses `try_send`; a full or closed queue drops the event. Each HTTP failure/timeout is logged and discarded without retry or persistence, and broker shutdown does not drain an outbox.

This is a reasonable non-blocking telemetry path, but it is not a durable publication guarantee. A Relaycast outage can delay all agents behind one global five-second timeout, fill the queue, and permanently lose lifecycle/activity transitions. The resolution's statement that frames are published to Relaycast "before" the local stream is also inaccurate: only queue insertion precedes the local stream; remote persistence happens asynchronously afterward.

Required repair: either add a bounded persisted/retryable outbox with per-agent order and an explicit overflow policy, or narrow public claims to best-effort observability and expose a gap/drop diagnostic so consumers do not mistake an incomplete durable log for a complete lifecycle.

### P2 - No end-to-end test proves worker semantic frames enter the hosted queue with canonical mapping

`crates/broker/src/relaycast/ws.rs:738-773` proves the low-level client can POST one hand-built `activity.changed` payload. It does not execute the `worker_events.rs` semantic branch, validate `kind` removal/envelope enrichment, verify diagnostic de-duplication, prove queue ordering, or exercise queue saturation/failure behavior.

The TypeScript tests use fake clients and fake runtimes. They establish wrapper wiring, history/live de-duplication, and early PTY buffering, but not a real sidecar-frame -> broker -> Relaycast agent-event round trip. The prior review explicitly required a real broker-boundary regression; that gap remains.

Required repair: feed canonical semantic and transport-diagnostic frames through the broker runtime against a mock Relaycast server, assert exactly one canonical diagnostic, stable event type/payload, order, and local replay, and include a failure/queue policy test.

### P2 - Semantic crash cleanup still has an untested race and retains the tracked disposer

`packages/harness-driver/src/broker-driver.ts:153-173` creates the semantic subscription and only then registers the separate terminal-event listener. A terminal broker event delivered in that interval is ignored by the semantic subscription and can be missed by the cleanup listener. After a later terminal event, the iterator and handler are closed, but the semantic disposer remains in the runtime's `observers` set because the private observer cannot remove its tracked wrapper on self-termination.

The current test checks history/live reconciliation only. It does not deliver `agent_exit`, `agent_exited`, or `worker_error` to a semantic runtime and assert iterator return, unsubscribe count, settled delivery, and release idempotency.

Required repair: attach terminal handling atomically with the broker cursor/subscription (or use one buffered event seam), remove the tracked disposer on self-termination, and add the crash/release regression.

## Contract audit

- **Hosted canonical AI SDK names/payloads:** the broker now posts semantic event `kind` as the Relaycast session-event type and carries canonical fields plus protocol envelope metadata. Canonical `diagnostic` is published once; `semantic_diagnostic` remains local attach transport. Accepted, subject to the missing broker-round-trip test and best-effort delivery caveat above.
- **PTY ordering/de-duplication in the managed wrapper:** real pre-return `agent_spawned` and output are buffered, translator transitions are deduplicated, and publication is serialized. Accepted for that wrapper only.
- **Local semantic replay/order:** subscribe-first plus history reconciliation and a semantic high-water mark are coherent for retained monotonic sidecar history. Accepted.
- **Filesystem boundary:** Plan 001 and the harness README explicitly reject a TOCTOU-safe/untrusted-code interpretation. Static lexical/symlink checks match that narrowed contract. Accepted.
- **Lifecycle capability honesty:** unsupported state-token lifecycle operations remain disabled publicly. Accepted.
- **Rollout honesty:** no adapter is promoted; `plans/README.md` correctly remains `IN PROGRESS`, and real-provider/macOS/Linux evidence remains a promotion gate. Accepted.
- **Docs/changelog:** experimental adapter selection is documented accurately. The unqualified cross-PTY Relaycast claim is not accurate until the P1 is fixed.

## Executed evidence

- `npm run typecheck`: **passed**.
- Focused harness-driver/harness/SDK tests: **24 passed** in the selected Vitest projects.
- `cargo check --manifest-path crates/broker/Cargo.toml`: **passed**.
- `cargo test --manifest-path crates/broker/Cargo.toml emit_agent_event_records_canonical_payload`: **passed** (1 test; 791 broker tests filtered out).
- `npm ls` confirms the exact coherent AI SDK harness family from the plan.
- Node 20 baseline scan returned no supported-runtime references.
- `git diff --check`: **passed**.
- Earlier workflow evidence records a full unrestricted `npm test` pass and full broker suite pass; I did not rerun those complete suites after the latest live repairs. The latest queue/PTY changes therefore still require final full-suite reruns after blockers are fixed.

## Final verdict

**REJECT.** Do not treat Plan 001's cross-runtime Relaycast observability as signed off while Relay's primary CLI/fleet/direct PTY spawn paths bypass it. After moving the baseline to a broker-owned path, add the real broker-to-Relaycast regression and close or explicitly narrow the remaining delivery/cleanup guarantees, then request another fresh-context signoff.
