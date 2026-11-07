# Plan 001 self-reflection

## Scope and intent

This change implements Plan 001 as an experimental-first adoption of the official AI SDK harness adapters. It moves Relay to Node 22, adds the shared adapter registry and local-host runtime, introduces runtime-neutral activity and semantic event contracts, supervises semantic sidecars in the broker, adds semantic attach and input handling, and retains PTY as the automatic path until each adapter has authoritative cross-platform promotion evidence.

The principal design boundary is unchanged: Relay remains the durable coordination and delivery authority. The AI SDK host owns adapter lifecycle and active prompt control, while `DeliveryRunner` continues to own acknowledgement, retry, and dead-letter transitions.

## Acceptance review

- Node 22 is declared across packages and CI, with an early CLI guard.
- The six AI SDK packages are pinned to the exact coherent family specified by the plan.
- Claude Code, Codex, OpenCode, Pi, and Deep Agents are registered with capability and rollout metadata.
- `AgentActivity`, semantic event families, source/fidelity metadata, capability discovery, and the precedence reducer are public SDK contracts.
- The local-host provider restricts file access to the explicit workspace and runtime root, leases loopback ports, tracks owned children, and documents that it is lifecycle ownership rather than OS isolation.
- The AI SDK host retains prompt control, maps the public stream vocabulary, serializes lifecycle operations, and guards against stale turn completion.
- The relay session preserves FIFO, idempotency, queue bounds, and truthful accepted/deferred receipts.
- The broker protocol, replay buffer, authenticated semantic APIs, worker supervision, and CLI semantic view/drive path are implemented.
- All adapters remain experimental because local deterministic soaks cannot establish the plan's required macOS-and-Linux real-provider promotion evidence. Shared harnesses therefore remain PTY under `auto`; Pi and Deep Agents require explicit `backend: 'ai-sdk'`.
- Documentation and the major changelog describe backend selection, observability fidelity, semantic attach, local-host security, and Node 22 migration.

## Validation completed before adversarial review

- `npm run typecheck`: passed.
- Focused Vitest and SDK suites: 780 passed, 14 skipped; SDK 160 passed.
- `npm test`: 1,299 passed, 14 skipped.
- `cargo test --manifest-path crates/broker/Cargo.toml`: 786 unit tests passed plus all integration suites; 4 ignored.
- `npm run lint`: exit 0 with the repository warning baseline only.
- `npm run audit:deps`: passed.
- `git diff --check`: passed.
- Deterministic fake-adapter contracts: 46 contracts passed, including 100 isolated cycles per adapter with zero duplicates and zero orphaned owned processes.
- Live adapter cases report five named skips unless explicitly enabled. Attempting to enable them was denied because authenticated third-party CLIs could transmit workspace content; no workaround was attempted.

## Known risks for reviewers to attack

1. Semantic sidecar launch metadata and path resolution must work from the built package, not only source tests.
2. Broker replay subscribe/history reconciliation must not introduce gaps or duplicate semantic events.
3. Active and queued input must never acknowledge more than adapter acceptance, and duplicate ids must not inject twice.
4. Local-host command execution, path containment, loopback leasing, abort propagation, and process-group cleanup need adversarial scrutiny, especially on Windows.
5. Public SDK typing must preserve existing consumers while giving Relaycast enough activity, fidelity, and capability data.
6. Experimental rollout state and documentation must not imply that deterministic fake soaks satisfy real cross-platform promotion.
7. PTY behavior and attach routing must remain unchanged when runtime metadata is absent or explicitly PTY.
8. New package-lock transitive dependencies and runtime exports must package correctly.

## Repository-rule review

- Work is on `codex/ai-sdk-harness-adoption`, never `main`.
- `[Unreleased - Major]` is monotonic and contains impact-first entries plus migration guidance.
- The plan and current trajectory are intended to be committed; unrelated `.agents/personas/` remains untouched.
- No UI surface was changed. The anti-slop design law therefore has no visual component to validate, but the final pre-PR review will still confirm that no interface assets or behavior were accidentally modified.
