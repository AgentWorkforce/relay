# Trajectory: Fix missing Relaycast->Dashboard message visibility in local dashboard

> **Status:** ✅ Completed
> **Confidence:** 87%
> **Started:** February 23, 2026 at 03:59 PM
> **Completed:** February 23, 2026 at 04:09 PM

---

## Summary

Fixed missing Relaycast agent->Dashboard visibility by routing dashboard-originated deliveries through broker identity and normalizing UI target/display back to Dashboard; added DM participant-based target resolution and tests; rebuilt release broker binary.

**Approach:** Standard approach

---

## Key Decisions

### Route dashboard-originated injections through broker Relaycast identity

- **Chose:** Route dashboard-originated injections through broker Relaycast identity
- **Reasoning:** Workers were instructed to reply to literal Dashboard, which broker WS cannot receive when broker identity is broker-\*; using broker identity for delivery and preserving Dashboard as display fixes inbound visibility.

---

## Chapters

### 1. Work

_Agent: default_

- Route dashboard-originated injections through broker Relaycast identity: Route dashboard-originated injections through broker Relaycast identity
