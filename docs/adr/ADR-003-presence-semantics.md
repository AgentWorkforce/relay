# ADR-003: Presence Semantics

## Status
Accepted

## Context
Presence signals can originate from multiple identities (broker, worker, reader). Without ownership rules, online/offline status becomes noisy and contradictory. Recent SDK hardening added explicit lifecycle helpers and WS-coupled heartbeats.

## Decision
Set presence ownership by identity role:
- Worker identities own their own lifecycle signals.
- Broker identities publish broker-level worker state (spawned/idle/exited/stuck), not synthetic worker presence unless explicitly owning lifecycle actions.
- Reader identities are read-only for presence and must not emit lifecycle updates.

Adopt SDK lifecycle APIs as canonical worker mechanism:
- `presence.markOnline()` -> `POST /v1/agents/heartbeat`
- `presence.heartbeat()` -> `POST /v1/agents/heartbeat`
- `presence.markOffline()` -> `POST /v1/agents/disconnect`

Auto-heartbeat policy:
- Start on WS open.
- Stop on disconnect/close/permanent disconnect.
- Default interval: 30 seconds.
- Configurable via `autoHeartbeatMs` (`false` disables).

Reconnection policy coupling:
- WS reconnect uses jittered backoff and configurable max attempts.
- Circuit breaker emits `permanently_disconnected`.
- Presence heartbeats stop when circuit breaker trips.

Staleness thresholds for broker health interpretation:
- Online threshold: 30 seconds since last activity.
- Stuck threshold: 5 minutes since last activity.

## Consequences
Positive:
- Reduced false online/offline flapping.
- Consistent ownership model across SDK, broker, and dashboard.
- Better degraded-behavior handling with explicit permanent disconnect state.

Trade-offs:
- Requires disciplined role separation in client implementations.
- Presence correctness depends on heartbeat scheduling and reconnect tuning.
