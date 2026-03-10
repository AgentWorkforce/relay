# Trajectory: Fix broker PID filename mismatch and simplify ephemeral mode

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** March 9, 2026 at 03:24 PM
> **Completed:** March 9, 2026 at 03:26 PM

---

## Summary

Fixed broker PID mismatch (TS used broker.pid, Rust writes broker-{name}.pid), updated all CLI commands + tests, simplified ephemeral mode to skip lock/PID entirely. 13/13 integration tests pass.

**Approach:** Standard approach

---

## Key Decisions

### TS CLI used hardcoded broker.pid but Rust writes broker-{name}.pid — root cause of stale lock errors
- **Chose:** TS CLI used hardcoded broker.pid but Rust writes broker-{name}.pid — root cause of stale lock errors
- **Reasoning:** Per-broker-name isolation PR changed Rust side but never updated TypeScript side

### Removed ephemeral mode lock/PID entirely — SDK broker lifecycle tied to parent via stdin EOF
- **Chose:** Removed ephemeral mode lock/PID entirely — SDK broker lifecycle tied to parent via stdin EOF
- **Reasoning:** Lock was causing permission issues in /tmp across users and was unnecessary since parent exit triggers broker shutdown via EOF

### Unicode sanitization: used \p{L}\p{N} regex to match Rust is_alphanumeric()
- **Chose:** Unicode sanitization: used \p{L}\p{N} regex to match Rust is_alphanumeric()
- **Reasoning:** ASCII-only regex would mismatch on non-ASCII directory names causing the same PID-not-found bug

---

## Chapters

### 1. Work
*Agent: default*

- TS CLI used hardcoded broker.pid but Rust writes broker-{name}.pid — root cause of stale lock errors: TS CLI used hardcoded broker.pid but Rust writes broker-{name}.pid — root cause of stale lock errors
- Removed ephemeral mode lock/PID entirely — SDK broker lifecycle tied to parent via stdin EOF: Removed ephemeral mode lock/PID entirely — SDK broker lifecycle tied to parent via stdin EOF
- Unicode sanitization: used \p{L}\p{N} regex to match Rust is_alphanumeric(): Unicode sanitization: used \p{L}\p{N} regex to match Rust is_alphanumeric()
- Architecture — Persist vs Ephemeral broker modes:

┌─────────────────────────────────────────────────────────────────────┐
│                        BROKER STARTUP MODES                        │
├─────────────────────────────────┬───────────────────────────────────┤
│         PERSIST MODE            │         EPHEMERAL MODE            │
│   (agent-relay up / dashboard)  │   (SDK direct / no --persist)     │
├─────────────────────────────────┼───────────────────────────────────┤
│                                 │                                   │
│  CLI passes:                    │  SDK passes:                      │
│    --persist --api-port 3890    │    (no extra args)                │
│                                 │                                   │
│  ┌───────────────────────┐      │  ┌───────────────────────┐        │
│  │  ensure_runtime_paths │      │  │ ensure_ephemeral_paths │        │
│  └───────┬───────────────┘      │  └───────┬───────────────┘        │
│          │                      │          │                        │
│          ▼                      │          ▼                        │
│  .agent-relay/                  │  /tmp/agent-relay-ephemeral-{pid}/│
│  ├── broker-{name}.lock  ◄─┐   │  │                                │
│  ├── broker-{name}.pid   ◄─┤   │  │  (no lock file)                │
│  ├── state-{name}.json   ◄─┤   │  │  (no PID file)                 │
│  ├── pending-{name}.json ◄─┤   │  │  (no state persistence)        │
│  └── crash-insights.json   │   │  │                                │
│                            │   │  │  Only used for:                 │
│  Lock: flock() exclusive   │   │  │  ├── continuity dir (agent      │
│  PID:  written on start    │   │  │  │   context handoff)           │
│  State: saved on changes   │   │  │  └── crash-insights.json        │
│  Pending: saved periodic   │   │  │      (loads gracefully if       │
│  Cleanup: on graceful exit │   │  │       missing)                  │
│                            │   │  │                                 │
│  Single-instance guard:    │   │  │  Single-instance guard:         │
│  flock() prevents dupes    │   │  │  NONE — stdin EOF lifecycle     │
│                            │   │  │  ties broker to parent          │
│  Stale recovery:           │   │  │                                 │
│  PID alive check + re-lock │   │  │  Lifecycle:                     │
│                            │   │  │  Parent exits → stdin EOF       │
│  Used by:                  │   │  │  → broker shuts down            │
│  ├── agent-relay up        │   │  │                                 │
│  ├── agent-relay down      │   │  │  Used by:                       │
│  ├── agent-relay status    │   │  │  ├── SDK AgentRelayClient       │
│  └── agent-relay init      │   │  │  └── MCP server                 │
└─────────────────────────────┘   │  └───────────────────────────────┘ │
                                  └───────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                     FILE READS IN EACH MODE                        │
