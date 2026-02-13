# Trajectory: Track GitHub stars in PostHog

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 11, 2026 at 09:55 PM
> **Completed:** February 11, 2026 at 09:56 PM

---

## Summary

Added scheduled GitHub Action to capture repository star snapshots into PostHog and documented required secrets and event schema in README

**Approach:** Standard approach

---

## Key Decisions

### Use a daily GitHub Action snapshot to send star counts to PostHog
- **Chose:** Use a daily GitHub Action snapshot to send star counts to PostHog
- **Reasoning:** No webhook backend required; simple, reliable time-series metric with minimal maintenance

---

## Chapters

### 1. Work
*Agent: default*

- Use a daily GitHub Action snapshot to send star counts to PostHog: Use a daily GitHub Action snapshot to send star counts to PostHog
