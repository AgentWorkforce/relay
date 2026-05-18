# Trajectory: Update Codex registry for GPT-5.5

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 15, 2026 at 12:27 PM
> **Completed:** May 15, 2026 at 12:33 PM

---

## Summary

Updated the shared model registry for GPT-5.5: Codex now defaults to gpt-5.5, OpenCode/OpenAI includes openai/gpt-5.5 as default, generated TS/Python constants were regenerated, pricing was refreshed, and focused model/cost tests pass.

**Approach:** Standard approach

---

## Key Decisions

### Promoted gpt-5.5 to the Codex registry default

- **Chose:** Promoted gpt-5.5 to the Codex registry default
- **Reasoning:** Official OpenAI model docs list gpt-5.5 as the flagship model for complex reasoning and coding, and the broker default already expects it.

### Added openai/gpt-5.5 to the shared OpenCode model registry

- **Chose:** Added openai/gpt-5.5 to the shared OpenCode model registry
- **Reasoning:** The shared registry is used beyond the Codex CLI section; adding the OpenAI-provider id keeps registry consumers aligned with GPT-5.5 availability while pricing already covers openai/gpt-5.5.

---

## Chapters

### 1. Work

_Agent: default_

- Promoted gpt-5.5 to the Codex registry default: Promoted gpt-5.5 to the Codex registry default
- Added openai/gpt-5.5 to the shared OpenCode model registry: Added openai/gpt-5.5 to the shared OpenCode model registry
