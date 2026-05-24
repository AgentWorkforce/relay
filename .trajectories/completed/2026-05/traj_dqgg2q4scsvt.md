# Trajectory: Assess PR 932 event listener need

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 21, 2026 at 09:05 PM
> **Completed:** May 21, 2026 at 09:07 PM

---

## Summary

Assessed PR 932 against recent listener changes. Recommendation: keep a global structured-result listener, but expose it as relay.addListener('agentResult', handler) in AgentRelayEvents, not relay.onAgentResult; PR needs rebase over PR 936 listener registry.

**Approach:** Standard approach

---

## Key Decisions

### Expose structured agent results through AgentRelay addListener registry
- **Chose:** Expose structured agent results through AgentRelay addListener registry
- **Reasoning:** PR 936 removed single on* callback fields and made AgentRelayEvents the typed multi-listener surface; PR 932 introduces a new broker event and global observer, so it should be agentResult in addListener rather than relay.onAgentResult.

---

## Chapters

### 1. Work
*Agent: default*

- Expose structured agent results through AgentRelay addListener registry: Expose structured agent results through AgentRelay addListener registry
