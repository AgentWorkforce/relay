# Trajectory: Review GPT-5.5 hardening

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 15, 2026 at 12:54 PM
> **Completed:** May 15, 2026 at 12:54 PM

---

## Summary

Reviewed GPT-5.5 hardening and narrowed OpenCode to list GPT-5.5 without making it the default. Regenerated model constants and rebuilt config.

**Approach:** Standard approach

---

## Key Decisions

### Keep OpenCode default on known-stable model

- **Chose:** Keep OpenCode default on known-stable model
- **Reasoning:** GPT-5.5 should be listed for OpenCode/OpenAI consumers, but compatibility hardening is Codex-specific; leaving OpenCode default on openai/gpt-5.2 avoids introducing an unrelated unsupported-model regression.

---

## Chapters

### 1. Work

_Agent: default_

- Keep OpenCode default on known-stable model: Keep OpenCode default on known-stable model
