# Plan 001 final fresh-context adversarial signoff

## Verdict

**REJECT - two P1 contract blockers and two P2 correctness/verification gaps remain.**

I read `AGENTS.md`, Plan 001, every existing Plan 001 workflow artifact, and the complete current implementation/diff. I did not edit source code. The previous review repairs are materially present: duplicate broker deliveries are re-acknowledged, replacement history is reset before launch, canonical sidecar sequencing exists, inaccessible lifecycle operations are no longer publicly advertised, bridge bind failures receive bounded retries, ordinary symlink escapes are rejected, and semantic command receipts are digest-checked and bounded. Those repairs do not close the remaining findings below.

## Findings

### P1 - Semantic events reach the local `AgentRelay` listener hub, but are still not published by Relaycast

The Codex resolution is only partially true.

- `packages/harnesses/src/define.ts:288-291` observes broker semantic events and calls `relay.emitSessionEvent(...)`.
- `packages/sdk/src/agent-relay.ts:400-402` routes that call only into the process-local listener hub.
- `crates/broker/src/runtime/worker_events.rs:301-338` validates semantic frames and sends them only to `sdk_out_tx`.
- The semantic branch never uses the captured `relaycast_http`; repository search finds no `semantic_event`, `activity.changed`, or `observability.capabilities` handling in `crates/broker/src/runtime/relaycast_events.rs`.

This is enough for listeners registered on the same `AgentRelay` instance that spawned the semantic runtime, and the history/live observer can replay real broker frames into that hub. It is not Relaycast publication. Remote Relaycast subscribers and another `AgentRelay` process do not receive these events. Therefore Plan 001's explicit criterion that "Relaycast publishes activity transitions, semantic session events, and observability capability discovery" is unmet, and `CHANGELOG.md:13` ("Relaycast exposes ... across AI SDK and PTY runtimes") plus `README.md:95` (metadata "through Relaycast") overstate the shipped behavior.

Required repair: publish the canonical envelopes through the authenticated Relaycast transport with stable public event names and wire round-trip tests, or change the plan/docs/changelog to describe the local broker/SDK observer plane accurately. The Plan 001 done criterion itself currently requires the former.

### P1 - PTY observability is a dead translator, so PTY runtimes emit none of the advertised canonical profile

- `packages/harnesses/src/observability.ts:118-207` defines `createPtyObservabilityTranslator`.
- The only call sites are unit/integration tests (`packages/harnesses/src/observability.test.ts` and `tests/integration/ai-sdk-harnesses/pty-reference-profile.test.ts`). A repository-wide production search finds no invocation.
- `packages/harnesses/src/define.ts:133,166` merely attaches a capability profile to PTY descriptors; `spawnLive` never translates broker start/busy/idle/failure evidence or calls `relay.emitSessionEvent`.

Consequently a real PTY spawn publishes neither canonical `session.starting`/`turn.started`/`turn.settled` events nor the advertised `activity.changed` transitions. This fails the done criterion that every PTY harness "emits available signals through the same contract" and falsifies `packages/harnesses/README.md:47-49` and the cross-runtime changelog claim.

Required repair: connect broker-owned PTY lifecycle and busy/idle evidence to one translator instance per running PTY agent, emit its events through the same public observer/Relaycast path, dispose it on release/exit, and add a real PTY runtime test rather than translator-only tests.

### P2 - Canonical symlink checks do not prevent intermediate-directory TOCTOU escapes

- `packages/harnesses/src/ai-sdk/local-host-sandbox.ts:148-169` resolves the nearest existing ancestor with `realpath` and then returns the original lexical path.
- Reads subsequently call `open(fullPath, O_NOFOLLOW)` at `:187-193`. `O_NOFOLLOW` protects only the final path component, not intermediate directories.
- Writes validate, run recursive `mkdir`, revalidate the parent, and then open the original full path at `:223-237` and `:246-262`. An intermediate directory can be exchanged for an outside-pointing symlink after the last `realpath` and before `open`.
- `local-host-sandbox.test.ts:116-129` covers a static symlink only; it does not exercise replacement during the validation/open window.

The documentation correctly says this is not an OS sandbox, which limits security expectations, but it also promises that adapter file operations are limited to the workspace/runtime cache. That containment promise is not race-safe, and the Codex resolution's TOCTOU implication is too strong.

Required repair: use descriptor-relative traversal (`openat`/equivalent with no-follow checks for each component), or explicitly narrow the documented contract to best-effort accidental-path containment and state that concurrent path mutation is outside the boundary. Do not claim TOCTOU-safe containment without a race regression.

