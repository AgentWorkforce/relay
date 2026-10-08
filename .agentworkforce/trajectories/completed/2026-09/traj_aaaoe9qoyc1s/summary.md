# Trajectory: Close the loop on webhook-subscription hardening: relay#1801 + relaycast#445 merged, publish + live airtight reconnect-replay proof

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** September 19, 2026 at 12:55 PM
> **Completed:** September 19, 2026 at 12:55 PM

---

## Summary

Both hardening PRs merged and shipped: relaycast 8.11.4 (reconnect replays queued+delivered-unacked deliveries after readiness/cursor certification; stale connections can't certify to replacements) deployed via relaycast-cloud#181; agent-relay 12.3.0 (machine-global node-claim guard prevents socket steal) publish dispatched. Live airtight proof on cast.agentrelay.com: proxy-killed node socket, GitHub issue_comment queued mid-outage, reconnect replayed it into live watcher worker, deliveries drained to zero. Cleaned test nodes/agents/subscriptions/worktrees on both machines.

**Approach:** Standard approach

---

## Key Decisions

### Proved reconnect replay live via a local Host-rewriting TLS proxy (python asyncio) on RELAY_BASE_URL — killing the proxy drops the node WS while broker+worker stay alive, reproducing the socket-death incident exactly without root
- **Chose:** Proved reconnect replay live via a local Host-rewriting TLS proxy (python asyncio) on RELAY_BASE_URL — killing the proxy drops the node WS while broker+worker stay alive, reproducing the socket-death incident exactly without root
- **Reasoning:** engine now rejects duplicate node connections, so the old imposter-steal repro no longer drops the socket; node down/up kills workers too; the proxy was the only socket-only kill available

---

## Chapters

### 1. Work
*Agent: default*

- Proved reconnect replay live via a local Host-rewriting TLS proxy (python asyncio) on RELAY_BASE_URL — killing the proxy drops the node WS while broker+worker stay alive, reproducing the socket-death incident exactly without root: Proved reconnect replay live via a local Host-rewriting TLS proxy (python asyncio) on RELAY_BASE_URL — killing the proxy drops the node WS while broker+worker stay alive, reproducing the socket-death incident exactly without root
- Airtight proof passed on deployed relaycast 8.11.4: socket killed -> event queued -> reconnect -> inventory.sync certified watcher -> backlogged issue_comment replayed into live PTY worker -> deliveries drained to 0
