# Trajectory: Harden Codex GPT-5.5 local CLI compatibility

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** May 15, 2026 at 12:35 PM
> **Completed:** May 15, 2026 at 12:40 PM

---

## Summary

Hardened Codex GPT-5.5 spawning by checking the local Codex debug model catalog before injecting --model gpt-5.5. Relay now passes GPT-5.5 through when the installed CLI catalog confirms support, falls back to gpt-5.4 when support is missing/unprobeable or the catalog marks an upgrade requirement, preserves explicit user --model args, and records the effective model in the worker spec. Added parser tests and verified cargo check/test plus focused TS tests.

**Approach:** Standard approach

---

## Key Decisions

### Use Codex debug model catalog instead of version guessing

- **Chose:** Use Codex debug model catalog instead of version guessing
- **Reasoning:** The local Codex CLI exposes a debug model catalog, so relay can verify whether gpt-5.5 is supported by the installed binary and fall back only when support is absent or unprobeable.

### Treat catalog upgrade markers as unsupported models

- **Chose:** Treat catalog upgrade markers as unsupported models
- **Reasoning:** A Codex catalog can expose a model slug while marking it as requiring an upgrade; relay should only pass gpt-5.5 through when the local catalog says the entry is usable.

---

## Chapters

### 1. Work

_Agent: default_

- Use Codex debug model catalog instead of version guessing: Use Codex debug model catalog instead of version guessing
- Treat catalog upgrade markers as unsupported models: Treat catalog upgrade markers as unsupported models
