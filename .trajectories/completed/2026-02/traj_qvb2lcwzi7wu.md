# Trajectory: Implement unified project identity broker routing + human registration

> **Status:** ✅ Completed
> **Confidence:** 83%
> **Started:** February 24, 2026 at 12:44 AM
> **Completed:** February 24, 2026 at 01:07 AM

---

## Summary

Completed broker identity follow-ups: self-name dashboard detection, sender normalization for UI, and SDK brokerName project-basename default.

**Approach:** Standard approach

---

## Key Decisions

### Broker registers as human using project directory basename; self-echo bypass only when event targets local workers/channels
- **Chose:** Broker registers as human using project directory basename; self-echo bypass only when event targets local workers/channels
- **Reasoning:** Unifies Dashboard and broker Relaycast identity while preserving echo suppression for true broker-originated traffic

### Normalized self-identity display without weakening self-echo detection
- **Chose:** Normalized self-identity display without weakening self-echo detection
- **Reasoning:** Kept routing checks on canonical sender while mapping UI sender to Dashboard to preserve behavior

---

## Chapters

### 1. Work
*Agent: default*

- Broker registers as human using project directory basename; self-echo bypass only when event targets local workers/channels: Broker registers as human using project directory basename; self-echo bypass only when event targets local workers/channels
- Normalized self-identity display without weakening self-echo detection: Normalized self-identity display without weakening self-echo detection
