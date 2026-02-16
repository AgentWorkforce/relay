# Broker Migration: Wave-Based Execution Plan

## Architecture: Short-Lived Agents with High Context

Each wave follows the same pattern:
- **Claude Lead** — plans, reviews, coordinates. Gets full context via handoff message.
- **Codex Workers** — implement focused tasks in `--full-auto` mode. Short-lived (one task each).
- **Codex Reviewer** — dedicated reviewer at every phase. Reviews diffs, runs tests, blocks merge.
- **Human orchestrator** — the execution script. Manages lifecycle, gates, handoffs.

### Why short-lived agents?
- Context compaction is zero — agents are released before context window fills
- Each agent gets exactly the context it needs via the relay message (handoff)
- The channel (#wave-N) accumulates full context — new agents read the history
- No stale context, no hallucinated state, no drift

### Handoff Protocol
When a wave completes, the Lead posts a structured handoff message to the channel:
```
HANDOFF:
- Completed: [list of completed items]
- Files changed: [list of files]
- Key decisions: [architectural decisions made]
- Open issues: [anything the next wave needs to know]
- Test status: [pass/fail summary]
```
The next wave's Lead receives this as its initial context.

---

## Staffing Plan

### Per-Wave Team (spawned fresh each wave)

| Role | CLI | Args | Purpose |
|------|-----|------|---------|
| Lead | claude | — | Architecture, planning, code review, handoff |
| Worker-1..N | codex | --full-auto | Implementation (one per focused task) |
| Reviewer | codex | --full-auto | Review diffs, run tests, post verdict |

Workers are spawned sequentially within a wave (not all at once) to avoid
conflicts on the same files. Each worker gets a focused, non-overlapping task.

### Total Agent Budget (estimated)

| Wave | Lead | Workers | Reviewer | Total |
|------|------|---------|----------|-------|
| 0: Quick fixes | 1 | 3 | 1 | 5 |
| 1: Test harness | 1 | 2 | 1 | 4 |
| 2: Verified delivery | 1 | 2 | 1 | 4 |
| 3: Local send_message | 1 | 2 | 1 | 4 |
| 4: Activity + throttle | 1 | 2 | 1 | 4 |
| 5: Delivery receipts | 1 | 1 | 1 | 3 |
| 6: Crash recovery | 1 | 2 | 1 | 4 |
| 7: Benchmarks | 1 | 2 | 1 | 4 |
| 8: Parity tests | 1 | 2 | 1 | 4 |
| **Total** | **9** | **18** | **9** | **36 agents** |

All agents are short-lived: spawn, do work, release. Max concurrent: 3 (lead + worker + reviewer).

---

## Wave Definitions

### Wave 0: Quick Fixes (foundation)
**Beads**: agent-relay-559, agent-relay-562, agent-relay-560
**Gate**: cargo test + existing integration tests pass

| Agent | Task |
|-------|------|
| Lead | Review codebase, plan the three fixes, assign to workers |
| Worker-1 | Atomic state persistence: BrokerState::save() with tmp+rename (agent-relay-562) |
| Worker-2 | Add flock guard to .agent-relay/ directory (agent-relay-559) |
| Worker-3 | Extract run_init, run_wrap, run_pty_worker into separate modules (agent-relay-560) |
| Reviewer | Review all diffs, run cargo test, verify no regressions |

### Wave 1: Test Harness (TDD foundation)
**Beads**: agent-relay-555
**Gate**: test harness compiles and runs (tests fail — that's expected)

| Agent | Task |
|-------|------|
| Lead | Design test harness structure, assign file creation to workers |
| Worker-1 | Create tests/integration/broker/utils/ (harness, helpers, assertions) |
| Worker-2 | Create Phase 1 tests: 01-broker-lifecycle, 02-spawn-release, 03-local-send-message, 04-send-with-relaycast, 05-dedup-no-double |
| Reviewer | Review tests for correctness, ensure they exercise the right code paths |

### Wave 2: Verified PTY Delivery (Layer 1)
**Beads**: agent-relay-549
**Gate**: Phase 1 tests 01-02 pass, Phase 2 test 06 (delivery-verified) passes

| Agent | Task |
|-------|------|
| Lead | Design the verification protocol in Rust, assign implementation |
| Worker-1 | Implement output echo verification in wrap-mode worker (monitor PTY output after write, report delivery_verified) |
| Worker-2 | Write Phase 2 tests: 06-delivery-verified, 07-delivery-retry, 08-delivery-timeout |
| Reviewer | Review Rust code, run cargo test + integration tests, verify delivery events flow to SDK |

### Wave 3: Local send_message + Async Relaycast (core feature)
**Beads**: agent-relay-550
**Gate**: Phase 1 tests 03-05 pass (local send, Relaycast publish, dedup)

| Agent | Task |
|-------|------|
| Lead | Design the send_message handler, dual-path (local + Relaycast), dedup seeding |
| Worker-1 | Implement send_message handler in main.rs: local delivery via deliver_relay + async Relaycast publish via tokio::spawn |
| Worker-2 | Update SDK relay.ts: route sendMessage() through client.sendMessage() (stdio) instead of RelaycastApi directly |
| Reviewer | Review both Rust + TS changes, run full test suite, verify dedup prevents double delivery |

### Wave 4: Activity Confirmation + Adaptive Throttling (Layers 2-3)
**Beads**: agent-relay-552, agent-relay-553
**Gate**: Phase 2 tests 09-10 pass (activity-confirmed, adaptive-throttle)

| Agent | Task |
|-------|------|
| Lead | Design activity detection patterns (per-CLI), throttling algorithm |
| Worker-1 | Implement activity confirmation: after delivery_verified, watch for CLI activity patterns. Report delivery_active event. |
| Worker-2 | Implement adaptive throttling: per-worker success/failure tracking, exponential backoff on injection delay, write tests 09-10 |
| Reviewer | Review detection patterns, verify throttle math, run tests |

### Wave 5: Delivery Receipts (Layer 7)
**Beads**: agent-relay-554
**Gate**: SDK exposes delivery lifecycle events, integration test verifies full chain

| Agent | Task |
|-------|------|
| Lead | Design receipt protocol (queued → injected → verified → active), SDK event API |
| Worker-1 | Implement receipt events in Rust broker + SDK event exposure. Write integration test for full delivery lifecycle. |
| Reviewer | Review protocol, verify events propagate correctly through stdio → SDK → consumer |

### Wave 6: Crash Recovery (resilience)
**Beads**: agent-relay-551
**Gate**: Phase 3 tests 13-14 pass (broker-crash-recover, pending-persist)

| Agent | Task |
|-------|------|
| Lead | Design PID tracking, process group management, reattach logic |
| Worker-1 | Implement PID persistence in BrokerState, setsid for child processes, reattach-on-startup |
| Worker-2 | Implement delivery persistence: save pending deliveries to disk, reload on restart. Write Phase 3 tests 13-14. |
| Reviewer | Review crash recovery logic, run kill-and-restart test scenario, verify zero orphaned processes |

### Wave 7: Benchmarks
**Beads**: agent-relay-556
**Gate**: All 6 benchmarks run and produce comparison table

| Agent | Task |
|-------|------|
| Lead | Design benchmark harness, define metrics, assign individual benchmarks |
| Worker-1 | Create tests/benchmarks/ harness + implement latency, throughput, cold-start benchmarks |
| Worker-2 | Implement reliability, overhead, scale-out benchmarks |
| Reviewer | Run full benchmark suite, verify numbers are reasonable, review harness correctness |

### Wave 8: Parity Tests (migration validation)
**Gate**: All old SDK test equivalents pass via broker-sdk

| Agent | Task |
|-------|------|
| Lead | Map old tests to broker-sdk equivalents, assign porting |
| Worker-1 | Port sdk/05b2-orch-to-worker, sdk/06-multi-worker, sdk/07-broadcast |
| Worker-2 | Port sdk/15-continuity-handoff + write 20-stability-soak (5-minute soak test) |
| Reviewer | Run full parity suite, compare results against old test baselines |

---

## Quality Gates

Between every wave, the script runs:
1. `cargo test` — all Rust unit tests
2. `npx tsx tests/integration/broker/run-phase.ts --phase=N` — integration tests for completed phases
3. If any test fails → wave is retried with failure context in handoff
4. Max 2 retries per wave before halting for human intervention
