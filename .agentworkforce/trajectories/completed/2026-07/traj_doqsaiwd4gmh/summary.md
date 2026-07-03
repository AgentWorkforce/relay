# Trajectory: Implement RFC #1204: reframe local/fleet serve as node command group

> **Status:** ✅ Completed
> **Task:** relay#1204
> **Confidence:** 85%
> **Started:** July 3, 2026 at 03:28 PM
> **Completed:** July 3, 2026 at 04:09 PM

---

## Summary

Workstream B (CLI): node command group replaces local/fleet serve; cloud enroll added; local hidden alias + fleet serve hidden stub. Build+typecheck+399 CLI tests green.

**Approach:** Standard approach

---

## Key Decisions

### Do not re-export @agent-relay/fleet from @agent-relay/sdk; fleet stays the public authoring+runtime surface
- **Chose:** Do not re-export @agent-relay/fleet from @agent-relay/sdk; fleet stays the public authoring+runtime surface
- **Reasoning:** sdk->fleet edge closes a hard cycle: fleet depends on harnesses/harness-driver which import values from sdk; build:core order bakes sdk below fleet. RFC open question resolved as option (c), flagged in PR.

### Persist cloud enroll creds in CLI-owned ~/.agentworkforce/relay/fleet-enrollments.json (0600), injected as RELAY_NODE_TOKEN/RELAY_BASE_URL env at node up
- **Chose:** Persist cloud enroll creds in CLI-owned ~/.agentworkforce/relay/fleet-enrollments.json (0600), injected as RELAY_NODE_TOKEN/RELAY_BASE_URL env at node up
- **Reasoning:** Broker token cache is keyed by internally-derived node_id the CLI cannot compute; RELAY_NODE_TOKEN env override is the documented durable read path; zero Rust changes.

### local becomes hidden deprecated alias warning once; fleet serve becomes hidden error stub pointing at node up + cloud enroll
- **Chose:** local becomes hidden deprecated alias warning once; fleet serve becomes hidden error stub pointing at node up + cloud enroll
- **Reasoning:** local has shipped (back-compat required); fleet serve only exists in [Unreleased] so a guiding error beats an alias.

### Workstream A: promoted fleet WS runtime to serveNode with DI trigger client; added cloud enrollment JSON store
- **Chose:** Workstream A: promoted fleet WS runtime to serveNode with DI trigger client; added cloud enrollment JSON store
- **Reasoning:** D1/D2/D4: no @agent-relay/sdk in fleet (removed dep), FleetTriggerSyncClient injected, cloud store mirrors worker.ts

---

## Chapters

### 1. Work
*Agent: default*

- Do not re-export @agent-relay/fleet from @agent-relay/sdk; fleet stays the public authoring+runtime surface: Do not re-export @agent-relay/fleet from @agent-relay/sdk; fleet stays the public authoring+runtime surface
- Persist cloud enroll creds in CLI-owned ~/.agentworkforce/relay/fleet-enrollments.json (0600), injected as RELAY_NODE_TOKEN/RELAY_BASE_URL env at node up: Persist cloud enroll creds in CLI-owned ~/.agentworkforce/relay/fleet-enrollments.json (0600), injected as RELAY_NODE_TOKEN/RELAY_BASE_URL env at node up
- local becomes hidden deprecated alias warning once; fleet serve becomes hidden error stub pointing at node up + cloud enroll: local becomes hidden deprecated alias warning once; fleet serve becomes hidden error stub pointing at node up + cloud enroll
- Workstream A: promoted fleet WS runtime to serveNode with DI trigger client; added cloud enrollment JSON store: Workstream A: promoted fleet WS runtime to serveNode with DI trigger client; added cloud enrollment JSON store

---

## Artifacts

**Commits:** b4edfe9, a8a0aea, 76c7025
**Files changed:** 12
