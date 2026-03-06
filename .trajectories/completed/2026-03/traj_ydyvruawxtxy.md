# Trajectory: Migrate openclaw-web to Next.js with static root and SSR invite page

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** March 4, 2026 at 02:49 PM
> **Completed:** March 4, 2026 at 02:49 PM

---

## Summary

Converted openclaw-web to Next.js app (static /openclaw, dynamic /openclaw/invite/[token]), updated SST config to Nextjs component, added SKILL sync script, and validated with successful Next production build.

**Approach:** Standard approach

---

## Key Decisions

### Use SST Nextjs component instead of manual Lambda/static routing

- **Chose:** Use SST Nextjs component instead of manual Lambda/static routing
- **Reasoning:** Simplifies routing and caching behavior while keeping token routes server-rendered and non-token route statically cached by default

---

## Chapters

### 1. Work

_Agent: default_

- Use SST Nextjs component instead of manual Lambda/static routing: Use SST Nextjs component instead of manual Lambda/static routing
