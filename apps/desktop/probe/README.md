# Agent Relay probe

This crate builds `agent-relay-probe`, the daemon the desktop apps bundle and
drive; see [the probe guide](../docs/agent-relay-probe.md) for its commands,
state and verification, and [the desktop plan](../docs/plan.md) section 3 for
the JSON bridge. It reads local history through the published `ai-hist` crate's
embedder API, `SessionStore`: capture sweeps, live capture (`watch`, with
the crate's `fs-events` feature), targeted hydration, shallow inventory and
catalog reads, each stopped by the probe's own stop request and
reporting content-free progress, and the change feed its uploads are prepared
from.

Build with `cargo build --manifest-path probe/Cargo.toml --release --locked`.

| Module | Owns |
|---|---|
| `src/probe/` | The binary: bridge commands, the collector's delivery loop, `live` (its capture thread: filesystem-event driven capture, or member-scoped hydration in selected mode), progress, and `history`, its one path into `SessionStore` |
| `cloud` | Agent Relay Cloud sign-in, the workspace RelayHistory session exchange, stage-scoped `rth_*` auth files and token refresh |
| `delivery` | The upload queue over `ai-hist`'s change feed: jobs, sharing exclusions, selected-session membership and backfill, immutable batches, leases, retries and acknowledgment, and the one-time rebuild of an install that uploaded from the former export journal |
| `delivery::worker` | The bounded drain the collector runs each pass |
| `destination` | `RelayHistoryReceiver`, the worker's receiver for RelayHistory: mapping, the consent and destination guards, and transport |
| `migration` | The legacy scheduler guard |
| `relay` | The relay core daemon (`relay serve`) and its bridge; see [the relay core](../docs/relay-core.md) |

## Durable protocol transport

The expected account assertion is `relayhistory:` plus the SHA-256 of UTF-8
JSON `[orgId, workspaceId ?? ""]`. The server compares the immutable batch
account assertion to authenticated tenancy before writing; cache labels cannot
grant authority.

`RelayHistoryReceiver::prepare` maps a batch to the body for mapping version
`relayhistory-delivery-v1`, which the worker persists before transport.
`RelayHistoryReceiver::send` checks the persisted body's hash and mapping and
sends it to `/v1/delivery/batches`; authentication headers may rotate. A body
this build prepared (`PreparedPayload::prepared_by` is `delivery::THIS_BUILD`)
is sent unchanged; any other body is first repaired into wire form. Both first apply the legacy scheduler guard below, and both recheck
the receiver's configured assertions: `expected_account` (refused as
`PermissionDenied` when it differs from the batch account) and `instance_id`
(refused as `MappingVersionMismatch` when it differs from the batch
generation). An unset assertion is not checked. The worker validates its lease
and eligibility immediately before calling `send` and records the exact
acknowledgment it returns.

The receiver may send from several threads at once
(`Receiver::concurrent`), so the worker keeps up to
`DrainOptions::max_in_flight` batches of an all-sources job in flight; the
collector uses four (`DELIVERY_CONCURRENCY`). The draining thread prepares,
claims, maps, persists and validates each batch and hands it straight to an
idle sender thread, so validation still immediately precedes `send`; it
records every outcome itself. The batches of one window are claimed oldest
first under one job lease, which one keepalive renews while any of them is in
flight and which is released with the last of them. A failure stops further
claims until its retry deadline, with the usual backoff and `retry_after`; the
batches already in flight finish and are recorded, and a sibling's
acknowledgment never clears that failure or its backoff; nor does an
acknowledgment arriving while an older batch is still in flight, so a batch
that keeps failing backs off further each time. A blocking verdict
blocks the job, and the outcomes of the batches sent beside it are still
recorded. The job's `acknowledged_cursor` is the end of the longest run of
acknowledged batches with no unresolved batch before it: if batch k fails
while k+1 is acknowledged, the position stays before k, k+1 stays delivered
(it is not sent again, and its receipt is kept while it ends past k's feed
end), and k alone is retried. A selected-sessions job holds a window too. Its
member backfill batches share the job's feed end, so the position passes that
end only once every batch ending there has resolved, and an acknowledged
receipt ending at the same place as an unresolved batch may be released,
since that batch carries the end itself. The receiver is idempotent per batch id and revision, so a batch
re-sent after an uncertain outcome is safe, and a newer revision that arrives
before an older one is kept.

