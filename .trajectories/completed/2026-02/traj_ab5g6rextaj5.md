# Trajectory: Investigate dashboard --integrated option error

> **Status:** ✅ Completed
> **Confidence:** 94%
> **Started:** February 23, 2026 at 08:14 AM
> **Completed:** February 23, 2026 at 08:16 AM

---

## Summary

Diagnosed agent-relay up dashboard crash as CLI/dashboard binary mismatch in global pnpm install; provided remediation commands

**Approach:** Standard approach

---

## Key Decisions

### Failure is caused by stale relay-dashboard-server binary lacking --integrated

- **Chose:** Failure is caused by stale relay-dashboard-server binary lacking --integrated
- **Reasoning:** agent-relay v2.3.14 launches dashboard with --integrated; local /Users/khaliqgant/Library/pnpm/nodejs/22.22.0/bin/relay-dashboard-server rejects it, while npx @agent-relay/dashboard-server@latest accepts it

---

## Chapters

### 1. Work

_Agent: default_

- Failure is caused by stale relay-dashboard-server binary lacking --integrated: Failure is caused by stale relay-dashboard-server binary lacking --integrated
