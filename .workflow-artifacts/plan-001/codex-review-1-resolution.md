# Resolution of fresh-context Codex adversarial review 1

All three P1 findings and the P2 gap were repaired before the final signoff pass.

## Relaycast and `AgentRelay` listeners

Semantic runtime handles now expose a subscribe-first observer that captures the broker cursor, opens the live stream, fetches semantic history, deduplicates by per-agent sequence, and publishes the reconciled ordered stream. `spawnSemantic` maps each canonical envelope back to `AgentSessionEvent` and feeds `relay.emitSessionEvent`, so existing `relay.addListener('agent.activity.changed', ...)`, canonical semantic selectors, agent predicates, and capability listeners receive real broker events rather than test-only manual emissions. Runtime release and terminal semantic lifecycle events dispose the observer. Regression coverage proves history/live reconciliation and the broker-to-`AgentRelay` bridge.

## Port handoff collision

The OS reservation remains held until bridge spawn and closure is awaited before launch. Because the public adapter contract cannot inherit a listening descriptor, `HarnessHost.start()` now recognizes typed `EADDRINUSE`/address-in-use failures, destroys the failed owned sandbox/process set, reserves a port never previously used by that provider, and retries through a bounded loop (two retries by default). Non-bind failures and resume flows are never retried. A regression proves a first collision restarts on a distinct reservation and succeeds; the pre-handoff competing-bind test remains.

## Symlink containment

File and working-directory paths now validate both lexical containment and the canonical real path of the nearest existing ancestor against the canonical workspace/runtime root. Reads and writes open final components with `O_NOFOLLOW`; writes revalidate the created parent before opening. Regressions prove both reading and creating through a workspace symlink to an outside directory are rejected and no outside file is created. Documentation continues to state that this is a lifecycle/file-API boundary, not an OS sandbox.

## Command idempotency conflicts and bounds

The sidecar caches a SHA-256 digest of the canonical command fields with each acknowledgement. Identical replays receive the cached acknowledgement; a reused key with a different kind or payload receives a non-retryable `idempotency_conflict` and executes nothing. The cache is FIFO-bounded to 10,000 entries by default and configurable downward for tests. A regression proves conflict rejection and that an evicted key can execute again.

## Evidence before final signoff

- Full repository typecheck and all focused builds: passed.
- Second-round focused semantic suites: 44 passed.
- Formatting and `git diff --check`: passed.
- Prior full Rust suite: 787 passed, 4 ignored, plus all integration suites.
