# @agent-relay/runtime

Managed harness runtime for Agent Relay.

Use this package when Agent Relay needs to own the harness boundary: attach,
wrap, spawn, inject messages into a runtime, observe readiness, and collect
logs. The core `@agent-relay/sdk` package owns messaging, delivery contracts,
and action protocol; this package provides optional managed runtime
implementations.
