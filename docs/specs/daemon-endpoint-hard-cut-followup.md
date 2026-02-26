# Daemon Endpoint 410 Follow-Up Plan

Status: deferred by request (do not modify `relay-cloud` yet)  
Prepared on: 2026-02-23

## Goal

When resumed, enforce a strict hard cut for legacy daemon HTTP surfaces by returning a loud:

- HTTP `410 Gone`
- JSON body with `code: "daemon_removed"`
- Migration guidance pointing to `/api/brokers/*`

This mirrors the behavior already implemented in dashboard server.

## Priority Targets

### 1) Canonical Cloud Repo (first place to cut)

- `/Users/khaliqgant/Projects/agent-workforce/relay-cloud/packages/cloud/src/server.ts`
  - Current behavior: conditional legacy support behind `legacyDaemonApisEnabled`.
  - Cutover change: make `/api/daemons/*` always return 410 (remove conditional legacy serving path).

### 2) Active Cloud Worktrees/Forks (mirror the same guard)

- `/Users/khaliqgant/Projects/agent-workforce/relay-cloud-relayfile-integration/packages/cloud/src/server.ts`
- `/Users/khaliqgant/Projects/agent-workforce/relay-cloud-auth-broker-wt/packages/cloud/src/server.ts`
- `/Users/khaliqgant/Projects/agent-workforce/relay-cloud-fix-cli-base-wt/packages/cloud/src/server.ts`
- `/Users/khaliqgant/Projects/agent-workforce/relay-cloud-perf-fixes/packages/cloud/src/server.ts`

These currently mount `app.use('/api/daemons', daemonsRouter)` directly.

## 410 Contract (recommended)

Use a consistent response shape:

```json
{
  "success": false,
  "code": "daemon_removed",
  "error": "BREAKING CHANGE: daemon API endpoints were removed.",
  "details": "Update clients to broker endpoints under /api/brokers/*.",
  "requiredEndpoints": [
    "/api/brokers/*",
    "/api/brokers/workspace/:workspaceId/agents",
    "/api/brokers/link"
  ]
}
```

## Suggested Server Patch Pattern

In each target server:

1. Stop mounting daemon router:
   - remove or bypass `app.use('/api/daemons', daemonsRouter)`.
2. Add explicit handlers:
   - `app.all('/api/daemons', ...)`
   - `app.all('/api/daemons/{*path}', ...)`
3. Return HTTP 410 with `daemon_removed` payload.

## Known Downstream Callers To Migrate After Guard Is Live

These are callers still requesting `/api/daemons/*` and will intentionally start failing with 410 after the cut:

- `/Users/khaliqgant/Projects/agent-workforce/relay-sdk-workflows/src/cli/index.ts`
- `/Users/khaliqgant/Projects/agent-workforce/relay-sdk-fix-broker/src/cli/index.ts`
- `/Users/khaliqgant/Projects/agent-workforce/relay-reduce-heartbeat/src/cli/index.ts`
- `/Users/khaliqgant/Projects/agent-workforce/relay-tui/packages/cli/src/index.ts`
- `/Users/khaliqgant/Projects/agent-workforce/relay-channel-first/src/cli/index.ts`
- `/Users/khaliqgant/Projects/agent-workforce/relay-perf-poll/src/cli/index.ts`
- `/Users/khaliqgant/Projects/agent-workforce/relay-exit-detection/src/cli/index.ts`
- `/Users/khaliqgant/Projects/agent-workforce/relay-hybrid-compat-wt/src/cli/index.ts`

Plus daemon package sync clients in several repos:

- `packages/daemon/src/cloud-sync.ts`
- `packages/daemon/src/sync-queue.ts`
- `packages/daemon/src/consensus-integration.ts`

## Validation Checklist (when you resume)

1. `rg -n "/api/daemons" packages/cloud/src` in each cloud repo.
2. Hit representative daemon endpoint and confirm `410`:
   - `curl -i http://.../api/daemons/workspace/<id>/agents`
3. Ensure broker routes still work:
   - `curl -i http://.../api/brokers/...`
4. Update docs/OpenAPI that still advertise `/api/daemons`.
5. Add/adjust tests asserting `410` + `daemon_removed` contract.

## Notes

- Dashboard server already has this loud 410 behavior in:
  - `/Users/khaliqgant/Projects/agent-workforce/relay-dashboard/packages/dashboard-server/src/proxy-server.ts`
- This document is intentionally action-oriented for a later pass; no `relay-cloud` code changes were made in this step.
