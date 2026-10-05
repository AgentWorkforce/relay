# Prevent duplicate pending replies and verify subscription provisioning

Channel posts and thread replies bypassed MCP request replay protection, so
parallel identical calls could create duplicate Relay rows. Both tools now use
request replay and pending-only coalescing; native host tools do the same within
a session. Sequential repeats remain distinct. MCP coalesces emit a telemetry
event containing only the tool name.

`integration subscribe` now validates and de-duplicates event names, reads back
persisted coverage before binding, and rolls back incomplete, inactive, or
mismatched subscriptions. GitHub setup reports missing/unknown identity
authorization instead of promising writeback. `--list` separates outbound
configuration from unknown delivery status and labels inferred inbound activity.
SDK subscription responses share event normalization, and subscription prompts
clarify replying versus initiating provider actions.

Validation:

- Focused CLI/MCP/native/prompt regression suites: 152 passed, four existing skips
  (147 passed initially; the changed CLI/native suites then passed all 96 tests,
  including five additional regressions).
- SDK integration/webhook/normalization suites: 17 passed.
- `npm run typecheck` and subsequent CLI `tsc --noEmit`: passed.
- `git diff --check`: passed. No workflow files changed.

**This PR does not close the full ticket.** Incident credentials and the
Relayfile daemon are unavailable. The installed client exposes no writeback
ledger status/retry API, and whether subscription ingress uses that ledger is
unverified. Actual GitHub writeback, durable failed-state/idempotent retry, and
the complete inbound → fleet wake → GitHub seam test remain blocked on those
contracts. Provider scopes and explicit idempotency-key arguments were left
unchanged per the reviewed evidence gates. Existing broker reconnect coverage
is cited, not rerun (Cargo unavailable).

See [investigation evidence](docs/evidence/provider-subscription-replies.md) for
verified contracts, limitations, and the required companion verification.
