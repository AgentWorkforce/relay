# Native Agent Relay Probe

> Imported from relay-desktop with the core (see `docs/probe-move.md` at the
> relay repository root). Paths written `probe/…` here mean `crates/probe/…`;
> the macOS, Linux and Windows apps (`macos/`, `probe/src/linux_app`,
> `windows/`) and the documents cited as "relay-desktop" stay in relay-desktop.

`agent-relay-probe` is the native collector for Cloud's new Teams onboarding flow.
It signs a computer in, obtains workspace-scoped RelayHistory credentials, captures
local coding sessions and runs durable delivery in the background. It needs no
Node.js, npm, NAPI addon or separately installed Agent Relay CLI.

## Source ownership

The probe lives in [`crates/probe/`](../) of the relay repository; the desktop apps bundle it.
It reads local history through the published `ai-hist` crate and owns its upload
queue, worker, sharing policy, sign-in and transport. Where sessions live and
how they are parsed stay in `ai-hist`.

`--version`, `status --json`'s `probe_version` and the `cli_version` it reports
are the desktop release the binary ships in: `scripts/build-probe.sh` stamps
`AGENT_RELAY_PROBE_VERSION` at build time. A plain `cargo build` reports the
crate version.

## Build and run

```sh
cargo build --manifest-path probe/Cargo.toml --release --bin agent-relay-probe --locked
probe/target/release/agent-relay-probe --help
```

For local Cloud development, run in your own terminal:

```sh
./agent-relay-probe cloud install --site-url http://127.0.0.1:3100 --workspace WORKSPACE_ID --account USER_ID
```

The account argument asserts the expected signed-in user; it does not grant
access. The workspace bridge authorizes membership and issues the scoped session.
Without a workspace argument, the probe uses Cloud's current workspace.

Setup prints the existing Cloud device-approval URL, waits for browser approval,
then offers selected-session uploads as the default. Pressing Enter keeps all
sessions local until selected; automatic uploads of new sessions or all history
remain explicit choices. `--selected-sessions-only`, `--new-sessions-only`, and
`--include-existing` make the choice explicit in a noninteractive terminal.
`--force-login` bypasses eligible existing CLI sign-in.
The shared implementation reuses an unexpired official CLI credential only for
the exact selected Cloud URL, and never writes or refreshes that CLI's auth
file; `CLOUD_API_ACCESS_TOKEN` overrides both. Setup always prints the approval
URL to stdout rather than requiring a terminal on stdin, because the composed
local harness drives it through pipes.

New-only mode snapshots every session identity the store holds evidence for —
catalog rows, prompts, events and every other evidence table, including
sessions not yet catalogued — before creating its delivery generation. The
baseline is stored as durable delivery exclusions, which
the coordinator rechecks whenever a batch is prepared, claimed and dispatched,
so it does not grow the delivery configuration with local history. A setup
abandoned between that snapshot and its delivery generation leaves the baseline
behind; a later setup that chooses to share existing sessions withdraws it, so
the choice that takes effect is always the one just made. Sessions
discovered later are treated as new; this is a local capture baseline, not a
guarantee about the actual creation time of files added later. The saved sharing
choice is immutable on reconnect: a different explicit choice is refused, and
`--keep-saved-sharing` makes the choice given apply to a new install only, so a
reconnect keeps the saved one.

Default setup starts a detached process. `--foreground` keeps it in the terminal;
`--once` captures and delivers one bounded cycle. To inspect or stop it:

```sh
~/.local/bin/agent-relay-probe status --site-url http://127.0.0.1:3100 --workspace WORKSPACE_ID --account USER_ID
~/.local/bin/agent-relay-probe stop --site-url http://127.0.0.1:3100 --workspace WORKSPACE_ID --account USER_ID
```

The executable must already be at that location to use these example paths.
There is no launchd/systemd installation or automatic restart after reboot yet.
Run setup again after restarting the machine. It preserves the existing queue.

### Hosted teardown flush

Cloud sandbox teardown invokes the hidden `history flush` command with a
push-only session on stdin (or in a session file), a private state directory,
and an absolute wall-clock budget. The state path should normally not exist so
the probe can create it as `0700`. If Cloud creates it first, it must already
be an empty same-owner `0700` directory; a conventional `0755` temporary
directory is deliberately refused rather than silently made private after
another process could have observed it.

stdout is exactly one JSON summary line on success, refusal, usage error, or
deadline. The command exits at the deadline plus a 250 ms watchdog grace even
if the HTTP library is stuck below its request timeout (for example in DNS).
The pushed bearer is fixed to that invocation: a 401 is final and never causes
the probe to read, refresh, or overwrite a stored desktop credential.

The state directory may be retained to resume the same durable queue. If Cloud
instead re-flushes the same provider history into a fresh state directory, the
new store has a new origin and origin-bound revision IDs, while logical
`record_id`, source `revision`, and payload remain stable. RelayHistory stores
both origin-scoped deliveries; its downstream projection uses the stable
logical identity to deduplicate what readers see.

## Indexing order

Both desktop apps start new installs with selected-session uploads. Discovery
lists metadata newest first without fully indexing or uploading unselected
sessions. Reconnecting preserves the workspace's saved sharing choice.

For automatic-upload modes, the probe first discovers the catalog and fully
indexes uncaptured sessions in descending last-activity order across providers
and shared Claude folders: the last 24 hours, the rest of the week, then older
history. Completed sessions are skipped if that backfill is interrupted. A
regular provider sweep follows to capture sessionless evidence and retry any
sessions that could not be hydrated individually. Providers without usable
catalog metadata or targeted hydration still rely on that sweep.

## State and delivery