Every receiver in the process shares one HTTP agent, so consecutive batches
reuse a kept-alive connection rather than paying a TCP and TLS handshake each;
it keeps an idle connection for every batch a drain may have in flight
(`worker::MAX_IN_FLIGHT`, 16), and a pooled connection the server has closed
is replaced before use. A receiver
keeps the stage session its last successful send used and reads the auth store
again only when it has none, when its access token is within a minute of its
stored expiry (or has no stored expiry), or after a failed send. A 401 always
takes the shared locked reload-and-refresh path, so a token another process
rotated is picked up there. The account assertion is checked against whichever
session is sent.

Failures are `Transient`, `RateLimited`, `AuthenticationRequired`,
`PermissionDenied`, `InvalidPayload`, `UnsupportedEvidence` or
`MappingVersionMismatch`. Only transient and rate-limit failures retry
automatically. HTTP 404 blocks rather than falling back to another protocol.
Batches hold at most 100 records, the protocol default, until a receipt
publishes the server's limits (`limits: {maxRecords, maxRequestBytes}`):
`maxRecords` then sizes the batches prepared next, up to 500
(`MAX_PUBLISHED_BATCH_RECORDS`), with the scan budget raised to four feed
changes per record so the larger cap can be filled, and `maxRequestBytes` can only lower the
byte cap. A receipt without `limits`, from an older server, returns the cap to
100, so no batch is prepared larger than the last limit the server published.
The limits are kept for the collector process, not on disk. A batch is
immutable once prepared and is sent as prepared: the receiver maps batches of
up to 500 records, so one prepared under a raised limit before a restart is
still mapped, and a server that accepts fewer answers 400, which record
isolation splits into halves. Request bodies are capped at 2 MiB, the
server's request limit; HTTP deadlines come from the worker's budget on every
request; redirects are disabled.

The JSON fixture in `tests/fixtures/delivery-native-v1.json` is shared with the
companion server tests.

### Legacy scheduler migration guard

`migration::status` returns `{state:"clear"|"active"|"unknown",jobs:string[]}`.
Job labels are fixed safe names; scheduler commands, credentials, and history
are never returned. On macOS it checks both
`~/Library/LaunchAgents/com.ai-hist.push.plist` and the loaded
`com.ai-hist.push` launchd label. On macOS/Linux it checks uncommented user cron
entries bearing `# ai-hist push (managed)`. An unloaded plist still blocks
because it can restart at login. Command failures, timeouts, and oversized
output produce `unknown`; positive evidence takes precedence as `active`. Each
scheduler command has a two-second deadline and a 1 MiB output cap.

A receiver inspects at most once every 60 seconds
(`destination::SCHEDULER_GUARD_TTL`) and applies that verdict to every batch it
prepares or sends meanwhile. The collector keeps one receiver state for the
process, and the check it runs directly before each delivery pass, which names
the cause for the user, uses that same verdict, so back-to-back passes inspect
at most once a minute between them. Delivery setup inspects directly. A legacy
uploader installed while the collector runs is therefore noticed within 60
seconds rather than before the next batch.

`active` always blocks delivery. `unknown` requires the user's explicit
acknowledgment that inspection was unavailable and they have checked or stopped
legacy scheduling; that acknowledgment is never reported as a successful
inspection. Platforms other than macOS/Linux return `clear` with
`legacy-installer-unsupported` because the old automatic installer never
supported them.

The guard never stops a service, changes scheduler files, reads auth, or
migrates watermarks. Arbitrarily named schedules cannot be discovered by it and
must be stopped by their owner. A status check cannot revoke a request that
another process has already sent.
