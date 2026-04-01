# Trajectory: Fix OpenClaw SEO canonical domain and improve metadata/crawl signals

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** March 6, 2026 at 03:49 PM
> **Completed:** March 6, 2026 at 03:49 PM

---

## Summary

Updated OpenClaw SEO to use agentrelay.dev as the canonical host, added route metadata/open graph/twitter tags, generated sitemap and robots endpoints, improved the hosted skill page intro, and noindexed tokenized invite URLs; verified with a successful Next.js build.

**Approach:** Standard approach

---

## Key Decisions

### Set the canonical domain and crawler metadata to agentrelay.dev

- **Chose:** Set the canonical domain and crawler metadata to agentrelay.dev
- **Reasoning:** The app had no metadata base and production deployment config still pointed at agentrelay.net, which could split ranking signals and generate incorrect canonicals. Route-level metadata plus sitemap/robots gives search engines a single preferred hostname and crawl path.

---

## Chapters

### 1. Work

_Agent: default_

- Set the canonical domain and crawler metadata to agentrelay.dev: Set the canonical domain and crawler metadata to agentrelay.dev
