# Trajectory: Expose cloud workflow scheduling through Relay SDK

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 9, 2026 at 09:43 PM
> **Completed:** May 9, 2026 at 09:44 PM

---

## Summary

Re-exported Cloud workflow schedule helpers from @agent-relay/sdk/workflows and verified SDK build plus cloud CLI schedule tests.

**Approach:** Standard approach

---

## Key Decisions

### Expose workflow schedule helpers from @agent-relay/sdk/workflows

- **Chose:** Expose workflow schedule helpers from @agent-relay/sdk/workflows
- **Reasoning:** Ricky and similar products should consume scheduling from Relay SDK instead of duplicating Cloud endpoint calls. The SDK re-exports the existing @agent-relay/cloud scheduling implementation.

---

## Chapters

### 1. Work

_Agent: default_

- Expose workflow schedule helpers from @agent-relay/sdk/workflows: Expose workflow schedule helpers from @agent-relay/sdk/workflows
