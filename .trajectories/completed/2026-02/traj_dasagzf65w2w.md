# Trajectory: Rename Rust binary to agent-relay-broker and clean up TS CLI legacy patterns

> **Status:** ✅ Completed
> **Confidence:** 91%
> **Started:** February 20, 2026 at 08:58 AM
> **Completed:** February 20, 2026 at 09:26 AM

---

## Summary

Completed Workstream A binary rename: Rust broker binary now agent-relay-broker across Cargo, Rust command names, SDK resolution, scripts, CI, tests, and docs; removed stale bin artifacts; verified cargo build --release --bin agent-relay-broker

**Approach:** Standard approach

---

## Key Decisions

### Keep TS CLI as user-facing agent-relay, rename Rust binary to agent-relay-broker
- **Chose:** Keep TS CLI as user-facing agent-relay, rename Rust binary to agent-relay-broker
- **Reasoning:** Rust binary is an internal engine (5 commands, JSON-over-stdio protocol), not user-facing. TS CLI has 35+ commands with deep Node.js dependencies (dashboard, npm, MCP, OAuth). Renaming Rust binary eliminates naming confusion shown in relay-cloud/TOMORROW.md without massive reimplementation effort.

### Updated plan with 7 missed items from review
- **Chose:** Updated plan with 7 missed items from review
- **Reasoning:** Review found: (1) src/spawner.rs hardcoded fallback, (2) clap command(name) in config.rs and main.rs, (3) client.ts exe vs brokerExe cleanup, (4) relay.sock in create-agent MCP config, (5) stale binary cleanup needed, (6) --remote flag must be preserved, (7) read/history offline trade-off acknowledged

### Kept client.ts PATH fallback at agent-relay
- **Chose:** Kept client.ts PATH fallback at agent-relay
- **Reasoning:** Spec DO NOT CHANGE list requires PATH fallback to TS CLI name while bundled/standalone binary uses agent-relay-broker

---

## Chapters

### 1. Work
*Agent: default*

- Keep TS CLI as user-facing agent-relay, rename Rust binary to agent-relay-broker: Keep TS CLI as user-facing agent-relay, rename Rust binary to agent-relay-broker
- Updated plan with 7 missed items from review: Updated plan with 7 missed items from review
- Kept client.ts PATH fallback at agent-relay: Kept client.ts PATH fallback at agent-relay
