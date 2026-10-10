# Provider subscription reply trajectory

Implemented pending-only MCP/native reply coalescing, subscription event read-back with journaled rollback, authorization-aware output, outbound configuration diagnostics, and regression tests on the current branch. Local tests and typechecks passed. Incident workspace access and the Relayfile daemon are unavailable; actual GitHub writeback and durable retry remain unverified. See summary.md and docs/evidence/provider-subscription-replies.md.

## Decisions

- Implement pending-only local coalescing and verified provisioning; leave provider scope unchanged. Reviewed plan confirms MCP replay asymmetry. Incident credentials and control-plane daemon are unavailable; do not widen PR globs without E2 evidence.
- Demote plural-events hypothesis and defer explicit message idempotency keys. Installed Relaycast types require plural events and the SDK already sends generated Idempotency-Key headers. Engine enforcement cannot be verified here. Installed Relayfile client has no writeback ledger status or retry methods.

## Open questions

- Does subscription writeback ingress use the existing Relayfile ops ledger, keyed by Relay message ID?
- What are the incident binding paths and persisted subscription events?
- Does the engine enforce message/reply idempotency keys across processes?