Uploads come from `ai-hist`'s change feed. An all-sources job drains every
change of its kinds from the feed's start, which is its bootstrap, and then
follows the feed from where it stopped. A selected-sessions job follows the
feed for its members only; each member added is backfilled with a drain of
its own session from the feed's start to the head at the time it was added.
Nothing is copied out of the evidence tables until a batch is prepared, so
there is no upload journal, retention cap or compaction of pending history.
Selected-session delivery runs before targeted hydration and independently of
unrelated provider discovery.

A record keeps the identity the receiver already holds: `record_id` is the
SHA-256 of the record's key (its kind and the stored values of its table's
identity columns) as compact JSON, and `payload` is the stored row. Its
`revision` is the feed revision plus the install's `revision_base`, which stays
above every revision the install has issued, so the receiver always replaces
an older copy. A replaced database, whose feed counts from zero again, moves
the base above the highest revision issued and restarts every job. A new
epoch of the same feed, as `ai-hist` draws when it retires a kind without
renumbering anything, keeps every job where it was: the install adopts the
epoch once `SessionStore::resumes_from` confirms that the highest position its
upload tables hold still names the same revision, asked of each kind's stream
on its own, since the probe stops draining a retired kind itself.

A batch holds at most 100 records, the protocol's limit, and at most 2 MiB
less 64 KiB of JSON, so with its request envelope it stays under the
receiver's 2 MiB request cap. A server that publishes its limits in its
receipts (`limits: {maxRecords, maxRequestBytes}`) raises the record cap for
the batches prepared after that receipt, up to 500, and can lower the byte
cap; a receipt without them returns to 100, and a batch already prepared is
sent as it is (see the probe README); its body as retained in the queue, which
escaping can double, may take up to 4 MiB plus 64 KiB. A batch is sized as it
fills, one record at a time. A delivery generation created by an older build
with that build's defaults (1 MiB batches) runs with these; its stored
configuration is left as written.

A record too large for a batch on its own, such as a tool result that printed
megabytes, is shortened to fit rather than stopping the job. Its longest text
columns are cut, longest first, and end with `[truncated by Agent Relay to
fit the upload limit]`. A column holding a JSON document is cut inside, at its
longest strings, so it stays valid JSON. A row with a `payload_truncated`
column has it set, while `payload_bytes` and `payload_hash` keep describing
the original. The record keeps its `record_id` and `revision`. A record whose
bulk is not in text it can cut is suppressed like withheld evidence, and the
job moves past it. A batch that cannot be prepared for any other reason is
reported as `upload_preparation_failed`, not as an offline sync.

Before a request is persisted or sent, every direct payload column whose name
ends in `_json` is decoded as a JSON document. U+0000 in its keys or values and
unpaired UTF-16 surrogate escapes are replaced with U+FFFD, then the document
is encoded again. Invalid JSON text is preserved as an opaque JSON string, so
the receiver can store it without dropping its readable content. If repairing
a legacy prepared body makes it exceed the wire limit, the opaque value is cut
with the same visible truncation marker (and `payload_truncated` is set when
that row has the flag). Ordinary text
columns do not interpret typed `\u0000` text; only an actual U+0000 is replaced.
Clean request bodies remain byte-for-byte identical. This wire check also
repairs prepared bodies persisted by older builds, without changing record IDs,
revisions, or the stored batch. The worker stores each body it prepares with
the build that prepared it (version and Git revision); a body this build
prepared, whose SHA-256 still matches, is already in wire form and is sent
without being decoded and checked again. Every other body is checked before
it is sent.

Every sharing mode uploads every evidence kind: prompts, session events, tool
calls, file edits, the session catalog, presences, relationships, commit links,
connector observations and their evidence, and session markers. Trajectories
are no longer uploaded: a job stored by an earlier build that still lists them
drops the kind when it is loaded, and a batch it had already prepared with
trajectory records is still sent.
What a mode withholds is consent, not kinds. `all` shares every session that
is not excluded, and prompts logged with no session. `new` withholds the
sessions its baseline excluded and every prompt with no session, since no
exclusion can prove when such a prompt began. `selected` shares only member
sessions. A relationship discloses both its sessions, so it leaves only when
its parent is shared and its child is shared too or unlinked, checked when a
batch is prepared and again before dispatch. Under `selected`, a member added
after its parent receives the edges naming it through its own backfill.

A build whose `ai-hist` reads a newer schema than local history holds
migrates it only in the collector, the process that holds the collector lock.
On a large store the migration runs for minutes. The desktop runs `status`,
`sessions list`, pause, resume and compaction under timeouts, and a migration
they start and then get killed out of rolls back while holding off the
collector, so none of them migrates: `status` answers with `last_cycle.error_class`
`upgrading`, and the others refuse with the same safe message until the
collector has finished. A migration that fails after readiness (a full disk,
a damaged store) does not end the run: it reports the classified cause as that
run's `last_cycle`, which `status` then shows in place of `upgrading`, and
retries, withdrawing that report once the store opens. When `status` cannot
read the store at all (it cannot open it, or a table is damaged), it answers
with the profile and that report alone rather than failing. `status` and `sessions list` also ask the change feed,
since a store that predates only the feed opens and lists sessions as before.
The collector records readiness before it opens the
store, so setup's startup wait cannot kill it mid-migration either. It also
records the build that launched it in `runtime.json`; `status` reports
`collector_outdated` when that is another build, and `start` stops such a
collector and launches the bundled one, which the desktop does on its next
status read after an update. Replacement uses the collector's
generation-scoped cooperative stop and waits through a long capture, subject
to a ten-minute bound rather than the interactive stop command's 45-second
deadline. If that bound expires, the command hands ownership to a detached
helper; it keeps the generation-scoped stop, waits for the old collector to
release its lock, and starts the bundled build. This covers a stop already
consumed by a long capture instead of leaving the install stopped. While a live
replacement or its helper owns the desktop control lock, status reports
`collector_replacing`; desktop apps show **Replacing the uploader** and do not
start a competing replacement. Sharing changes wait without a client deadline
because the same command that stops the collector must apply the change and
restart it.

