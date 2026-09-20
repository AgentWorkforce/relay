# Trajectory: Add first-class Muse CLI support to Agent Relay

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** September 19, 2026 at 06:46 PM
> **Completed:** September 19, 2026 at 07:40 PM

---

## Summary

Added and independently validated first-class Muse CLI support in PR #1815, including secure workspace trust defaults, delayed composer submission, fleet/MCP/SDK registrations, live dogpatch proof, and Relayfile sync evidence.

**Approach:** Standard approach

---

## Key Decisions

### Transferred Muse's credential-free git bundle over numbered Relay DM chunks
- **Chose:** Transferred Muse's credential-free git bundle over numbered Relay DM chunks
- **Reasoning:** Dogpatch lacked GitHub credentials, Relay file attachments were broken, HTTP serving was sandbox-blocked, and the user explicitly wanted Relay/Relayfile exercised without SSH. The 9,620-byte reconstruction matched Muse's SHA-256 and passed git bundle verification.

### Kept Muse approvals enabled while defaulting workspace trust
- **Chose:** Kept Muse approvals enabled while defaulting workspace trust
- **Reasoning:** Muse needs --trust-workspace for project skills and rules, but --disable-approval is a separate security weakening and remains caller opt-in.

---

## Chapters

### 1. Work
*Agent: default*

- Transferred Muse's credential-free git bundle over numbered Relay DM chunks: Transferred Muse's credential-free git bundle over numbered Relay DM chunks
- Kept Muse approvals enabled while defaulting workspace trust: Kept Muse approvals enabled while defaulting workspace trust
- Muse support is implemented and PR #1815 is open after independent review. The live agent proved real Muse identity and Relay messaging; the review caught and fixed a PTY test readiness race and two stale broker guidance strings. Relayfile observed the PR in 22 seconds.
