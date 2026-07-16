# Plan 001 final adversarial signoff 3

## Verdict

**APPROVE - no blocking correctness, contract, or regression finding remains for the current experimental rollout.**

This approval is for the implementation represented by the current worktree and its intentionally experimental adapter states. It is not approval to mark Plan 001 fully `DONE` or promote an adapter to `default`; the plan correctly remains `IN PROGRESS` until real-provider and cross-platform promotion gates pass.

I re-read Plan 001, both prior final-signoff reviews, their resolution, and the current implementation/tests. I inspected every P1/P2 from signoff 2, including the repairs landed during this fresh review. I did not edit product source.

## Signoff-2 finding audit

### Cross-surface PTY observability - resolved

Hosted PTY publication is now broker-owned rather than confined to `definePtyHarness`:

- HTTP/direct/CLI spawn publishes the initial PTY state in `runtime/api.rs`.
- Fleet/Relaycast placement passes hosted publication and PTY state through `spawn_worker_from_request` and publishes the same starting profile.
- `worker_stream`, `agent_idle`, `worker_error`, signal exits, and nonzero exits drive one broker-owned PTY reducer in `worker_events.rs`/`maintenance.rs`.
- Restart readiness reinitializes state when the prior generation was reaped. HTTP, fleet release, and every reaped exit remove retained PTY state.
- The managed TypeScript wrapper now mirrors broker evidence only into its process-local listener hub, avoiding a second hosted publication.

The prior P1 is closed: CLI, fleet, thin/direct broker, and managed harness paths all reach Relaycast through the broker baseline.

The emitted PTY events carry canonical names, ordered per-agent observability sequences, exact/inferred fidelity, capabilities, previous activity, and optional fields without invalid `null` values. Repeated output while already thinking is deduplicated. Signal-only exits now produce the advertised exact error transition. Rust `worker_error` frames expose the top-level `code`/`message` required by the TypeScript `BrokerEvent` contract while retaining the nested diagnostic payload.

### Multi-workspace Relaycast routing - resolved

`HostedAgentEvent` carries its `WorkspaceId`. The publisher selects the matching workspace's `RelaycastHttpClient`; PTY state retains workspace identity, HTTP/fleet spawn initializes it, and semantic worker frames derive it from the worker handle. A two-server test proves a secondary-workspace event reaches only the secondary server and not the default. This closes the cross-workspace isolation defect found during this review.

### Hosted semantic mapping and diagnostic de-duplication - resolved

The broker validates semantic frames, maps canonical `event.kind` to the Relaycast agent-event type, removes `kind` from the payload, and preserves protocol sequence/timestamp enrichment. Transport `semantic_diagnostic` stays on the local attach stream, while the canonical `diagnostic` semantic event is the only hosted diagnostic.

The production mapping is extracted into `hosted_semantic_event`; its test now calls that helper directly and verifies diagnostic exclusion plus canonical kind removal and envelope fields. The Relaycast client HTTP test verifies the actual endpoint/type/payload, and the publisher test verifies workspace routing. These component boundaries are small and directly composed by `handle_worker_event`; I no longer consider the absence of a heavyweight full-runtime fixture blocking.

### Observer ordering and cleanup - resolved

Semantic terminal observation is registered before cursor/history work, closing the prior registration race. Broker `agent_exit`, `agent_exited`, and `worker_error` close the iterator and unregister the handler. The tracked disposer removes itself through `onClose`; `onClose` is in an inner `finally`, so a rejecting listener cannot skip cleanup. The crash regression now covers listener rejection, error reporting, iterator return, single unsubscribe, explicit disposer use, and release idempotency.

PTY broker observers buffer events before spawn returns, preserving `agent_spawned` and immediate output. Terminal events serialize after earlier listener work and remove the observer.

### Filesystem boundary - resolved by an honest contract

Plan 001 and the harness README explicitly define lexical/static-symlink checking as best-effort accidental-path protection, not an operating-system sandbox and not a TOCTOU-safe boundary under concurrent mutation. The implementation and static escape regressions match that narrowed claim. No public isolation guarantee remains to falsify.

### Hosted queue semantics - accepted, documented limitation

Hosted agent events use one bounded non-blocking queue and ordered publisher. HTTP latency cannot stall worker event ingestion. Queue overflow, closure, timeout, or Relaycast errors are warned and may lose high-frequency observability; there is no persisted retry outbox.

That is acceptable for this profile because Plan 001 explicitly separates high-frequency activity from durable session status and durable message delivery. Public harness documentation carefully describes inspection of events *accepted by Relaycast* rather than promising exactly-once observability delivery. This queue must not later be described as a durable delivery ledger without an outbox/idempotency design. The workflow resolution sentence saying remote publication happens "before" the local stream should be read as queue insertion, not confirmed remote persistence; the public docs/changelog do not make that stronger claim.

## Public claim audit

- `CHANGELOG.md` accurately states that canonical activity/semantic events are exposed across AI SDK and PTY runtimes now that PTY publication is broker-owned across spawn surfaces.
- Root and harness documentation clearly state that Claude Code, Codex, and OpenCode remain PTY-by-default while AI SDK adapters are experimental; Pi and Deep Agents are experimental AI SDK-only harnesses.
- No adapter is promoted without real CLI and 100-cycle macOS/Linux evidence. `plans/README.md` remains `IN PROGRESS`.
- Node 22 and exact coherent adapter-family claims match installed declarations.
- Capability/source/fidelity claims match the AI SDK reference mapper and the intentionally limited PTY baseline.
- Filesystem language no longer overclaims isolation.

## Executed evidence

- `cargo check --manifest-path crates/broker/Cargo.toml`: **passed** after all final repairs.
- Broker PTY/mapping focused tests: **2 passed**.
- Multi-workspace two-server Relaycast routing test: **passed outside the loopback-restricted sandbox**; default server received zero events.
- Focused broker-driver/harness observability tests: **25 passed**.
- SDK, harness-driver, harnesses, fleet, and CLI builds: **passed**. The first isolated CLI build attempt failed only because the fleet package had not been built in that command; rebuilding fleet first, as the monorepo typecheck does, made CLI pass.
- `cargo fmt --check`: **passed**.
- `git diff --check`: **passed**.
- Exact AI SDK dependency-family and Node baseline checks passed in the preceding signoff run.
- Earlier workflow evidence records a complete unrestricted `npm test` pass and complete broker test pass before the final focused repairs. The root agent should still rerun the final full suites on the settled tree before commit/push, as required by the task's terminal gate.

## Residual non-blocking risks

- High-frequency hosted observability is intentionally best-effort under a Relaycast outage; loss is warned but not replayed from a persisted outbox.
- Real authenticated adapter tests were not authorized in this environment, so all adapters appropriately remain experimental.
- The latest broker paths are strongly covered at reducer/mapping/HTTP-routing seams rather than by one monolithic spawned-broker test. The boundaries are direct and the full broker suite remains the final regression gate.

## Final instruction check

No UI surface changed. The anti-slop design law was rechecked and has no visual implementation to assess. Repository workflow constraints remain satisfied: feature branch only, no direct main push/merge, monotonic `[Unreleased - Major]`, tracked trajectory policy preserved, and Plan 001 remains in progress pending promotion evidence.

**Final verdict: APPROVE the current PR implementation after the root agent completes the final settled-tree full-suite gate.**
