# Trajectory: Harden agent relay protocol - gap analysis and proposal

> **Status:** ✅ Completed
> **Task:** protocol-hardening
> **Confidence:** 90%
> **Started:** January 23, 2026 at 09:40 AM
> **Completed:** January 23, 2026 at 09:41 AM

---

## Summary

Protocol hardening proposal complete with 9 gap analysis, 3-phase migration path, new headers design, rich error taxonomy, and success metrics (99.9% delivery, <50ms p50 latency). Delivered: docs/PROTOCOL_HARDENING.md

**Approach:** Standard approach

---

## Key Decisions

### Identified 9 critical gaps in relay protocol
- **Chose:** Identified 9 critical gaps in relay protocol
- **Reasoning:** File-based Unix socket protocol elegant for dev but lacks production-grade reliability features: message atomicity, rich error handling, ordering guarantees, backpressure modeling, version negotiation

### Proposed 3-phase backward-compatible migration path
- **Chose:** Proposed 3-phase backward-compatible migration path
- **Reasoning:** Phase 1 (v1.1): Optional headers + error codes. Phase 2 (v1.2): Backpressure + sync. Phase 3 (v2.0): Strict modes. Preserves Unix philosophy while hardening for production.

### Proposed new headers: ID, SEQ, CHECKSUM, REPLY-TO, PRIORITY, TTL, VERSION
- **Chose:** Proposed new headers: ID, SEQ, CHECKSUM, REPLY-TO, PRIORITY, TTL, VERSION
- **Reasoning:** All optional for v1 backward compatibility. Enables message tracking (IDs), ordering (sequence), integrity (checksums), and correlation (reply-to). Checksum algorithm: SHA-256 (safe over CRC32 overhead). Message ID format: ULID prefix msg_ (sortable, human-readable).

### Proposed 20+ rich error codes with categories and retry guidance
- **Chose:** Proposed 20+ rich error codes with categories and retry guidance
- **Reasoning:** Current protocol has only 5 codes. New taxonomy: validation (4), routing (4), delivery (5), system (3), protocol (2). Each error includes category, retryable flag, and retry-after delay. Enables intelligent client-side retry logic.

---

## Chapters

### 1. Work
*Agent: default*

- Identified 9 critical gaps in relay protocol: Identified 9 critical gaps in relay protocol
- Proposed 3-phase backward-compatible migration path: Proposed 3-phase backward-compatible migration path
- Proposed new headers: ID, SEQ, CHECKSUM, REPLY-TO, PRIORITY, TTL, VERSION: Proposed new headers: ID, SEQ, CHECKSUM, REPLY-TO, PRIORITY, TTL, VERSION
- Proposed 20+ rich error codes with categories and retry guidance: Proposed 20+ rich error codes with categories and retry guidance
