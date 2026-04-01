# Trajectory: Interactive terminal for provider auth setup

> **Status:** ✅ Completed
> **Task:** xterm-display
> **Confidence:** 90%
> **Started:** January 7, 2026 at 11:06 AM
> **Completed:** January 7, 2026 at 11:07 AM

---

## Summary

Implemented interactive terminal for provider auth: fixed auto-enter by guarding all injection paths in pty-wrapper.ts, added __setup__ agent prefix with dashboard filtering, deduplicated auth URL modal, added success UI with connect-another option, unified providers page with CLI/API key options, created mark-connected endpoint for terminal auth

**Approach:** Standard approach

---

## Key Decisions

### Used __setup__ prefix for temporary auth agents
- **Chose:** Used __setup__ prefix for temporary auth agents
- **Reasoning:** Internal naming convention prevents conflicts with user-created agents named 'setup-*'

### Added interactive mode guards to all auto-inject code paths
- **Chose:** Added interactive mode guards to all auto-inject code paths
- **Reasoning:** Multiple code paths in pty-wrapper.ts were injecting content with Enter - hooks, continuity, instructions, message queue - all needed guards for interactive mode

### Created /api/onboarding/mark-connected endpoint for terminal auth
- **Chose:** Created /api/onboarding/mark-connected endpoint for terminal auth
- **Reasoning:** Terminal-based CLI auth stores credentials locally, but cloud DB needs to track provider as connected for user dashboard state

### Used ref-based URL tracking for auth modal deduplication
- **Chose:** Used ref-based URL tracking for auth modal deduplication
- **Reasoning:** shownAuthUrlsRef Set tracks URLs already shown, authModalDismissed state prevents re-showing after user dismisses

### Fixed Docker build by copying only needed docs snippet files instead of entire docs folder
- **Chose:** Fixed Docker build by copying only needed docs snippet files instead of entire docs folder
- **Reasoning:** The .dockerignore was excluding docs/, but Dockerfile needed them. Selective copy is cleaner than changing .dockerignore broadly

### Unified providers page with CLI and API key options
- **Chose:** Unified providers page with CLI and API key options
- **Reasoning:** Providers page was inconsistent with onboarding - now shows both 'Connect via CLI' and 'Use API Key' buttons when workspace is available

### Changed intro bonus banner from purple to cyan brand color
- **Chose:** Changed intro bonus banner from purple to cyan brand color
- **Reasoning:** User requested brand consistency - cyan is the primary accent color

---

## Chapters

### 1. Work
*Agent: default*

- Used __setup__ prefix for temporary auth agents: Used __setup__ prefix for temporary auth agents
- Added interactive mode guards to all auto-inject code paths: Added interactive mode guards to all auto-inject code paths
- Created /api/onboarding/mark-connected endpoint for terminal auth: Created /api/onboarding/mark-connected endpoint for terminal auth
- Used ref-based URL tracking for auth modal deduplication: Used ref-based URL tracking for auth modal deduplication
- Fixed Docker build by copying only needed docs snippet files instead of entire docs folder: Fixed Docker build by copying only needed docs snippet files instead of entire docs folder
- Unified providers page with CLI and API key options: Unified providers page with CLI and API key options
- Changed intro bonus banner from purple to cyan brand color: Changed intro bonus banner from purple to cyan brand color
