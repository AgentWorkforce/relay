# Trajectory: Fix drive-mode delivery hold swallowing cross-node replies (Ctrl+] toggle + flush through interactive hold)

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** July 15, 2026 at 07:32 PM
> **Completed:** July 15, 2026 at 07:33 PM

---

## Summary

Drive mode no longer black-holes inbound relay messages: Ctrl+] toggles held/live delivery in-session (status line shows mode + pending + hint), the pending counter survives partial drains, and POST /flush sends a flush_injections frame so explicit flushes inject through the interactive hold. Covered by CLI vitest + broker unit tests; full broker suite green.

**Approach:** Standard approach

---

## Key Decisions

### Root-caused the two-computer 'reply never injected' report to drive-mode manual_flush, not cloud routing
- **Reasoning:** Three parallel investigations (relay broker, relaycast engine, relaycast-cloud) showed the reply was persisted and a delivery row created; the deterministic drop is local: drive attach flips the worker to manual_flush and #1249's interactive hold freezes injection pops, so a driven agent can never receive messages. Cross-node engine/cloud routing was ruled out for this repro (the kjg-lead->claude direction worked).

### Chose an explicit Ctrl+] mode toggle plus a hold-piercing flush frame over changing the drive default
- **Reasoning:** The manual_flush-during-drive hold is deliberate (anti-splice, merged 2 days prior in #1249). Ctrl+] gives an in-band, human-initiated release using existing mode-transition plumbing (drain + set_interactive_hold false), and a one-shot flush_injections worker frame makes 'agent message flush' actually inject through the hold instead of parking messages in a second frozen queue.

---

## Chapters

### 1. Work
*Agent: default*

- Root-caused the two-computer 'reply never injected' report to drive-mode manual_flush, not cloud routing
- Chose an explicit Ctrl+] mode toggle plus a hold-piercing flush frame over changing the drive default
