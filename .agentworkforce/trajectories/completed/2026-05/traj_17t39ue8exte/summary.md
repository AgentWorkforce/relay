# Trajectory: Add GitHub traffic to PostHog sync

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** May 26, 2026 at 09:16 AM
> **Completed:** May 26, 2026 at 09:17 AM

---

## Summary

Added a scheduled GitHub Actions workflow and Node script that fetch GitHub traffic views, clones, popular paths, and referrers, then sends daily backfill and rolling snapshots to PostHog.

**Approach:** Standard approach

---

## Key Decisions

### Use GitHub traffic REST API and PostHog batch ingestion

- **Chose:** Use GitHub traffic REST API and PostHog batch ingestion
- **Reasoning:** The traffic page data is exposed through GitHub's traffic endpoints for views, clones, top paths, and referrers; PostHog batch supports historical timestamps and lets the workflow backfill the 14-day window without creating duplicate daily metrics.

---

## Chapters

### 1. Work

_Agent: default_

- Use GitHub traffic REST API and PostHog batch ingestion: Use GitHub traffic REST API and PostHog batch ingestion
- Implemented a scheduled GitHub traffic sync workflow with deterministic daily PostHog insert IDs, rolling traffic-window snapshots, and validation via endpoint shape checks plus mocked PostHog ingestion.
