# Trajectory: Rope telemetry through CLI SDK and hosted backend

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** June 3, 2026 at 05:42 AM
> **Completed:** June 3, 2026 at 05:58 AM

---

## Summary

Routed telemetry context through the CLI, SDK, cloud client, Rust broker, and hosted relaycast engine. Added app/surface/harness common properties, minimal SDK method/workflow events, enabled cloud request identity headers only when telemetry is enabled, and made hosted relaycast prefer Agent Relay anonymous ids for PostHog distinct ids. Verified telemetry, cloud, SDK, CLI, broker, and relaycast engine checks.

**Approach:** Standard approach

---

## Key Decisions

### Propagated Agent Relay telemetry context through child process env and cloud request headers
- **Chose:** Propagated Agent Relay telemetry context through child process env and cloud request headers
- **Reasoning:** CLI owns telemetry preferences and anonymous id creation, so cloud requests only include identity, surface, client version, and harness headers when telemetry is enabled and a PostHog key is configured.

### Hosted relaycast telemetry prefers Agent Relay anonymous id
- **Chose:** Hosted relaycast telemetry prefers Agent Relay anonymous id
- **Reasoning:** When the hosted backend receives X-Agent-Relay-Anonymous-Id, using it as PostHog distinctId ties CLI, SDK, and server-side events together while preserving workspace_id as an event property.

### Kept SDK telemetry minimal
- **Chose:** Kept SDK telemetry minimal
- **Reasoning:** SDK events capture stable method/workflow names, success, duration, and error class only, avoiding user content, paths, payloads, tokens, URLs, and argument values.

---

## Chapters

### 1. Work
*Agent: default*

- Propagated Agent Relay telemetry context through child process env and cloud request headers: Propagated Agent Relay telemetry context through child process env and cloud request headers
- Hosted relaycast telemetry prefers Agent Relay anonymous id: Hosted relaycast telemetry prefers Agent Relay anonymous id
- Kept SDK telemetry minimal: Kept SDK telemetry minimal
