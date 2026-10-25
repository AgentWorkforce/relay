# Plan: relay-desktop owns the probe

## Boundary

| Owner | Scope | Visibility |
|---|---|---|
| `relayhistory` (`ai-hist`, `provider-sources`) | Where sessions live and what their files look like; parsing; the local SQLite database; the CLI, SDK and MCP server that query it; change capture over that database | Public |
| `relay-desktop` (`probe/`) | The always-on daemon: when to scan, what to hydrate, sign-in, the upload queue, retries, transport to Agent Relay Cloud, and the JSON bridge the desktop apps drive | Private |

The open-source core has no daemon, credentials or uploads. The daemon depends on
the published `ai-hist` crate and nothing else from `relayhistory`.

`@relayhistory/capture` (npm) and its Rust crate `relayhistory-plugin` are
deprecated. No repository outside `relayhistory` depends on them; the probe is
their only real consumer.

## The `ai-hist` contract

The daemon uses `ai-hist`'s public embedder API, [`SessionStore`], and nothing
behind `unstable-internal`:

| Need | `SessionStore` |
|---|---|
| Cheap catalog of every session | `discover` (stage 1) |
| Full index of one session | `hydrate` |
| Full sweep | `sync` |
| React to provider writes | `watch` |
| Catalog and one session's evidence | `sessions`, `session` |
| What to upload next | `changes_since` with a named consumer cursor, `head_revision` |
| Stop promptly, report progress | a cancellation token and progress callback on `discover`, `sync` and `hydrate` (stage 1) |

The change feed reads evidence where it lives: no payload copies, no retention
cap, and no trigger that can abort an ingest write. The `export` feature's
upload journal — its payload copies, its retained-byte cap and its hooks in
ingest — is removed once the daemon reads the feed. Local NDJSON export stays.

## Existing installs

Alpha installs rebuild: the first run of the ported daemon discards the old
upload tables and uploads the selected sessions again from the change feed's
start. Sign-in, the sharing mode and the selected sessions carry over.

The receiver keys a record by `(org, workspace, origin_id, record_id)` and
replaces it only when the new `revision` is higher; a lower revision is
acknowledged and ignored. The rebuilt install therefore keeps its `origin_id`
(`delivery_state.origin_id`) and `record_id` scheme, and numbers revisions above
the highest the old probe issued (`sqlite_sequence` for `delivery_journal`).

## Stages

Each stage is one PR per repository and leaves every install working.

### 0. Unblock uploads (done)

- `relayhistory#256`: the probe accepts receiver fields it does not know, and a
  new build retries a blocked job once.

### 1. Complete `SessionStore` for the daemon (`relayhistory`)

- `SessionStore::discover`: the shallow catalog sweep, without hydrating.
- Cancellation and progress for `discover`, `sync` and `hydrate`.
- Release `ai-hist` to crates.io. (`relayhistory#257` merged; release pending.)

### 2a. Move the daemon (`relay-desktop`)

- `probe/` is the upload crate imported with its history, depending on
  `ai-hist` pinned to a `relayhistory` commit until stage 1's release.
- CI and releases build it with `scripts/build-probe.sh`, stamped with the
  desktop release version; CI runs its tests.
- Unchanged: the binary name `agent-relay-probe`, the state directory
  `~/.agentworkforce/probe/<sha256(site,account,workspace)>/`, stage auth files,
  the upload records, and the bridge JSON in `docs/plan.md` section 3.

### 2b. Port uploads to the change feed (`relay-desktop`)

Two PRs, in order.

**2b-1. The probe reads `ai-hist` through `SessionStore`.** Capture, inventory,
hydration, catalog reads and progress use `SessionStore` (`sync`, `discover`,
`hydrate`, `sessions`, `session`, `StopToken`, `ProgressObserver`). Modules the
probe binary cannot reach are deleted with their tests: `outbox`, `turns`,
`convergence`, `relaycast`, `replay`, `legacy_cli`, `compat`, `helper`,
`source`, and the `relayhistory-plugin` bin. Delivery still reads the `export`
journal.

**2b-2. Uploads come from the change feed.**

- A job's position is a feed `Watermark`. A new all-sources job drains from
  `Watermark::START`, which is its bootstrap; afterwards it resumes from its
  cursor. Snapshot bounds, shadow preimages and journal subscriptions go away.
- A selected-sessions job filters the feed by membership. Adding a member
  backfills that session with a session-filtered drain
  (`ChangeQuery::session`) from `START` to the head at the time it was added.
