# Trajectory: Fix AI provider name casing in WorkspaceSettingsPanel

> **Status:** ✅ Completed
> **Task:** provider-credentials-fix
> **Confidence:** 90%
> **Started:** January 20, 2026 at 01:35 PM
> **Completed:** January 20, 2026 at 01:35 PM

---

## Summary

Fixed name casing in AI_PROVIDERS (Anthropic->anthropic, OpenAI->openai, etc.) to match backend validation. Added opencode and factory to valid providers list.

**Approach:** Standard approach

---

## Key Decisions

### Use lowercase provider names in AI_PROVIDERS
- **Chose:** Use lowercase provider names in AI_PROVIDERS
- **Reasoning:** Backend /api/onboarding/mark-connected validates against lowercase provider names. Onboarding PROVIDER_CONFIGS already uses lowercase, so aligning settings panel to match.

### Add opencode and factory to valid providers
- **Chose:** Add opencode and factory to valid providers
- **Reasoning:** New providers added to frontend AI_PROVIDERS list need corresponding backend validation entries

---

## Chapters

### 1. Work
*Agent: default*

- Use lowercase provider names in AI_PROVIDERS: Use lowercase provider names in AI_PROVIDERS
- Add opencode and factory to valid providers: Add opencode and factory to valid providers
