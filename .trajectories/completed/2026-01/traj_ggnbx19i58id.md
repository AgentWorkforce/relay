# Trajectory: Investigate and fix relay message delivery delays/drops

> **Status:** ✅ Completed
> **Task:** agent-relay-5xx
> **Confidence:** 90%
> **Started:** January 18, 2026 at 01:10 PM
> **Completed:** January 18, 2026 at 01:55 PM

---

## Summary

Implemented offline message queue quick fix for relay protocol. Messages to known-but-offline agents are now queued and delivered on reconnect. 4 files modified, 8 new tests written TDD-style. PR #215 created.

**Approach:** Standard approach

---

## Key Decisions

### RelayDebugger identified root cause in router.ts message delivery
- **Chose:** RelayDebugger identified root cause in router.ts message delivery
- **Reasoning:** Messages to unregistered agents are silently dropped without retry or queuing. This explains intermittent failures when agents disconnect or aren't fully connected yet.

### Approve quick win fix: persist messages before connection check
- **Chose:** Approve quick win fix: persist messages before connection check
- **Reasoning:** RelayDebugger's analysis shows clear root cause in router.ts. Quick win approach (persist before checking connection) has high confidence (85%) and minimal risk. Will add offline queue and modify replayPending to deliver queued messages when agents connect.

### Use AgentRegistry to distinguish known-but-offline from unknown agents
- **Chose:** Use AgentRegistry to distinguish known-but-offline from unknown agents
- **Reasoning:** RelayDebugger discovered AgentRegistry tracks all known agents. Can check registry.has(to) to decide whether to queue message (known agent offline) vs reject (unknown agent). Confidence increased from 85% to 90%.

### Change from quick fix to comprehensive long-term solution
- **Chose:** Change from quick fix to comprehensive long-term solution
- **Reasoning:** User (khaliqgant) explicitly requested sustainable long-term fix instead of quick win. Redirecting to implement full offline message queue with TTL, delivery status tracking, sender notifications, and production-ready quality. Higher effort but proper architectural solution.

### User questioning if full solution is over-engineered
- **Chose:** User questioning if full solution is over-engineered
- **Reasoning:** khaliqgant concerned that comprehensive 4-5 day implementation may be too much. Sent comparison of quick fix (1-2 hours, basic queue, existing infrastructure) vs full solution (production-grade, new table, TTL, retry, metrics). Waiting for user decision on approach.

### Approved quick fix implementation with TDD
- **Chose:** Approved quick fix implementation with TDD
- **Reasoning:** User chose quick fix over full solution. 1-2 hours implementation using existing infrastructure (registry + storage). TDD approach with tests written first, but tests and build run only in CI, not locally.

### Quick fix implementation completed by RelayDebugger
- **Chose:** Quick fix implementation completed by RelayDebugger
- **Reasoning:** Implementation complete: 4 files modified (+413 lines), 8 new tests written TDD-style, TypeScript compiles. Changes: agent-registry.has() method, router queues messages for known-offline agents, server delivers pending on connect. Ready for CI validation.

---

## Chapters

### 1. Work
*Agent: default*

- RelayDebugger identified root cause in router.ts message delivery: RelayDebugger identified root cause in router.ts message delivery
- Approve quick win fix: persist messages before connection check: Approve quick win fix: persist messages before connection check
- Use AgentRegistry to distinguish known-but-offline from unknown agents: Use AgentRegistry to distinguish known-but-offline from unknown agents
- Change from quick fix to comprehensive long-term solution: Change from quick fix to comprehensive long-term solution
- User questioning if full solution is over-engineered: User questioning if full solution is over-engineered
- Approved quick fix implementation with TDD: Approved quick fix implementation with TDD
- Quick fix implementation completed by RelayDebugger: Quick fix implementation completed by RelayDebugger
