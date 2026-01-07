# Trajectory: Multi-Server Architecture Document Update

> **Status:** ✅ Completed
> **Task:** PR-8-update
> **Confidence:** 90%
> **Started:** January 7, 2026
> **Completed:** January 7, 2026

---

## Summary

Created comprehensive multi-server architecture document that supersedes PR #8's federation proposal with realistic current state analysis, detailed implementation roadmap, and agent-actionable specifications.

**Approach:** Pragmatic incremental approach building on existing cloud-mediated architecture

---

## Key Decisions

### Cloud as authoritative registry vs quorum consensus
- **Chose:** Cloud as authoritative source of truth for agent registry
- **Reasoning:** Simpler than Lamport timestamps/quorum, leverages existing PostgreSQL with atomic INSERT ON CONFLICT

### API keys + TLS vs Ed25519 per-message signing
- **Chose:** API keys + TLS for v1
- **Reasoning:** Simpler to implement, adequate security for initial deployment, can add per-message signing in v2

### Hybrid topology (Hub discovery + P2P messaging)
- **Chose:** Cloud hub for discovery, direct P2P for messaging
- **Reasoning:** Best of both worlds - hub provides registry sync, P2P provides low latency, hub failure doesn't break existing P2P connections

### Organization-centric model vs user-centric
- **Chose:** Add organizations layer while preserving user model
- **Reasoning:** Enables team billing ($49/user/month) while maintaining backwards compatibility

---

## Chapters

### 1. Current State Analysis
*Agent: default*

- Explored codebase to document what's actually built today
- Identified CloudSyncService, MultiProjectClient, project groups as existing cross-server capabilities
- Documented current limitations: cloud-mediated routing (~100-300ms), no P2P, user-centric billing

### 2. Gap Analysis
*Agent: default*

- Compared PR #8's proposals vs current implementation
- Identified P2P as main real gap (other proposals over-engineered)
- Listed 6 gaps with effort estimates totaling 9 weeks

### 3. PR #8 Insights Integration
*Agent: default*

- Reviewed FEDERATION_PROPOSAL.md and FEDERATION_PROPOSAL_REVIEW.md from PR #8
- Adopted critical insights: E2E delivery confirmation, message deduplication, backpressure
- Preserved protocol specification (PEER_HELLO, PEER_ROUTE, etc.)
- Adopted hybrid topology recommendation

### 4. Agent Implementation Guide
*Agent: default*

- Added Section 8 with directly actionable specifications
- Provided file paths to create/modify for each phase
- Included complete code examples (database migrations, service classes)
- Documented edge cases with resolution code
- Added acceptance criteria checklists
- Included testing strategy with example tests

---

## Files Changed

- `docs/MULTI_SERVER_ARCHITECTURE.md` (created, 1200+ lines)

---

## Edge Cases Handled

1. **User leaves org** → Workspaces suspended with 30-day grace period
2. **Org owner leaves** → Must promote admin first, auto-promote if available
3. **Org deleted** → Cascade: cancel Stripe, deregister agents, suspend workspaces, soft delete
4. **Agent name collision** → Return helpful error with suggested alternative name
5. **Daemon disconnects** → Mark all its agents offline
6. **P2P discovery fails** → Fall back to cached peer list, then cloud-only routing
7. **Both peers connect simultaneously** → Deterministic winner by daemon ID comparison
8. **Message in flight when connection drops** → Re-queue for P2P retry or cloud fallback

---

## What Worked

- Exploring codebase first gave realistic picture vs PR #8's theoretical proposals
- Cloud as source of truth eliminates distributed consensus complexity
- Incremental phases allow shipping value early (orgs before P2P)
- Specific file paths and code examples make doc directly actionable by agents

## What Could Be Improved

- Trail CLI should be available in the repo for trajectory recording
- Could add more detail on Phase 3 (Org Policies) and Phase 5 (Multi-Repo)
- Security audit needed before production P2P deployment
