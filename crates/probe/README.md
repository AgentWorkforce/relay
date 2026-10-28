# Agent Relay probe (relay core)

`crates/probe` is the Agent Relay **core**: the native Rust daemon that
discovers the coding-agent sessions running on a computer (Claude Code, Codex,
Devin, OpenCode, Grok, Pi, Cursor CLI, OpenClaw, Hermes, Muse, …), injects
Relay messages into them through each harness's own native route (hooks, app
servers, plugins and sockets, not a PTY), captures their history and uploads it
to RelayHistory. It builds one daemon binary, `agent-relay-probe`, which runs
as one long-lived process per user:

```sh
agent-relay-probe relay serve [--socket PATH] [--app-data-dir PATH] [--site-url URL] [--headless]
```

The desktop apps (macOS, Linux/Windows GTK and iPad, in the relay-desktop
repository) are clients of this daemon over its JSON bridge. The core was
imported from relay-desktop as a clean snapshot so that the relay CLI can
install and run it headless, without the desktop GUI; see
[`docs/probe-move.md`](../../docs/probe-move.md) for what moved, what stayed
and the remaining phases.

- [`docs/relay-core.md`](docs/relay-core.md): the daemon, its bridge
  contract, delivery and the relay-send socket.
- [`docs/agent-relay-probe.md`](docs/agent-relay-probe.md): the probe's
  commands, capture, upload state and verification.

## Layout

This crate is its **own Cargo workspace** with its own `Cargo.lock`. It is not
a member of the repository's root workspace (the broker): the two pin
different `relaycast`, `nix` and `portable-pty` versions, which a later phase
aligns.

| Path                                                                | Owns                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/probe/`                                                        | The `agent-relay-probe` binary: bridge commands, the collector's delivery loop, `live` capture, progress, and `history`, its one path into `SessionStore`                                             |
| `src/relay/`                                                        | The relay core daemon (`relay serve`): workspace and account, Relaycast, delivery and injection per harness, harness setup (hooks/plugins), spawning, the bridge and its contract (`relay::contract`) |
| `src/cloud*`, `src/delivery*`, `src/destination*`, `src/retention*` | Cloud sign-in, the upload queue and its worker, the RelayHistory receiver, history retention                                                                                                          |
| `src/install*`                                                      | Where a packaged desktop install keeps its executables (`agent-relay`, `agent-relay-probe`); the core's launch-at-login entry uses it                                                                 |
| `src/session_model*`                                                | The session catalog's view model (rows, the session search language, upload states) the core's catalog query filters by                                                                               |
| `src/bin/relay-contract-codegen.rs`                                 | Generates the Swift bridge contract the apps consume                                                                                                                                                  |
| `contract/CoreContract.swift`                                       | The checked-in generated contract; CI fails on drift                                                                                                                                                  |
| `scripts/`                                                          | `generate-contract.sh`, `check-open-source.sh`                                                                                                                                                        |
| `tests/`                                                            | Integration tests, with in-process fakes of Cloud, Relaycast and RelayHistory (`tests/support`)                                                                                                       |

## Build and test

```sh
cargo build --manifest-path crates/probe/Cargo.toml --locked
cargo build --manifest-path crates/probe/Cargo.toml --locked --release --bin agent-relay-probe
# Tests read and write under HOME: use an empty one.
HOME="$(mktemp -d)" cargo test --manifest-path crates/probe/Cargo.toml --locked
```

The relayhistory git dependencies fetch over HTTPS; if Cargo's built-in Git
cannot authenticate in your environment, set `CARGO_NET_GIT_FETCH_WITH_CLI=true`.

`.github/workflows/probe-ci.yml` builds and tests on Linux x64 and macOS
arm64, builds on Windows x64, checks the generated contract for drift and runs
`scripts/check-open-source.sh`.

### Version stamping

`build.rs` stamps `agent_relay_probe::VERSION` (what the daemon reports in its
bridge handshake, telemetry and Relaycast `origin_version`):

| Build                                         | `VERSION`                                                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `AGENT_RELAY_PROBE_VERSION=X` set             | `X` exactly: a relay release passes the relay version, relay-desktop passes its CalVer (`2026.10.58`)                  |
| unset, `AGENT_RELAY_PROBE_BASE_VERSION=B` set | `B-dev+<git revision>`: relay-desktop passes its newest CalVer so development cores still order below the next release |
| neither                                       | `<crate version>-dev+<git revision>`                                                                                   |

The internal Cargo package version is never reported as a release on its
own. On Windows, `AGENT_RELAY_WINDOWS_ICON` additionally embeds an icon and
version resource, as before.

### The bridge contract

The bridge's methods, events and types are declared once in Rust
(`src/relay/contract`). `relay-contract-codegen` turns the registry into
Swift:

```sh
crates/probe/scripts/generate-contract.sh                        # crates/probe/contract/CoreContract.swift
crates/probe/scripts/generate-contract.sh --app-root ../relay-desktop  # relay-desktop's macos/Sources/RelayDesktopCore/CoreContract.swift
crates/probe/scripts/generate-contract.sh --out /tmp/CoreContract.swift
```

## How relay-desktop consumes the core

relay-desktop keeps the apps and depends on this crate instead of carrying
its own copy:

- **Rust (GTK app):** the Linux/Windows app becomes its own crate that
  depends on `agent-relay-probe` as a library (a git dependency pinned to a
  relay tag or commit, `default-features = false` to skip the binaries) and
  imports `agent_relay_probe::{install, session_model, relay::…}`.
- **Daemon binary:** the apps bundle `agent-relay-probe` built from this
  crate with `AGENT_RELAY_PROBE_VERSION=<desktop CalVer>`, or the binary from
  a relay release once relay publishes it.
- **Swift (macOS/iPad):** `CoreContract.swift` comes from
  `contract/CoreContract.swift` (or `generate-contract.sh --app-root`).

One core runs per machine: whichever installed it (the relay CLI or a desktop
app), the apps attach to the running daemon's socket.

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
automatically, after 1 s doubled per consecutive attempt plus up to a fifth of
jitter: a transient failure's wait stops growing at five minutes
(`TRANSIENT_BACKOFF_CEILING_MS`), so a receiver that recovers from a long
outage is tried again within six, and a rate limit's at an hour, with a later
`retry_after` still standing. An explicit retry (`retry`, the app's **Retry**)
also ends a transient wait early; it leaves a rate-limited wait alone. HTTP 404 blocks rather than falling back to another protocol.
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
