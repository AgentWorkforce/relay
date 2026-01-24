# Trajectory: Revert aggressive retry logic in relay-pty-orchestrator

> **Status:** ✅ Completed
> **Task:** relay-latency-fix
> **Confidence:** 90%
> **Started:** January 24, 2026 at 08:22 AM
> **Completed:** January 24, 2026 at 08:26 AM

---

## Summary

Reverted aggressive retry logic in relay-pty-orchestrator that caused 2-4 minute message delivery delays. Removed MAX_INJECTION_RETRIES and exponential backoff, restored immediate failure reporting, fixed logError to always output.

**Approach:** Standard approach