An install whose uploads ran on the former `export` journal is rebuilt the
first time its collector opens it, in one transaction: it keeps `origin_id`
and records `revision_base` from the journal's sequence, drops the journal's
capture triggers, tables and indexes and every unsent batch, and restarts each
job from the feed's start and each member's backfill, keeping sharing mode,
pause state, members and exclusions, and moves each job's stored selection to
every kind. Only the collector lock's holder
rebuilds; pause, resume and compaction never do, so they are safe beside an
older collector still running after an upgrade.

The desktop status `last_cycle` includes an optional, allowlisted `error_class`
and a safe message for database corruption, disk-space, contention, and
permission failures. These also cover failures before capture starts. No raw
SQLite/provider error, transcript, credential, or path is included. Capture
and delivery are reported separately in `last_cycle.capture` and
`last_cycle.delivery`, each with its own `ok`, `error_class` and message: a
pass that only delivered reports its own delivery outcome and leaves the last
capture verdict standing, so a condition the capture cycle measured stays
visible between those cycles. Each report names the collector run that wrote
it (`startup_id`), and a run carries forward only its own capture verdict:
`status` shows `last_cycle` only when it is the report of the run
`runtime.json` names, so a restarted collector never inherits the previous
run's verdict while its first capture pass, minutes long on a large history,
is still running. Capture runs on its own thread from the start of the run
(see [Live capture](#live-capture)). A run reports as soon as it has opened
the store, before capture or delivery has observed anything, so a run stopped
during its first sweep still leaves a report of its own; each delivery pass
then reports the capture thread's latest verdict. The top-level `ok`, `error_class` and `message`
are the effective verdict — the capture fault when there is one, otherwise the
delivery fault. Database corruption requires separate recovery from a
preserved copy; the collector does not delete or recreate a damaged queue
automatically.

A pass that drained also reports `last_cycle.delivery_metrics`, numbers only:
`drains`, `drain_ms`, `batches_sent`, `bytes_sent`, `batches_acknowledged`,
`records_acknowledged`, `batches_per_second`, `records_per_second`,
`send_ms_total`, `send_ms_mean` and `send_ms_max` (time inside the request,
per batch), `queue_ms_max` (the longest a batch waited from preparation to
acknowledgment), `event_lag_ms` (how long before its acknowledgment the
newest delivered record was written, by the record's own `ts_ms` or
`timestamp_ms`: end-to-end lag, from the agent writing a line to the
receiver acknowledging it, once the job keeps up, now that capture follows
filesystem events; the age of the history reached during a backfill), and
the queue the pass left, `pending_records`,
`unqueued_changes` (counted up to 256) and `oldest_pending_age_ms`. `status
--json` also reports `delivery.oldest_pending_age_ms`, how long the oldest
unacknowledged batch has waited. Pipelined delivery adds `in_flight_limit`
(the most batches a pass may keep in flight, 4), `max_in_flight` (the most it
did) and `batches_retried` (batches claimed again after an earlier attempt
that did not acknowledge them: a retry, or a resumption after a stop).

Every pass report also carries `last_cycle.capture_metrics`, the capture
thread's counts since the run started, numbers and fixed labels only: `mode`
(`watch`, `timer` or `members`), `driver` (`fs-events`, `polling`, `timer`,
`member-events` or `member-poll`), `fallback_reason` (see [Live capture](#live-capture)),
`watching_since_ms` (when the watcher attached),
`ticks`, `ticks_by_trigger` (`fs-event`, `poll`),
`ticks_swept`, `ticks_unchanged`, `ticks_contended`, `ticks_failed`,
`ticks_waking_delivery`, `sessions_changed`, `sweeps` with `sweep_ms_last`
and `sweep_ms_max` (the sweeps the thread runs itself: the first, the forced
catch-up once the watcher is attached, and each one of the timer fallback),
`tick_ms_last` and `tick_ms_max` (how long the watch's own sweeps took),
`ticks_paced` and `duty_wait_ms_total` (the event sweeps that waited past
their debounce for the pace, and how long they waited in all), `capture_lag_ms` and `capture_lag_ms_max` (from the
modification time of the newest transcript a tick captured to that tick's
report: debounce, pace, sweep and hand-off together), selected mode's `hydrations`
and `member_polls_changed` (the rounds that hydrated a member), and `last_capture_ms`.
A tick is one sweep of the watch: `fs-event` for an event's, `poll` for the
backstop's or the polling driver's.

Each `(site origin, user, workspace)` has an independent SHA-256-named directory
under `~/.agentworkforce/probe/`. It contains an SDK-owned `history.db`, persisted
selection/job metadata, scoped RelayHistory auth, a log, a runtime record and a
collector lock. Directories are mode 0700; credentials/config/logs are mode 0600.
On macOS and Linux, `collector.log` stays in this private install directory so
diagnostics survive restarts. It rotates at 10 MiB, retaining three older files
(`collector.log.1` through `.3`, newest first). A dedicated thread checks once a
second, including during long capture/delivery passes and shutdown, and moves
both output streams to the fresh log. Retention is approximately 40 MiB per
install; a file can exceed 10 MiB by the output written between checks. Rotation
is best effort when the filesystem is unavailable. A temporary directory would
not provide this retention policy and could lose diagnostics on reboot.
No Cloud bearer credential is persisted by the probe. Tokens are never command
arguments, and provider errors, response bodies and session content are not logged.
The device approval URL is intentionally displayed in the interactive terminal.

Each pass delivers through the probe-owned Rust worker, with up to four
batches of the job in flight: the next batch is prepared, persisted and
validated while the others are on the wire. A pass is bounded by wall time
(15 s), so it moves as many batches as the destination accepts in that window;
while the active job has queued batches, unexamined feed changes or an
unfinished backfill it can attempt now, and the pass acknowledged some, the
next pass starts at once, so a backlog drains back to back. A pass that moved
nothing while that backlog remains (it failed, or the destination accepted
nothing) is followed 2 s later, and passes run 20 s apart once the job is
caught up, paused, or waiting out a retry deadline, unless the capture thread
wakes the loop first: a capture tick that wrote starts the next pass at once.
A pass reads the job's
status once for its own checks, and the queue its last drain left decides the
next pass's gap, so passes do not each re-read the change feed. Capture runs on
its own thread and never waits for delivery, and delivery never waits for a
capture sweep: a backlog only means the drain is busy, and new local activity
is captured and queued behind it as it happens. Stop requests are polled
between batches. Consecutive batches reuse
kept-alive HTTP connections and the stored session, which is read again near
its expiry or after a failed send, and a drain opens local history once
rather than per batch. The job's acknowledged position only moves through a
contiguous run of acknowledged batches: a batch that fails while later ones
are acknowledged holds the position back, the later ones stay delivered, and
the failed one alone is retried after its backoff (see the probe README).
A selected-sessions job pipelines the same way: its member backfills share
the job's feed end, so the acknowledged position reaches that end only once
every batch ending there resolves. The relayhistory-cloud
server projects a workspace's batches one at a time, so concurrency mainly
hides network latency and the probe's own preparation; throughput is bounded
by the server's time per batch. The worker owns
immutable batches, leases and their keepalive, prepared-byte persistence, the
eligibility recheck immediately before dispatch, retry/backoff, acknowledgment
and receipt compaction; the receiver owns only the consent and destination guards and
the transport, so progress advances only on a validated receipt. Mapping/account
mismatches block delivery. A failed attempt retains unacknowledged data and the
job waits out its own backoff, which is normal operation rather than a fault.
Transport credentials refresh through the existing RelayHistory auth
implementation. The stored `rth_*` pair is only a cache of what the Cloud
workspace bridge issued: when it dies (a revoked, expired or lost one-time
refresh token), the job blocks on `authentication_required`, and the collector
then asks the workspace bridge for a new session with Agent Relay's own sign-in
— `CLOUD_API_ACCESS_TOKEN`, else the official CLI's credential for the same
Cloud, else the desktop app's kept `cloudSession`, each with more than a minute
left. It asks Cloud at most once every five minutes; finding no sign-in asks
nothing, so it is checked on every pass. It never starts a device login in
the background, and it adopts the new session only when it names the same
history stage, organization and workspace; on success the job resumes with its
queue intact. Otherwise it stays blocked and `status --json` keeps reporting
`authentication_required` with `last_acknowledged_ms`, plus
`delivery.renewal_failure` — `no_cloud_session`, `cloud_refused`,
`cloud_unreachable` or `wrong_destination`, kept in the install's
`renewal.json` — and a fixed sentence naming that cause in `delivery.failure`.

A receiver HTTP 400 or 422 is treated as a possible record-content rejection.
For a multi-record batch the adapter sends deterministic halves, within a
32-request ceiling. It suppresses a rejected singleton only after a sibling
batch has received a complete durable receipt. Rejected siblings are both
searched, so several bad records can be isolated. Accepted IDs, proven skips,
provisional singleton rejections, and the exact unfinished search frontier are
saved separately on the immutable pending batch whenever the request or time
ceiling interrupts that search; the next attempt resumes those subsets instead
of repeating the same traversal, guaranteeing progress across restarts even
when no accepted sibling or singleton was reached yet. Provisional rejections
never increment the skipped count or advance the cursor. A receiver-wide
rejection that accepts nothing, or an original singleton with no accepted
sibling, remains blocked rather than becoming silent record loss; an explicit
or new-build retry clears provisional rejections so a corrected receiver can
try every record again. Other 4xx responses,
authentication and permission failures, rate limits, oversized requests,
transport errors and 5xx responses are never isolated. Split batch IDs are
derived from the immutable parent ID and exact revision IDs and rely on the
receiver contract's revision idempotency. Receiver-declared
`unsupported_revision_ids` retain their protocol meaning and block for a later
receiver upgrade. All locally omitted records still increment the internal
`suppressed_records` accounting counter, while only receiver-isolated records
increment `skipped_records`; desktop status uses the latter so consent and
selection exclusions are never described as receiver skips. Logs include only
the HTTP status, a validated receiver error code, correlation hashes and counts
— never response bodies or record content.

An HTTP 409 is recoverable only when `error.code` is exactly
`delivery_conflict` and the receiver supplies the protocol's complete typed
identity and digest detail. The probe compares every reported record with the
exact persisted request body. It atomically archives the attempted batch,
quarantines only verified conflicting revisions, and queues the remaining
records under a deterministic new batch ID. A batch-ID conflict re-keys all
records without quarantining any. Revisions are never raised to defeat the
receiver's fence. The transition, prepared child body, and quarantine evidence
survive a restart; later records keep draining. Missing or mismatched details
block with `delivery_conflict` rather than silently skipping data. Progress
reports the quarantine count and a delivery-conflict phase, and
`agent-relay-probe conflicts` lists affected record and revision IDs without
printing content. A corrected source row must first receive a new change-feed
revision. `status --json` reports `delivery.quarantined_records`; keep
`history.db` when asking support to inspect the archived attempt.

Each new probe version retries a previously blocked job once, before setup
delivery or background collection begins. Later starts of that version preserve
its blocked verdicts. SQLite retains every `(job, build)` retry record and commits
it atomically with the retry, so detached collectors, restarts and an A→B→A
version rollback cannot grant a second attempt. The former `retry_build` column
is imported into this history and maintained for older probes. File markers are
imported only when `verdict-retry.json` explicitly names the same job; unscoped
markers cannot safely identify a generation and are ignored. New jobs start
their own retry history. Failure to save the compatibility file does not stop
collection. If the database transaction fails, automatic recovery is deferred
without committing either the retry or its build record. Paused and cancelled
jobs remain unchanged.

Local capture progress is written to private `progress.json` and emitted as
`event: "progress"` on the desktop install JSON stream every three seconds.
The count of captured sessions walks the whole catalog, so a report reuses a
count up to 30 seconds old, and the end of a capture pass counts afresh; while
a backlog's bootstrap is still running, a report does not scan the change feed
for unqueued changes, which cannot change what it shows.
Source names, files processed/total, and sessions captured never leave the Mac.
Cloud heartbeats contain only delivery progress for permitted records; the legacy
capture fields are empty/zero for wire compatibility, and capture-only monitors
never send heartbeats. Changed delivery progress reports at most every three
seconds. Completion and failure transitions report immediately. Unchanged delivery
progress uses a jittered 270–330 second presence heartbeat; empty background
cycles do not produce extra requests. Failed reports retry no faster than every 30 seconds,
except for a new terminal transition or explicit setup/one-shot confirmation.
Cloud determines whether session data has actually arrived. A running process
alone does not mark the dashboard's data step complete.

An OS file lock permits one collector per destination directory. Stop requests
carry the startup identity, so an old stop file cannot stop a new run. There is
no signaling of arbitrary stored PIDs; startup timeout terminates only the child
process launched by that setup invocation.

Setup and every delivery pass check legacy managed launchd/cron uploaders
without changing them, and the receiver applies the verdict before mapping a
batch and again before sending it, inspecting again once its verdict is 60
seconds old; the collector's passes share one verdict, so back-to-back passes
inspect at most once a minute (see the probe README's legacy scheduler guard). An active old
uploader blocks setup and delivery. An
unavailable inspection requires the explicit `--acknowledge-uninspected-schedules`
flag after the user has checked their older schedules. Arbitrarily named/manual uploaders are not discoverable by this check.

## Live capture

A line an agent writes to its transcript reaches the receiver within about a
second of the write (p50 about 520 ms, p95 about 1 s on a loopback receiver
with appends half a second apart, against 60 s under the former capture
timer). In `all` and `new` sharing modes the collector's capture thread runs
one full, cancellable sweep of local history (waiting, if another process's
sweep holds the store's sync lock, rather than failing), then registers its
own filesystem watcher over every path `ai-hist`'s watch covers (filtered by
its own `WatchedPath::admits`, as selected mode's inventory is). Once the
watcher is attached, the thread sweeps once more, forced past the stat-only
source fingerprint so each session's own stamp decides what is read, as an
event's sweep is: it reads whatever was written while the first sweep ran,
which no watcher was there to report. From then on every write is an event,
so nothing written after the collector started waits for the backstop.

- A write under a provider root (FSEvents on macOS, inotify on Linux, through
  `notify`) owes a forced sweep. It runs once a 200 ms debounce has passed
  (`live::WATCH_DEBOUNCE`) and the pace allows: the next sweep starts no
  sooner than 10 times as long as the last one took after it ended
  (`live::SWEEP_DUTY_FACTOR`), and never sooner than 1 s
  (`live::SWEEP_MIN_GAP`), so capture holds at most about a tenth of a core
  however busy the providers are. A live session writing its transcript
  every couple of seconds used to drive a full sweep for every write, back to
  back; it is now swept about once a second while sweeps are cheap, and at
  ten times a sweep's cost apart when they are not. Events that arrive while
  a sweep waits or runs are one sweep. Reads and metadata changes (opening a
  provider's database, its `-shm` index) are not writes and ask for nothing.
  A rescan (an inotify queue overflow, FSEvents reporting dropped events),
  which names no path, a write event naming none, or a watcher error owes
  the same forced sweep of every provider, and the watcher is registered
  again before it.
- Each sweep that swept or changed a catalog row wakes the delivery loop,
  which drains at once instead of at its idle cadence.
- The backstop runs when no sweep has for 60 s
  (`live::CAPTURE_BACKSTOP_INTERVAL`): the same fingerprint-checked sweep the
  former capture timer ran, for writes a platform never reports (network
  mounts, some container filesystems). Before it, the watcher is registered
  again if that would watch more: a provider root that did not exist yet, or
  one whose registration failed. The backstop also bounds the pace, so a
  change waits at most 60 s for its sweep however costly sweeps have become.
- When no filesystem watcher can run, the loop polls at that same 60 s
  cadence, which is the former timer, and `capture_metrics` says why in
  `fallback_reason`: `fs_events_unavailable` (the backend could not attach:
  no backend, too many watches, `EMFILE`), `no_provider_roots` (nothing to
  attach to yet), or `disabled` (`AGENT_RELAY_PROBE_FS_EVENTS=0` in the
  collector's environment). If the store cannot be opened for the watch, the
  thread runs the timer itself (`mode: timer`, `fallback_reason:
  watch_unavailable`). Each change of driver is logged as one content-free
  JSON line.

The detached collector (`run`, the session collector the relay core and
`start` launch; in the Mac app it runs as the bundle's `Agent Relay Helper
(Sessions)` hard link, a sibling `<core> (Sessions)` file being preferred
whenever one exists) is a background process as a whole: on macOS a Darwin background
process (`PRIO_DARWIN_BG`), whose CPU, disk and network use the system
throttles; on Linux nice 19, set on its main thread before any other starts
so every thread inherits it. A sweep and its delivery never compete with the
agent writing the transcript it reads. In a process that stays at normal
priority (a `start --foreground`), the capture thread and selected mode's
inventory thread alone run at background priority (the background QoS class
on macOS, which also throttles their disk I/O; nice 19 for the thread on
Linux). The relay core itself keeps normal priority: the agents it starts
would inherit a lower one. A platform that refuses either change is logged as
one content-free JSON line (`stage: process_priority` or `thread_priority`)
and capture runs as before.

Every sweep is the same locked sweep as a full capture: it takes the store's
sync lock itself, so `ai-hist`'s one-writer rules hold unchanged; one that
finds the lock held reads nothing and, if it was an event's, is retried at
the pace, at least a second apart. Delivery runs beside it on its own
connections, reading the change feed and writing only its upload tables;
SQLite's WAL lets the feed be read during a sweep, and the busy handlers on
both sides (`ai-hist`'s retrying handler and the delivery connection's 30 s
busy timeout) outlast a capture transaction, so neither side reports a
locked database. Writes from the two threads overlap in tests without a busy
error.

A stop request ends the capture thread promptly: every sweep, the startup
sweep and each event's or backstop's alike, is the store's own cancellable
`sync`, and stops at its next provider, file or record boundary. The
collector lock is released only after the thread has ended. While the
startup sweep reports its file counts, delivery passes leave `progress.json`
to it, so the desktop is not switched between the two every few seconds;
Cloud heartbeats, which carry delivery only, are unaffected.

Selected mode does not run this watch, whose sweeps enumerate every provider;
it watches only its members' transcripts. See
[Desktop bridge v1](#desktop-bridge-v1) for its member-scoped hydration.

## Companion changes and distribution

The probe depends on:

- **Cloud:** device start/token/approval, `auth/whoami`, and the authenticated
  workspace `relayhistory/session` bridge. The bridge returns an RTH sync session.
- **RelayHistory service:** existing durable `/v1/delivery/batches` and the new
  `/v1/onboarding/heartbeat` endpoint. The dashboard also uses the companion
  onboarding-status route. These server changes live in their own repositories.
- **agentrelay.com:** site-root `/install.sh` and platform downloads. The installer
  should select the OS/architecture, verify SHA-256, install atomically to
  `~/.local/bin/agent-relay-probe`, and invoke `cloud install` with the dashboard's
  site/account/workspace. A checksum from the same origin detects corruption;
  it is not a separate publisher signature.
- **Official Relay CLI:** an optional `agent-relay cloud install` alias may delegate
  to the installed probe. The native onboarding path does not depend on it.

### Distribution

The desktop release workflow builds the probe for macOS (arm64, x64) and Linux
(x64, arm64 glibc) and bundles it into the app and Linux packages; there is no
standalone probe download. `probe-version.txt` beside each build records the
version it reports.

## Verification

```sh
cargo test --manifest-path probe/Cargo.toml --bin agent-relay-probe --locked
cargo test --manifest-path probe/Cargo.toml --lib cloud:: --locked
```

`probe/tests/live_capture.rs` runs the collector against a synthetic home and
a loopback receiver and requires a transcript line to be acknowledged within
seconds; `LIVE_CAPTURE_APPENDS=10` prints the latency of each of ten appends
with p50 and p95, `LIVE_CAPTURE_BINARY` measures another build, and the
ignored `idle_cost` test reports an idle collector's CPU time.

Regression tests cover Cloud's `201 Created` device grant, authorization polling,
origin binding, official-CLI credential reuse, sharing choices, complete exclusion
pagination, private atomic state, collector locking and stale stop requests. The
sign-in tests live with the shared implementation, in the library's `cloud` module.

For a composed local test, start the companion marketing proxy on 3100, Cloud
on 3101 with its development-only Teams login and a local DB, and the local
RelayHistory service. Then:

```sh
node scripts/test-probe-local.mjs --binary /absolute/path/to/agent-relay-probe
```

Node is used only by this test harness. The child probe gets a fresh synthetic
home and `/usr/bin:/bin` PATH with no inherited provider credentials. The harness
approves its own development device grant, sends a uniquely identified synthetic
Claude session, reads that exact stored session, checks Cloud's `receiving` state,
verifies private storage and stops the collector. It keeps credentials and the
captured approval URL out of the test output, then removes its fixture directory.
It refuses remote origins and must never run against production.

## Desktop bridge v1

The macOS companion uses `agent-relay-probe` for authentication, local credential
storage, capture and delivery. All bridge commands accept `--json`; every JSON
object has `bridge_version: 1`. Status output contains no credentials. Existing
human-readable install/status/stop commands remain available.

- `installs --json`: discover configured probe directories. Every directory
  with a `config.json` is listed, whatever this build can read of it:
  `upgrade_required` marks one a newer probe set up or last ran,
  `collector_version` names the build that last ran its collector, and
  `paused` is null when this build cannot read its store.
- `cloud install --json --include-existing|--new-sessions-only|--selected-sessions-only`:
  emit NDJSON `approval`, `authenticated`, `connected`, and `ready` events. The
  browser approves the device; `authenticated` establishes the Agent Relay
  login boundary before the probe provisions RelayHistory upload credentials.
  `connected` confirms those upload credentials are stored. JSON setup requires
  one explicit sharing choice and runs in the background. Reconnecting a
  workspace whose collector is running stops that collector and starts this
  build's when setup completes, or restarts the stopped one if setup fails. A
  collector a newer probe runs or last ran is left alone, and setup and
  `start` ask for an update. The desktop apps sign in with
  `--selected-sessions-only --keep-saved-sharing` (`account.sign_in` with
  `sharing:"selected"`): a fresh install uploads nothing until a session's
  Upload switch is turned on, and an enabled session keeps uploading as it
  changes, while signing in again to a workspace already set up here keeps
  its saved choice (`new` or `all` included) rather than refusing it. Settings ›
  Session sharing still offers `new` and `all` (`sharing set`). Selected
  setup reads no transcript; it runs one shallow catalog pass of the newest
  1,000 sessions into the install's store (`SETUP_CATALOG_LIMIT`, metadata
  only, as the pre-install preview reads) before it reports ready, so the
  session list is filled the moment the app attaches rather than once the
  collector's first inventory pass has run.
- `start`, `status`, `pause`, `resume`, `disconnect`, `compact`: pass
  `--account ID`, `--workspace ID`, and optionally `--site-url URL`, plus
  `--json`.
- `compact <target> --json`: releases every settled batch receipt, under the
  desktop control lock. Pending and unacknowledged batches are untouched, so it
  is safe while the collector runs. It returns the receipts removed:

  ```json
  { "removed_records": 42 }
  ```

- `sessions list <target> --json --limit 500`: newest sessions with title,
  source, project path, activity and upload status. `uploading` means a record
  from the session is in a currently leased batch; `queued` means a pending
  batch. `uploaded` means the job has examined every change of the session it
  sends and none is in an unacknowledged batch, even while the rest of the
  backlog is still draining: each listed session is one indexed read of its own
  changes after the job's position (or, for a member still backfilling, not yet
  uploaded; nor is a member that parents a relationship to a member still
  backfilling, whose backfill sends that edge). The job's positions are read
  before its pending batches, so a batch prepared during the listing is either
  seen or still ahead of those positions. `shared` is used while a session has
  changes still to examine. `checking` is used for an enabled session the
  listing's five-second budget did not reach: it is neither proven uploaded
  nor known to be waiting, and the apps show it as "Checking…" outside the
  in-progress count. A listing keeps each proof in `session-status.json` beside
  the store, with the feed head it holds through, so the next listing re-reads
  only sessions changed since: one scan of the feed from the oldest proof finds
  them. An all-sources job whose position is close to the feed head is decided
  by one scan from that position instead of a read per session. A proof is
  dropped when the job, its generation, selection, members or the stored
  exclusions change, when the feed epoch changes, or when the job's position
  moves back; an unreadable file only costs a slower listing.
- `sessions include|exclude <target> --json --session SOURCE:ID …`: explicitly
  share one session or a batch, or stop sharing them. This does not erase
  already uploaded history.
- `sharing set <target> --json --mode all|new|selected`: share everything,
  establish a new-only baseline, or share only explicitly selected sessions.
  Previously selected sessions are retained across mode changes.
- `sharing status [--site-url URL] [--account ID --workspace ID] [--json]`:
  what each install on this computer shares, from each install's
  `config.json` alone, so it answers while a sync holds local history. With no
  account and workspace it lists every install (optionally only one site's);
  with both it names that install, on `--site-url` or agentrelay.com, and fails
  when it is not set up here. Each entry has `directory`, `site_url`,
  `account_id`, `workspace_id`, `sharing_mode`, `change_pending` (a
  `sharing-change.json` is still being applied) and `upgrade_required`: an
  install a newer build set up is listed with `sharing_mode: null`. Plain `status <target>` ends
  with a `Sharing:` line naming the same mode.

Selected mode uses the core's normalized, deny-by-default session membership.
A subagent or child thread is part of the session that delegated work to it,
not a session of its own: the session list does not offer it, it cannot be
selected or withheld on its own (`sessions include`/`exclude` refuse it and
name its session), and it is shared with its session. Hydrating a member
captures its delegated work with it, and after each hydration round the
capture thread makes every delegated descendant of a selected session a
member too (`delegated` in `delivery_session_members`), backfilled from the
feed's start like any member and dropped, fenced, when its session is
deselected. Forks, resumes and continuations are sessions of their own.
Adding a session backfills it from the feed's start. Adding B keeps A's
acknowledged progress and pending immutable batch; repeating an inclusion is a
no-op. A removal fences an in-flight lease and is checked again before
dispatch. Re-inclusion backfills the session again from the start. New
discoveries stay private without writing an exclusion for every catalog row.
The selected-session manifest is still written for desktop compatibility; its
size follows explicit selections, not the machine's history. Session lists and
status remain read-only.

Selected delivery and targeted hydration run on separate threads, so a backlog
never delays hydration and hydration never delays a drain. Hydration is
scoped to what changed and follows filesystem events:

- The capture thread watches the directory of each member's transcript (its
  catalog row's file), without recursing. A write there that names a
  member's transcript opens a 200 ms debounce window (`WATCH_DEBOUNCE`); when
  it closes, one round compares each named member's transcript (modification
  time and length) with what it last hydrated and hydrates the ones that
  moved, then wakes delivery. A burst of appends is one round; sustained
  writes hydrate about once per window. Writes to other sessions in the same
  directory hydrate nothing.
- A member of a source whose file holds many sessions (OpenCode's database)
  moves with its own catalog row instead. Each inventory pass, which
  refreshes the rows after a write to that database, has the next round
  compare those members' rows, so another session's write does not
  re-hydrate them.
- Once a second (`MEMBER_POLL_INTERVAL`) the thread reads the job's state and
  membership, so a member added or a job resumed is hydrated within about a
  second, and stats the transcripts no watch covers: one whose directory
  does not exist yet or could not be registered.
- Every member is hydrated at startup and again every ten minutes
  (`MEMBER_BACKSTOP_INTERVAL`), which covers a member with no local file to
  compare and a write no event reported; each backstop also registers the
  watch afresh.
- When the watcher reports lost events (a queue overflow or a rescan) or
  fails, the next round compares every member's transcript.
- With `AGENT_RELAY_PROBE_FS_EVENTS=0`, where no watcher can run, or while no
  registration covers any member's transcript (out of watches, too many open
  files), every member's transcript is stat'ed once a second, and
  `capture_metrics` reports `driver: member-poll` with `fallback_reason`
  `disabled` or `fs_events_unavailable`. Each round decides the driver
  afresh.

The rounds keep their read connections from one round to the next, reopening
them only after a failed round or once `history.db` is replaced; a failed
round has the next one compare every member. Hydration uses the core's parser, observation locks, cancellation
and checkpoints. Selected setup does not run a full-history capture. Paused
selected jobs do not hydrate or deliver; the inventory can still discover
metadata.

Selected mode keeps only its members' evidence. On the first poll of a run,
and whenever the members change, the capture thread asks `ai-hist` to forget
the evidence of every other session (`SessionStore::forget_evidence` with
`ForgetScope::AllExcept`): events, full-text rows, tool calls, edits, markers
and checkpoints go, catalog rows stay as `Shallow` so the session list is
unchanged, and a member's delegated children stay with it. A session whose
evidence no local hydration could read back (its transcript deleted, or its
evidence from a remote or plugin source) is kept. When the forget frees at
least 64 MiB and a quarter of the file, the store is rewritten in place
(`SessionStore::compact`) to give the space back. The rewrite holds the
store's write lock for its whole length, so the delivery loop runs it between
its passes rather than the capture thread beside one, and reports it in
`compaction-diagnostic.json`; a volume too full for the rewrite is asked for
again by the next run's pruning. A selection with no members drops nothing.
A re-selected session is hydrated in full again by the next poll. Nothing is
retracted from the destination: what was delivered stays delivered.
`pruning-diagnostic.json` reports the last pass's counts, including
`skipped_unrecoverable`; a failed pass is reported in
`capture-diagnostic.json` as stage `evidence_pruning` and retried at the next
backstop.

The session list reads a catalog that a separate inventory thread keeps,
apart from the selected delivery scheduler. Shallow discovery reads every
provider's metadata, which on a large history costs seconds of CPU even when
nothing changed, so the inventory follows filesystem events rather than a
timer: a write under a provider's roots (the paths `ai-hist`'s own watch
covers, filtered by its own `WatchedPath::admits`) marks that source, and the next pass discovers only the marked
sources; a rescan or a watcher error, which names no path, has the next
pass discover every source. A pass waits at least 50 times as long as the last one took, and at
least 30 s, so discovery holds at most about 2% of a core however busy the
providers are; an idle machine runs no passes. Every 30 minutes a pass
discovers every source, for writes no event reported, and registers the
watcher again, for provider roots created since. With
`AGENT_RELAY_PROBE_FS_EVENTS=0`, or where no watcher can run, every pass
discovers every source at that spaced cadence. All/new sharing modes
capture by [live capture](#live-capture). A one-shot `--once` setup still
runs one bounded cycle: delivery, then capture, then delivery again.

Sharing mutations serialize on `desktop.lock`, stop the collector, and take
its lock. A durable `sharing-change.json` records the intended change before
any writes; replay completes it before delivery can restart. Selected-mode
include/exclude operations update only changed membership. Explicit sharing
mode changes retain generation replacement semantics and preserve pause state.

A selected install whose job predates session membership is adopted in place:
the same job keeps its destination generation, pending batches, retry and
pause state, and its selected sessions become members, each backfilled from
the feed's start. Existing exclusions remain privacy guards, including
exclusions needed by another active destination. Read-only commands also
accept the schema of an install that has not been rebuilt yet.

`capture-diagnostic.json` reports capture stage (`broad_capture`,
`targeted_hydration`, or `live_capture` for a failed watch tick), elapsed time, counts and an
allowlisted error class; inventory diagnostics use a separate file. Logs never
include raw provider errors, transcript content, paths or credentials. A
successful include command means consent and preparation were recorded, not
that a receiver acknowledged the session. `shared`, `queued`, `uploading` and
`uploaded` retain their existing bridge meanings. The historical 77/86-second
capture failures cannot be diagnosed from the old generic logs; their cause
remains unknown until a redacted diagnostic is reproduced.

Disconnect stops the collector, cancels jobs, best-effort revokes the workspace
RelayHistory token, and removes this install's stage credentials/configuration.
The local history database is retained. It does not remove shared Cloud login
credentials belonging to other Cloud clients.

### Local title preview

`agent-relay-probe sessions preview --json --limit 100 [--refresh]` has no
Cloud target, credentials, or transport. `--refresh` runs `SessionStore::discover`,
the shallow catalog sweep, into a separate private metadata catalog under
`~/.agentworkforce/session-preview/`; it does not contend with full capture's
writer or change inclusion. The cache-only form lists recent metadata and writes
`sessions.json` for immediate desktop startup. Both return the desktop session
shape with `included: false` and `status: "unknown"`. These rows are previews;
only the normal target-scoped session list can make them selectable for upload.

The desktop prewarms discovery during sign-in and displays cached titles before
awaiting capture or delivery status. The preview is limited to 100 recent sessions;
full browsing continues through the normal session list when preparation finishes.

### Relay core

`agent-relay-probe relay serve [--socket PATH] [--app-data-dir PATH]
[--exit-on-stdin-eof]` runs the relay core, the desktop's non-UI runtime, on
the private bridge socket `~/.agentworkforce/desktop/core.sock`.
`agent-relay-probe relay call METHOD [--params JSON] --json` sends one bridge
request to it. The contract, lifecycle and module map are in
[the relay core](relay-core.md).
