# Broker local-only operation

Explicit --local-only starts without Relaycast, confines the API to loopback, suppresses fleet connections and worker credentials/MCP injection, and reports degradation in startup, health, session, connection metadata and CLI status.

Local delivery is saved before acceptance. Pending work waits for a restarted recipient; a bounded, destination-pinned audit outbox survives restart and reconciles with stable event IDs without replaying DMs.

Validation: 1065 Rust tests passed (4 ignored), 107 CLI tests passed, TypeScript typecheck and Clippy passed. Compiled base/head proof verified outage startup failure on base and local spawn, send, terminal IO, restart retention and reconnect audit replay on head.

Inherited GIT_CONFIG_COUNT and RELAY_ATTEST_SESSION_ID alter isolated Git hook fixtures. Unsetting only those variables for the test subprocess yields a passing full suite; repository commit hooks remain enabled.

GitHub API authentication returns HTTP 401; SSH access works. PR creation and subsequent CI/review follow-through require restored API authentication. No merge authorized.

Decision: Recovered connectivity drains durable audit records without republishing DMs, which could execute work twice or route local names to another machine. Fleet capabilities require a deliberate normal restart.
