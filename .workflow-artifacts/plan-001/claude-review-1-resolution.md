# Resolution of fresh-context adversarial review 1

Verdict addressed: all five P1 findings were reproduced from the code paths described in the review and repaired before the second review.

## Delivery redelivery acknowledgement

The sidecar now treats an accepted cached receipt as sufficient to re-acknowledge the current broker delivery frame. Deferred receipts remain pending. The sidecar regression sends the same `deliver_relay` twice, requires two `delivery_ack` frames, and proves the adapter receives the input once.

## Semantic replay generation race

`agent_spawned` is now observational and does not clear semantic history. A replacement spawn explicitly resets stale history after duplicate-name validation and immediately before child launch. Release and exit still clear history. The deterministic Rust regression seeds old history, resets the generation, emits startup events before `agent_spawned`, and proves those current events remain replayable.

## Canonical activity and capability publication

The sidecar now attaches to `RelayHarnessSession` before host startup and publishes only that canonical session stream. Capability discovery and reducer-derived activity transitions therefore reach the broker. Sidecar sequencing rewrites both envelope and observability sequence/timestamp through one serialized publisher, preventing raw/mapped duplication and preserving strict monotonic order.

## Public lifecycle accuracy

The versioned command protocol now exposes `compact` with correlated, idempotent acknowledgement and optional instructions. Release remains exposed. Adapter-internal suspend, continue, detach, stop, and destroy operations are intentionally not advertised in public semantic runtime metadata because Relay does not yet durably transport their state tokens. The registry still records the underlying adapter contract for direct host tests; runtime metadata records only broker-reachable operations. Unsupported command kinds are rejected.

## Local-host platform and port ownership

The provider now holds an actual loopback `Server` reservation until the adapter spawn identifies the leased port in its command or environment, then awaits closure before child launch. A regression proves an external competing bind receives `EADDRINUSE` before handoff and the bridge child can bind after handoff. The local-host AI SDK runtime now explicitly reports macOS/Linux support and fails with a typed PTY-fallback instruction on Windows, matching the plan's promotion platforms instead of attempting `/bin/sh` implicitly. Preflight includes a platform result and invokes `pnpm --version` directly.

## Post-repair evidence before review 2

- Full repository typecheck: passed.
- Repaired focused suite: 90 passed, 5 explicitly gated live-provider skips.
- All five deterministic 100-cycle fake-adapter soaks remain at 100%, with zero duplicate injections and zero cleanup failures.
- Local OS reservation/handoff suite: 8 passed.
- First broker repair run: 787 unit tests passed, 4 ignored, plus all integration suites.
- Formatting and `git diff --check`: passed.