### P2 - The listener repair lacks the required real broker-to-listener test and can retain observers after non-semantic crashes

- `packages/harness-driver/src/semantic-client.test.ts:76-122` supplies a mocked client and a synthetic async iterator. It does not start the Rust broker or ingest a sidecar `semantic_event` frame.
- `packages/harnesses/src/define-spawn.test.ts` likewise injects synthetic semantic envelopes through a fake runtime. The production listener is not manually emitted, but the broker boundary requested by the prior review is not exercised end to end.
- `packages/harness-driver/src/broker-driver.ts:106-121` stops the pump only for semantic `session.destroyed`, `session.released`, or `session.failed`. A worker crash that produces only broker `worker_error`/`agent_exited` cannot reach this filtered semantic iterator, and `spawnSemantic` discards the returned disposer (`packages/harnesses/src/define.ts:288-291`). That can leave the observer subscribed until the shared client closes.

Required repair: add a broker-backed test from a real worker semantic frame through replay/live reconciliation into `relay.addListener('agent.activity.changed', ...)`, and dispose observers on broker worker exit/error as well as semantic terminal events.

## Prior resolution reproduction

- **Duplicate delivery acknowledgement:** reproduced in source. Accepted cached receipts cause a fresh `delivery_ack`; deferred receipts remain pending (`sidecar.ts:209-250`).
- **History reset and sidecar sequencing:** reproduced in source. Replacement history reset moved before launch; sidecar writes one monotonic semantic stream. The observer's history/live high-water deduplication is coherent for normal retained history (`broker-driver.ts:92-131`).
- **Public lifecycle accuracy:** reproduced. Runtime metadata exposes active input, approvals, compact, and disables state-token lifecycle operations not carried by the protocol (`define.ts:222-233`).
- **Port reservation and bounded retry:** reproduced. The provider holds a loopback socket until handoff (`local-host-sandbox.ts:425-446`), excludes previously used ports, and `HarnessHost.start()` retries only non-resume address-in-use failures through the configured bound (`harness-host.ts:357-382`). The public adapter contract cannot provide atomic descriptor handoff, so the documented bounded retry is the truthful mitigation.
- **Digest-checked bounded idempotency:** reproduced. The digest covers every current command payload field, conflicts are non-retryable, and FIFO retention is bounded (`sidecar.ts:58-67,260-295,354-359`).
- **Symlink containment:** static escapes are repaired, but the broader TOCTOU implication is falsified as described above.
- **Broker events to local listeners:** the production call path exists, but the prior demanded real-broker regression is still absent, and it is not hosted Relaycast publication.

## Done-criterion audit

Node 22 declarations/guards, exact adapter family, registry entries, canonical SDK vocabulary/reducer, AI SDK stream mapping, local process ownership, retained prompt control, semantic sidecar protocol, replay/input endpoints, semantic attach, explicit PTY selection, experimental rollout honesty, Deep Agents capability reduction, changelog level, and package inclusion/build compatibility are present. No adapter is promoted to `default`, so the default-adapter soak criterion is presently vacuous and the plan correctly remains `IN PROGRESS` in `plans/README.md`.

The following done criteria remain false: Relaycast publication; PTY canonical emission; race-safe filesystem containment as currently claimed; complete broker-to-public-listener verification; and full acceptance-suite completion. Real-provider tests and required macOS/Linux promotion evidence also remain unavailable, appropriately preventing promotion.

## Executed evidence

- Non-loopback focused suites: **5 files passed, 28 tests passed**.
- `npm run build:sdk`, `build:harness-driver`, `build:harnesses`, and `build:cli`: **passed**.
- `npm pack --dry-run` for SDK, harness-driver, and harnesses: **passed**; the harness package includes `dist/ai-sdk/sidecar.js` and its runtime modules.
- `git diff --check`: **passed**.
- The combined loopback-focused run failed with `listen EPERM` under the restricted sandbox (16 affected tests). This is infrastructure-only and is **not** treated as product evidence; prior unrestricted runs are recorded in the review artifacts.

## Final instruction check

No UI surface changed, so the anti-slop visual rules are not applicable. Repository workflow rules were respected: review-only source handling, no commit/push/merge, no change to trajectory tracking, and the plan remains on the feature branch.

**Final verdict: REJECT. Do not mark Plan 001 DONE or publish the current changelog claims until the P1/P2 findings above are repaired or the governing plan and public claims are explicitly narrowed.**
