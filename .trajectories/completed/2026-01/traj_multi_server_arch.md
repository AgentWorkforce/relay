# Trajectory: Multi-server architecture document

> **Status:** Completed
> **Task:** PR-8-update
> **Started:** January 7, 2026 at 06:00 AM
> **Completed:** January 7, 2026 at 06:30 AM
> **Confidence:** 0.9

---

## Summary

Created comprehensive multi-server architecture document that supersedes PR #8's federation proposal with realistic current state analysis, detailed implementation roadmap, and agent-actionable specifications.

---

## Key Decisions

### 1. Cloud as authoritative registry vs quorum consensus
- **Reasoning:** Simpler than Lamport timestamps/quorum, leverages existing PostgreSQL with atomic INSERT ON CONFLICT

### 2. API keys + TLS vs Ed25519 per-message signing
- **Reasoning:** Simpler to implement, adequate security for initial deployment, can add per-message signing in v2

### 3. Hybrid topology (Hub discovery + P2P messaging)
- **Reasoning:** Best of both worlds - hub provides registry sync, P2P provides low latency, hub failure doesn't break existing P2P connections

### 4. Organization-centric model vs user-centric
- **Reasoning:** Enables team billing ($49/user/month) while maintaining backwards compatibility

---

## Learnings

1. **PR #8 over-engineered some aspects** - Cloud-mediated routing works fine for current scale, P2P is the real gap

2. **Cloud as source of truth eliminates consensus complexity** - No need for Lamport timestamps when you have atomic DB operations

3. **E2E delivery confirmation via capture-pane** is critical - Peer ACKs alone don't confirm agent received message

4. **Bounded queues with drop policies** prevent OOM from slow peers

5. **Hybrid topology is the sweet spot** - Hub for discovery, P2P for messaging, cloud as fallback

---

## Chapters

### 1. Research
*Agent: default*

- Explored codebase to document what's actually built today
- Identified CloudSyncService, MultiProjectClient, project groups as existing cross-server capabilities
- Documented current limitations: cloud-mediated routing (~100-300ms), no P2P, user-centric billing

### 2. Gap Analysis
*Agent: default*

- Compared PR #8's proposals vs current implementation
- Identified P2P as main real gap (other proposals over-engineered)
- Listed 6 gaps with effort estimates totaling 9 weeks

### 3. PR #8 Integration
*Agent: default*

- Reviewed FEDERATION_PROPOSAL.md and FEDERATION_PROPOSAL_REVIEW.md from PR #8
- Adopted critical insights: E2E delivery confirmation, message deduplication, backpressure
- Preserved protocol specification (PEER_HELLO, PEER_ROUTE, etc.)

### 4. Agent Implementation Guide
*Agent: default*

- Added Section 8 with directly actionable specifications
- Provided file paths to create/modify for each phase
- Included complete code examples (database migrations, service classes)
- Documented edge cases with resolution code

---

## Edge Cases Handled

| Edge Case | Resolution |
|-----------|------------|
| User leaves org | Workspaces suspended with 30-day grace period |
| Org owner tries to leave | Must promote admin first, auto-promote if available |
| Org deleted | Cascade: cancel Stripe, deregister agents, suspend workspaces, soft delete |
| Agent name collision | Return helpful error with suggested alternative name |
| Daemon disconnects | Mark all its agents offline |
| Cloud unavailable during P2P discovery | Fall back to cached peer list, then cloud-only routing |
| Both peers connect simultaneously | Deterministic winner by daemon ID comparison |
| Message in flight when connection drops | Re-queue for P2P retry or cloud fallback |

---

## Files Changed

- `docs/MULTI_SERVER_ARCHITECTURE.md` - Created (1200+ lines)

---

*Trajectory completed 2026-01-07*
