Targeted fleet spawns now request the broker's verified-readiness contract, so a healthy worker can complete confirmation instead of being rejected for missing `ready:true`. Unverified broker success explicitly returns `ready:false`; `--no-confirm` accepts that launch evidence while continuing to reject obsolete handlers that omit readiness entirely. Persona defaults and MCP readiness requirements remain unchanged.

The CLI rejects confirmed targeted-spawn timeouts below the broker's 90-second readiness window. Readiness timeout errors explain that the worker was released. Invocation-correlated spawn timing and dropped-result diagnostics help investigate the separate `spawn_unconfirmed` report. The changelog is raised to `[Unreleased - Minor]` as specified by the reviewed plan.

Validation:

- Full Vitest suite: 3,496 passed, 24 skipped (`env -u RELAY_BASE_URL npm --ignore-scripts test`, after building packages). Two ambient-URL failures disappeared with that environment override removed. The final additional completed-ack CLI regression passed in the 74-test fleet command suite.
- SDK placement suite: 47 passed, using a temporary Vitest configuration because the root configuration excludes SDK tests.
- Rust suite: 1,302 unit tests and 18 integration tests passed, 5 ignored (`env -u GIT_CONFIG_COUNT cargo test -p agent-relay-broker`). The environment's forced `core.hooksPath=/dev/null` caused four hook-test failures before its removal.
- `npm run typecheck` passed. `npm run lint` passed with 108 existing warnings.
- Real broker integration: `node --test dist/fleet-spawn-readiness.test.js` passed in approximately 1.1 seconds. A loopback engine forwards the SDK invocation to the real broker, which registers exactly one worker, launches a Claude stub in a real PTY, and returns `{spawned:true, ready:true}` through node control and requester polling.
- Mutate-to-red: removing `payload.verify_ready = true` from the built SDK made that same real-broker test fail with `spawn_failed`; restoring it passed. Removing `ready:false` from the Rust unverified result made `spawn_success_always_declares_readiness` fail; restoring it passed. The requester regression also failed against the original source before implementation.
- The broad `npm run test:integration:broker` run encountered continuity/event failures and stalled; it was stopped. The isolated readiness integration above passes. This is not a claim that the full broker integration suite passed.

Remaining validation and follow-up:

- Live two-node logged-in Claude, Codex, Gemini, Muse, and Devin checks were not run; the deterministic PTY proof does not establish real-harness login or prompt-detection behavior.
- The separate 120-second result silence remains open, per reviewed-plan.md. Investigate wire loss, slow spawn, and invocation-ID mismatch using the new logs. Action-result retention/replay is deferred until engine-side replay idempotency is established; no reconnect queue is included here.
