# Final signoff rejection resolution

## Hosted Relaycast transport

- Canonical semantic sidecar frames are enqueued independently for Relaycast's authenticated `POST /v1/agents/:name/events` SDK surface while remaining available on the local broker stream.
- `AgentRelay.publishSessionEvent` delivers a canonical event to local listeners and Relaycast durable agent-event storage. `messaging.sessionEvents.list` exposes the upstream read surface to other Relay applications.
- A loopback HTTP round-trip asserts the stable event type and canonical payload sent to Relaycast.
- Multi-workspace events carry their workspace id and select that workspace's Relaycast client; a two-server regression proves secondary-workspace events never fall through to the default key.
- Hosted publication is documented as bounded best-effort operational observability, not a lossless audit ledger. Successfully accepted events are durable in Relaycast; local warnings expose queue/timeout/transport gaps.

## PTY production observability

- Hosted PTY publication is broker-owned across HTTP/direct/CLI and fleet/Relaycast spawn surfaces. Worker output, idle, error, and non-zero exit evidence update one per-worker canonical state machine.
- Managed PTY runtimes now subscribe to broker-owned runtime events through `observeBrokerEvents`.
- BrokerDriver subscribes before PTY spawn and buffers the real `agent_spawned`/early-output events until the runtime observer attaches, so the exact startup boundary and immediate output are not synthesized or lost.
- One translator instance per PTY runtime maps that exact spawn boundary, inferred output/busy and idle boundaries, and exact runtime failure into the shared canonical event vocabulary.
- Broker publications are serialized to preserve lifecycle ordering. The managed wrapper mirrors evidence only to local listeners, avoiding hosted duplicates, and its observer automatically unsubscribes on process exit or runtime failure.
- The production BrokerDriver observer seam and live harness wiring are covered in addition to translator unit tests, including an event emitted before `spawnPty` returns.

## Observer lifecycle

- Semantic history/live observers register for terminal events before cursor/history requests and close their async iterator on `agent_exit`, `agent_exited`, or `worker_error`.
- Generic and semantic runtime observers remove their broker handler and tracked disposer at the same terminal boundary; a crash regression covers the semantic path.

## Filesystem boundary

- Documentation and Plan 001 now explicitly define path checks as best-effort protection against lexical and static symlink escapes.
- Concurrent filesystem mutation is stated to be outside the boundary; no TOCTOU-safe isolation claim remains.

## Verification

- TypeScript monorepo typecheck passes.
- Focused broker-driver, PTY harness, and observability tests pass (25/25).
- Broker-owned PTY reducer tests pass (2/2), including ordered activity/capability publication and diagnostic de-duplication.
- SDK messaging/listener tests pass (39/39).
- Relaycast HTTP event round-trip passes outside the loopback-restricted sandbox.
- Rust formatting and broker compilation pass.
