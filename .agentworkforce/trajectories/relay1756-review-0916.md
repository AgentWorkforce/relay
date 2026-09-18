# Relay1756 review corrections

Worktree starts at a2f09f4ede9c8b7b746df127785f11cf20df2a04 and preserves PR history.

Reject exhausted admission collisions and require intended startup failures; use an owned real exit fixture. Export the actual emitter for tests and retain timestamp-before-mutation ordering. Support GitHub explicit nullable review association without accepting missing or lossy identity. Require exact canonical external records. Bound Nango response diagnostics and identify every settled failed operation without raw provider content.

Hermetic proof regressions run locally. Isolated Engine/broker rehearsal and real provider acceptance are separate evidence classes. No provider action, push, merge or deploy in this worker stage.

The installed trail command refused a new trajectory because the inherited branch already contains active traj_jdx9303jp3ky; that historical trajectory was left unchanged.

Followup: isolate local node/state and explicit CLI broker connection; preflight a real owned exit-one executable; bank actual broker close and returned worker PIDs, bound cleanup wait and retain failed workdirs. Remove unused emitter imports. Hermetic suite: 96/96 pass, no skips. Matching released Relay 12.2.2 + Engine 8.10.1 local rehearsal remains failed: HTTP-created provider-default worker conflicts with broker-provider inventory, causing reconnect before guarded cleanup ACK. The proof retains this runtime blocker; no assertion relaxation or full E2E claim.

2026-09-17 finish-up (worktree /tmp/relay-1756-e2e, head d8148719d): reran the
isolated rehearsal against the #1759 broker built from source at d4d51f62
(binary sha256 1bee6e9a…, toolchain build — the recorded b05947a4 hash is the
CI-built artifact) plus relaycast engine 8.11.0 and found two real defects the
proof had been papering over in some environments:

1. PTY recipients exit-code race: `agent_exit` (PTY close, no code) always
   precedes the reaper's `agent_exited` (500ms tick, code-bearing) on the
   subscription `--spawn` path, so `waitForReady` could settle with a
   detail-free exit and the CLI error lost the status. Post-release polling
   cannot recover it — the reaper may never emit `agent_exited` once the
   identity is released. Fixed in `launchSubscriptionRecipient`: bounded 3s
   grace for `agent_exited` while the worker is still registered, so the
   reported exit keeps the authoritative status. Unit regression added.
2. ANSI-styled broker diagnostics: worker logs carry ANSI styling around
   tracing field names (`control=[..]` is written `control<esc>[0m<esc>[2m=`),
   so `standaloneControlsAfter` threw "Unrecognized" on every control-write
   line. Parser now strips ANSI before matching; regression added.

PTY exit status is structurally unobservable today (the wrapper owns the
child; `agent_exited` reports `code: null`), so the early-exit case
now validates the reported shape — any reported status must be the fixture's
own code — and requires a marker file proving the owned exit-one fixture
executed. The fleet `verify_ready` path still certifies "exit status: 1".

Results at d8148719d: hermetic suite 99/99 on Node 26 (98 prior + 1 new ANSI
regression); `local-startup.mjs` 17 checks pass (1 collision retry recorded
only as observation; broker close 0; all PIDs absent); `local-ai.mjs` full
real-Claude run — 15/15 checks: prejoin-stale negative, two successive idle
digest actions, 612s uninterrupted idle, 10 unique burst digests, zero
post-idle control writes, same actor/PID across an actual node WebSocket
reconnect; Claude 2.1.270, tool calls audited. Synthetic signed ingress only —
still no real-GitHub or chief gate claimed. selfhost-live remains blocked here:
no cloudflared binary, no cloud env/workspace credentials on this host.

2026-09-18 self-hosted live run (head 5c2e27219): `selfhost-live.mjs` PASSED —
20/20 checks, run `ghsub-selfhost-e6a8fedbd7`, evidence
`/tmp/ghsub-live-evidence/report.json`. Real signed GitHub hooks on disposable
PR fixtures (cloud#3808, relay#1790, software-garden#528) delivered through a
cloudflared tunnel into candidate Cloud ingestion (eb27afa4), admitted by
hosted production Relayfile, delivered through local Relaycast engine
(683e4dcb) + #1759 broker (d4d51f62, sha 1bee6e9a…), and acknowledged by a real
Codex worker — exact `printf | shasum -a 256` digest ACKs, no polling. Checks:
management-API-blocked preflight, real redelivery → 409 duplicate_envelope,
3 successive idle actions, 600.6s no-input idle with zero control writes,
10 unique burst digests, WS reconnect with same actor/PID, nonmember zero
deliveries, no stale prejoin action. 38 admissions observed (10×202, 4×409,
23×429 retried, 1×500 retried). Environment fixes this round: cloudflared
binary discovery + required-tool preflight (commits 472a9c3bb, 5c2e27219), a
`shasum` shim for the pinned digest command, and the live
RELAYFILE_INTERNAL_HMAC_SECRET recovered from SST state into a 600-mode temp
file (never logged). Cleanup verified: hooks, fixtures, worker, and all 3
run-owned subscriptions removed (two needed manual retry after socket hang
up/429); remaining subscription inventory matches the pre-run set. Still not
proven: production deploys, the deployed Nango forward path, and gate-9
actual-chief acceptance.
