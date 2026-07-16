---
type: Added
level: minor
---

`agent-relay-broker` reports a PII-safe `broker_panic` telemetry event from a process-wide panic hook, capturing only the compile-time `panic_location` (`file:line`) — never the panic message — so broker crashes are visible alongside the existing agent-crash signal.
