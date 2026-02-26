# ADR-004: Degraded Startup Policy

## Status

Accepted

## Context

Broker startup depends on Relaycast auth/token flows that can fail transiently (notably HTTP 429 rate limits). Hard-failing startup on transient control-plane limits causes avoidable outages and restart churn.

## Decision

Define broker startup state model:

- `ready`: startup completed with valid active registration/token path.
- `ready_degraded_rate_limited`: startup encountered 429 conditions but continued with a valid cached token and explicit degraded marking.
- `fatal`: startup cannot establish a valid operating token or hits non-recoverable auth/config errors.

429 handling policy:

- Respect Retry-After semantics when present.
- Perform one registration-path probe even in degraded mode to make rate-limit state explicit in telemetry/contracts.
- Prefer continuity over restart loops when a valid cached token exists.

Token seeding and precedence:

1. Environment workspace key (`RELAY_API_KEY`) when valid.
2. Cached workspace key.
3. Fresh workspace creation as fallback.

Startup behavior requirements:

- Attempt rotate-token on cached identity before fallback registration when possible.
- In strict-name mode, name conflict is fatal.
- In degraded startup, keep serving with reduced startup guarantees and expose degraded state via health/telemetry surfaces.

## Consequences

Positive:

- Higher startup availability under control-plane throttling.
- Predictable operator semantics for 429 incidents.
- Clear contract for tests around degraded vs fatal startup outcomes.

Trade-offs:

- Degraded mode can run temporarily on stale identity assumptions.
- Requires explicit follow-up retries/telemetry to converge back to `ready`.