- A record is built from a `Change`:
  - `record_id` is the SHA-256 of `[kind, ...key]` as compact JSON, matching the
    journal's `json_array` key.
  - `revision` is `revision_base + change.revision`.
  - `revision_id` is the SHA-256 of `origin:record_id:revision`.
  - `payload` is `change.columns` (every stored column except `revision`), or
    `null` for a delete.
- The daemon owns its state: `origin_id` and `revision_base`, which must stay
  above every revision this origin has sent. A feed epoch change (a replaced
  database) moves the base above the highest revision sent.
- Every sharing mode uploads every feed kind. Consent is the daemon's filter:
  membership, `delivery_exclusions`, prompts with no session only when
  everything is shared, and a relationship only when both its sessions are
  shared (or its child is unlinked). They are checked when a batch is prepared and again at
  dispatch (`validate_dispatch`), the same two gates as today.
- There is no retention cap and no journal compaction. `status --json` drops
  `retention`, so the app hides **Compact now**. `compact` keeps only receipt
  compaction.
- The dependency is `ai-hist` from crates.io, with neither `export` nor
  `unstable-internal` enabled.

**Rebuilding an install.** On the first run, the daemon finds the `export`
journal schema in `history.db`. In one transaction it:

1. records `origin_id` (from `delivery_state`) and
   `revision_base = sqlite_sequence['delivery_journal']`;
2. drops the capture triggers (`delivery_<table>_{insert,update,delete}` on
   the twelve evidence tables, and the cap/count triggers on
   `delivery_journal` and `delivery_batches`), which otherwise keep writing
   and can abort ingest at the cap;
3. drops the journal, shadow, bootstrap-bound, subscription and export-page
   tables, and every unsent batch;
4. resets each live job to `START` (and each member's backfill), keeping its
   sharing mode, members and exclusions.

It then uploads the selected sessions again, at revisions above everything
this origin sent, so the receiver replaces every record.

### 3. Deprecate `@relayhistory/capture` (`relayhistory`)

- Publish a final `@relayhistory/capture` and platform packages whose entry
  points fail with a message naming the Agent Relay desktop app, then
  `npm deprecate` every `@relayhistory/capture*` package.
- Remove the `export` upload journal from `ai-hist`: capture triggers,
  retained-byte accounting and the retention error.
- Remove `plugins/relayhistory/` (Rust crate and SDK), its CI and publish jobs,
  `docs/agent-relay-probe.md`, `docs/history-delivery.md`, `docs/enable-cloud.md`
  and the probe release artifacts.
- The core SDK, CLI, native addon and MCP server drop `HISTORY_DELIVERY_MOVED`
  and the optional `get_session_thread` plugin hook; uploads are simply not part
  of the open-source surface.
- `README.md` describes local history only, with one line pointing at the
  desktop app for team uploads.

### 4. Distribution (`agentrelay.com`, `cloud`)

- `install.sh` installs the desktop app for the platform (macOS `.dmg`, Linux
  package) from this repository's releases. Remove `stage-probe.mjs` and
  `web/public/downloads/agent-relay-probe/`.
- `cloud/scripts/dev.mjs`, `dev-desktop.mjs` and `test-probe-local.mjs` build the
  probe from `relay-desktop`; `docs/teams-session-onboarding.md` says so.

### 5. Daemon quality (`relay-desktop`)

Defects observed on a production install, each its own PR once the code lives
here:

1. **Real failure detail.** Keep the receiver's error code and body and the
   blocked verdict's cause; `status --json` reports them, and the app shows them.
2. **Bounded logs.** Rotate `collector.log` by size; one line per failing source
   per cycle, never one entry per session (an OpenCode failure wrote 44,588 ids
   per cycle and grew the log to 10 GB).
3. **Cheap status.** `status --json` answers from `runtime.json` and the
   delivery tables without scanning history (5 s at 100% CPU on a 4 GB database);
   the app never overlaps status calls.
4. **Event-driven capture.** Use `SessionStore::watch` to hydrate
   changed sessions instead of periodic full cycles; back off when idle.
5. **Upload policy.** Batch while active, drain before sleep and quit, and
   respect the receiver's `Retry-After`.

## Decisions

- **Legacy cloud commands** (`relayhistory-plugin replay`, `token`, relaycast
  bridge): retired with `@relayhistory/capture`.

## Open

- **Headless Linux**: proposed — `install.sh` installs the Linux desktop
  package, which bundles the probe, and no bare-probe download is offered.
