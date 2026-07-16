# Trajectory: Correct AI SDK adoption plan to include model-provider expansion

> **Status:** ✅ Completed
> **Confidence:** 94%
> **Started:** July 15, 2026 at 07:22 PM
> **Completed:** July 15, 2026 at 07:42 PM

---

## Summary

Corrected the AI SDK roadmap by distinguishing five external HarnessV1 adapters from dozens of model providers and added a self-contained relay-native provider plan.

**Approach:** Standard approach

---

## Key Decisions

### Separate external harness adapters from model-provider support
- **Chose:** Separate external harness adapters from model-provider support
- **Reasoning:** AI SDK provider packages such as @ai-sdk/xai standardize model inference but do not launch coding CLIs. Relay should retain Plan 001 for HarnessV1/PTy runtimes and add a dependent relay-native ToolLoopAgent harness that can use the broader provider registry with Relay-owned tools and semantic attach.

---

## Chapters

### 1. Work
*Agent: default*

- Separate external harness adapters from model-provider support: Separate external harness adapters from model-provider support
