# Trajectory: Telemetry key from env (P0.5 of #881)

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#881
> **Confidence:** 90%
> **Started:** May 17, 2026 at 10:56 PM
> **Completed:** May 17, 2026 at 11:02 PM

---

## Summary

Replaced hardcoded PostHog key with build-time env injection (option_env! in Rust, process.env in TS, bun --define for standalone bundles). Wired AGENT_RELAY_POSTHOG_KEY through publish.yml and build-broker-binary.yml. No-op telemetry when key absent.

**Approach:** Standard approach

---

## Key Decisions

### Use option_env! for Rust, runtime process.env for TS, bun --define for standalone

- **Chose:** Use option_env! for Rust, runtime process.env for TS, bun --define for standalone
- **Reasoning:** tsc has no build-time define so TS runtime read is the natural fit; bun-compiled standalone binaries need --define since end users won't set the env var; Rust option_env! bakes the const at compile time matching shipped-binary semantics

---

## Chapters

### 1. Work

_Agent: default_

- Use option_env! for Rust, runtime process.env for TS, bun --define for standalone: Use option_env! for Rust, runtime process.env for TS, bun --define for standalone
