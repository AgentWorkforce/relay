# Trajectory: Harden broker startup Relaycast handshake with timeout + bounded retry

> **Status:** ✅ Completed
> **Confidence:** 80%
> **Started:** July 14, 2026 at 07:02 PM
> **Completed:** July 14, 2026 at 07:09 PM

---

## Summary

Diagnosed flaky publish smoke (broker 'code null' during handshake = hung timeout-less create_workspace reaped by smoke's down --force) and hardened connect_relay with per-attempt timeout + bounded retry/backoff. Pushed to claude/broker-startup-readiness-nvxn8n.

**Approach:** Standard approach

---

## Key Decisions

### Wrap broker startup Relaycast handshake in per-attempt timeout + bounded retry with backoff
- **Chose:** Wrap broker startup Relaycast handshake in per-attempt timeout + bounded retry with backoff
- **Reasoning:** Root cause of flaky publish smoke: relaycast v6.0.0 bootstrap calls (create_workspace/lookup_workspace) use a timeout-less reqwest client; a stalled prod call hangs connect_relay, and the smoke's sleep-8 down --force reaps the hung broker, surfacing as 'code null during initial handshake'. A per-attempt tokio timeout + retry recovers in-process within the SDK's 45s budget.

---

## Chapters

### 1. Work
*Agent: default*

- Wrap broker startup Relaycast handshake in per-attempt timeout + bounded retry with backoff: Wrap broker startup Relaycast handshake in per-attempt timeout + bounded retry with backoff

---

## Artifacts

**Commits:** ebb47e6
**Files changed:** 3
