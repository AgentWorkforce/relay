# Trajectory: Add real-agent RelayFlow conformance for API send reachability

> **Status:** ✅ Completed
> **Task:** relay#1615
> **Confidence:** 93%
> **Started:** September 2, 2026 at 12:25 PM
> **Completed:** September 2, 2026 at 02:08 PM

---

## Summary

Added RelayFlow case 1615 with real broker and child-agent effects, and made /api/send report recipient reachability separately from durable Relaycast publication across Rust, TypeScript, and Swift clients.

**Approach:** Standard approach

---

## Key Decisions

### Treat Relaycast publication and recipient reachability as separate observations
- **Chose:** Treat Relaycast publication and recipient reachability as separate observations
- **Reasoning:** An accepted durable message is not confirmed PTY delivery; the API must preserve publication success while reporting live, offline, or unknown without a delivered boolean.

### Keep the reachability probe outside the publication timeout
- **Chose:** Keep the reachability probe outside the publication timeout
- **Reasoning:** A slow best-effort read must not turn an already-accepted DM into an HTTP send failure; the probe has its own five-second bound and the RelayFlow makes it slower than the configured publish deadline.

### Keep the synchronous reachability snapshot bounded at five seconds
- **Chose:** Keep the synchronous reachability snapshot bounded at five seconds
- **Reasoning:** Issue 1615 explicitly requires the send response to carry the server-observed recipient state. Waiting for the independently bounded GET is the cost of that contract; it cannot alter publication success and remains below the outer 30-second API reply bound.

### Applied independent review findings without weakening the effect oracle
- **Chose:** Applied independent review findings without weakening the effect oracle
- **Reasoning:** Preserved required TypeScript targets via runtime normalization, exposed the response in Swift, classified all live Relaycast activity states, made the timeout control exceed the real 500ms clamp, and added unavailable/non-recipient controls.

### Resolve Relaycast @self before reachability probing
- **Chose:** Resolve Relaycast @self before reachability probing
- **Reasoning:** @self names the authenticated sender, not an agent record. Probing publish_from preserves the successful self-DM semantics and reports the actual recipient; the RelayFlow now proves one self-injection.

### Treat legacy away as reachable
- **Chose:** Treat legacy away as reachable
- **Reasoning:** Relaycast SDK compatibility still exposes pre-active-status away records; a best-effort reachability snapshot must not downgrade those live-compatible records to unknown.

### Cancel reachability observation when publication fails
- **Chose:** Cancel reachability observation when publication fails
- **Reasoning:** The observation is only part of a successful publication response. Awaiting it after an immediate publish failure delays the error and blocks the broker runtime actor for no usable evidence; the RelayFlow now measures this negative path.

---

## Chapters

### 1. Work
*Agent: default*

- Treat Relaycast publication and recipient reachability as separate observations: Treat Relaycast publication and recipient reachability as separate observations
- Keep the reachability probe outside the publication timeout: Keep the reachability probe outside the publication timeout
- The first real conformance case now discriminates exact base/head effects and also guards timeout independence; full broker validation is green while independent review is in progress.
- Keep the synchronous reachability snapshot bounded at five seconds: Keep the synchronous reachability snapshot bounded at five seconds
- Claude review found stale downstream TypeScript annotations; updated all four consumers to SendMessageResult. Its claimed Rust build blocker was disproved by relaycast 7.0.0 source and the compiled 1040-test suite.
- Applied independent review findings without weakening the effect oracle: Applied independent review findings without weakening the effect oracle
- Claude and Codex fresh-eyes reviews are complete; all valid P1/P2 findings are implemented, with exact base/head reruns still required after rebase.
- Resolve Relaycast @self before reachability probing: Resolve Relaycast @self before reachability probing
- Treat legacy away as reachable: Treat legacy away as reachable
- Cancel reachability observation when publication fails: Cancel reachability observation when publication fails
- Final fresh Codex review found no actionable defects; exact-sha base/head effects discriminate and the final serialized broker suite is fully green.

---

## Artifacts

**Commits:** e85f4ca23, bf66a2e86, 13971aa8f, 1191af9bd, cefc1ab4d, 2559e668a
**Files changed:** 23
