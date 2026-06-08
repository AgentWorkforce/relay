# Trajectory: Workspace-level event stream via relaycast 2.5.1

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** June 3, 2026 at 12:27 PM
> **Completed:** June 8, 2026 at 12:35 PM

---

## Summary

Reviewed PR #1062, fixed validated read-ack and workspace-key review findings, and verified focused Rust/TypeScript checks.

**Approach:** Standard approach

---

## Key Decisions

### Port PR 888 telemetry lessons to current split

- **Chose:** Port PR 888 telemetry lessons to current split
- **Reasoning:** User requested Relaycast request attribution, install/update events, and MCP action-call telemetry while preserving UA-like harness values.

### Fixed validated PR #1062 review findings

- **Chose:** Fixed validated PR #1062 review findings
- **Reasoning:** Current checkout still let blank workspace*key suppress env fallback and deduped synthetic delivery read-acks before classification; added flush* synthetic classification and narrow regression tests.

---

## Chapters

### 1. Work

_Agent: default_

- events.connect() falls back to the relaycast 2.5 workspace stream when no agent client; fixes relay#1031 so workspace relay.addListener streams. Bumped @relaycast/sdk to ^2.5.1. Also fixed pre-existing vitest-4 constructor-mock breakage in agent-relay.test.ts (main 'Test' workflow was red).: events.connect() falls back to the relaycast 2.5 workspace stream when no agent client; fixes relay#1031 so workspace relay.addListener streams. Bumped @relaycast/sdk to ^2.5.1. Also fixed pre-existing vitest-4 constructor-mock breakage in agent-relay.test.ts (main 'Test' workflow was red).
- Port PR 888 telemetry lessons to current split: Port PR 888 telemetry lessons to current split
- Fixed validated PR #1062 review findings: Fixed validated PR #1062 review findings

---

## Artifacts

**Commits:** 152ea978, 1301a319, d67f6de6, b11c257e, ad9dbe41, 6eef2da3, bc6b9826, eb55a2b7, 8f4db312, ac43ef4b, a14f65f9, d8d00e2c, 58d7f729, 7f2392d7, 6df294fc, b17be37e, 1433c47e, c7811469, 80e42410, aaa65c91, f4ff7e02, 1cb41cff, d18bd284, a5ce5aae, 0a651273, 767f954b, 9c6d2229, 51ee3852, 235a7507, 9959deed, eb9dc4c2, 00a2c436, f48136a6
**Files changed:** 194