├──────────────────────┬──────────────────┬───────────────────────────┤
│  Operation           │  Persist         │  Ephemeral                │
├──────────────────────┼──────────────────┼───────────────────────────┤
│  state.save()        │  writes JSON     │  guarded by persist       │
│  state.load()        │  reads JSON      │  uses default()           │
│  save_pending()      │  writes JSON     │  guarded by persist       │
│  load_pending()      │  reads JSON      │  returns empty HashMap    │
│  crash_insights      │  reads/writes    │  graceful if missing      │
│  continuity save     │  writes          │  writes (scratch dir)     │
│  continuity load     │  reads           │  reads (scratch dir)      │
│  PID file            │  write + clean   │  not created              │
│  Lock file           │  flock()         │  not created              │
└──────────────────────┴──────────────────┴───────────────────────────┘: Architecture — Persist vs Ephemeral broker modes:

┌─────────────────────────────────────────────────────────────────────┐
│                        BROKER STARTUP MODES                        │
├─────────────────────────────────┬───────────────────────────────────┤
│         PERSIST MODE            │         EPHEMERAL MODE            │
│   (agent-relay up / dashboard)  │   (SDK direct / no --persist)     │
├─────────────────────────────────┼───────────────────────────────────┤
│                                 │                                   │
│  CLI passes:                    │  SDK passes:                      │
│    --persist --api-port 3890    │    (no extra args)                │
│                                 │                                   │
│  ┌───────────────────────┐      │  ┌───────────────────────┐        │
│  │  ensure_runtime_paths │      │  │ ensure_ephemeral_paths │        │
│  └───────┬───────────────┘      │  └───────┬───────────────┘        │
│          │                      │          │                        │
│          ▼                      │          ▼                        │
│  .agent-relay/                  │  /tmp/agent-relay-ephemeral-{pid}/│
│  ├── broker-{name}.lock  ◄─┐   │  │                                │
│  ├── broker-{name}.pid   ◄─┤   │  │  (no lock file)                │
│  ├── state-{name}.json   ◄─┤   │  │  (no PID file)                 │
│  ├── pending-{name}.json ◄─┤   │  │  (no state persistence)        │
│  └── crash-insights.json   │   │  │                                │
│                            │   │  │  Only used for:                 │
│  Lock: flock() exclusive   │   │  │  ├── continuity dir (agent      │
│  PID:  written on start    │   │  │  │   context handoff)           │
│  State: saved on changes   │   │  │  └── crash-insights.json        │
│  Pending: saved periodic   │   │  │      (loads gracefully if       │
│  Cleanup: on graceful exit │   │  │       missing)                  │
│                            │   │  │                                 │
│  Single-instance guard:    │   │  │  Single-instance guard:         │
│  flock() prevents dupes    │   │  │  NONE — stdin EOF lifecycle     │
│                            │   │  │  ties broker to parent          │
│  Stale recovery:           │   │  │                                 │
│  PID alive check + re-lock │   │  │  Lifecycle:                     │
│                            │   │  │  Parent exits → stdin EOF       │
│  Used by:                  │   │  │  → broker shuts down            │
│  ├── agent-relay up        │   │  │                                 │
│  ├── agent-relay down      │   │  │  Used by:                       │
│  ├── agent-relay status    │   │  │  ├── SDK AgentRelayClient       │
│  └── agent-relay init      │   │  │  └── MCP server                 │
└─────────────────────────────┘   │  └───────────────────────────────┘ │
                                  └───────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                     FILE READS IN EACH MODE                        │
├──────────────────────┬──────────────────┬───────────────────────────┤
│  Operation           │  Persist         │  Ephemeral                │
├──────────────────────┼──────────────────┼───────────────────────────┤
│  state.save()        │  writes JSON     │  guarded by persist       │
│  state.load()        │  reads JSON      │  uses default()           │
│  save_pending()      │  writes JSON     │  guarded by persist       │
│  load_pending()      │  reads JSON      │  returns empty HashMap    │
│  crash_insights      │  reads/writes    │  graceful if missing      │
│  continuity save     │  writes          │  writes (scratch dir)     │
│  continuity load     │  reads           │  reads (scratch dir)      │
│  PID file            │  write + clean   │  not created              │
│  Lock file           │  flock()         │  not created              │
└──────────────────────┴──────────────────┴───────────────────────────┘
