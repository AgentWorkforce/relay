# Trajectory: Split OpenClaw into static route and SSR invite route; update SKILL.md URLs

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** March 4, 2026 at 02:25 PM
> **Completed:** March 4, 2026 at 02:28 PM

---

## Summary

Implemented split routing: StaticSite at /openclaw and SSR Lambda at /openclaw/invite/<token>; updated OpenClaw SKILL invite URLs to path format and added static build script from SKILL.md.

**Approach:** Standard approach

---

## Key Decisions

### Split /openclaw into cached static route and separate SSR invite route

- **Chose:** Split /openclaw into cached static route and separate SSR invite route
- **Reasoning:** Static content should be CDN-friendly while invite-token pages require per-request server rendering with explicit token instructions

### Switch invite URLs from query param to path segment

- **Chose:** Switch invite URLs from query param to path segment
- **Reasoning:** Path-based invite route cleanly maps to dedicated Lambda rendering and keeps static /openclaw route cacheable

---

## Chapters

### 1. Work

_Agent: default_

- Split /openclaw into cached static route and separate SSR invite route: Split /openclaw into cached static route and separate SSR invite route
- Switch invite URLs from query param to path segment: Switch invite URLs from query param to path segment
