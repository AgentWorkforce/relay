# Relay Connect: the Node package becomes the local relay

Status: proposal, for review before implementation.
Package: `@agent-relay/connect` (`packages/connect`).

## Why

`npx -y @agent-relay/connect join <link>` currently downloads a native
`agent-relay-probe`, starts it detached, then polls its socket for 60 s. If the
first launch is blocked (Gatekeeper, an MDM allow-list such as Santa, a
quarantine flag, a missing library), the error lands in
`~/.agentworkforce/desktop/headless.log`. The guest only sees
`Timed out waiting for the Agent Relay probe after 60000 ms`
(`install.js` `waitForLiveSocket`). A customer on a managed Mac hit exactly
this.

The guest path does not need the probe. A guest needs three things:

- one Connect credential;
- a poll loop against Relaycast;
- a way to write into the Claude Code or Codex session that ran the command.

Node can do all three. It is already running and already allowed, because
`npx` started it.

## Shape

```
agent session ──(runs)──> npx @agent-relay/connect join <link>
                              │ 1. identify the calling session (env / ancestry)
                              │ 2. prefer a live desktop probe if one is eligible
                              │ 3. else ensure the Node relay daemon (IPC handshake)
                              │ 4. POST /connect/join on the daemon socket
                              ▼
        Node relay daemon (process.execPath, per user, detached)
          - holds credentials + delivery ledger (~/.agentworkforce/connect/)
          - polls Relaycast /v1/deliveries every 3 s, heartbeats every 30 s
          - injects into the session, then acks/fails the delivery
```

The daemon serves the same local HTTP-over-Unix-socket contract the probe
serves today: `/connect/join`, `/connect/send`, `/connect/status` and
`/connect/leave`, with the same response bodies and error codes. Most of
`cli.js`, the README and the reply hints therefore stay as they are. Only the
backend changes.

## What we port from the probe

The references point into `relay-desktop/probe/src/relay/`.

### Connect client (`connect.rs`, `outbound.rs` routes)

**Join**
- Call `POST https://agentrelay.com/cloud/connect/{id}/join` with no auth.
- Send an `Idempotency-Key` header and a body of `{agent_name?, host_claim?}`.
- Accept the link forms the probe accepts: a URL whose id is the last path
  segment or the one before `/join`, or a bare id.
- Use the probe's idempotent join attempt: a request hash plus a persisted key
  with a 15 min TTL. The attempt is kept on 5xx, 429 and timeout, so a retry
  reuses the same key.
- Validate the response exactly as the probe does: id match, https
  `relay_base_url`, our own name listed in participants, not expired.
- The host claim is never persisted, logged or echoed. It stays stdin-only, as
  today.

**Send**
- `POST {relay_base_url}/v1/dm` with `{to, text, mode:"wait"}` and the
  participant bearer token.
- Recipient resolution matches the probe: the join roster, plus senders we have
  observed, plus the Relaycast roster.

**Status**
- Read `GET /v1/agents?status=all` with the token. Map presence the same way.

**Ended or expired**
- Expiry is checked locally from `expires_at` on every call and every poll.
- A 404/410 from Relaycast means the Connect is over.
- On 401/403, check `GET https://agentrelay.com/connect/{id}` to tell "ended"
  from "token problem".
- When the Connect closes, remove the credential and inject one
  ended/expired notice.

**Backoff**
- Use the per-Connect gate for 429, `rate_limit_exceeded` and `workspace_busy`:
  2 s up to 15 min.

### Inbound and injection (`inject.rs`, `claude.rs`, `codex/*`)

Polling only, as in the probe: `GET /v1/deliveries?limit=50` every 3 s while
any Connect is active, plus `POST /v1/agents/heartbeat` every 30 s. Messages
are filtered the same way (`dm`, `mention`, `thread-reply`; our own messages
and skipped kinds are acked). The injected text is byte-for-byte the probe's
format:

```
[Relay Connect — from <sender> · ref <first 12 hex of sha256(message_id)>]
<reply hint>

<body>
```

Codex delivery detection depends on that first line.

The routes, in the probe's selection order:

**Claude Code terminal: peer inbox socket**
- Pure `node:net`, so no binary is needed.
- Read `sessions/<pid>.json` from `~/.claude` and sibling `.claude-*` folders.
  Parse only the first JSON value. The process start time must match
  `procStart`.
- Read the token from `sessions/<pid>.<hash>.key`.
- Write two NDJSON lines (`auth`, then the `user` message with
  `priority:"next"`), then `shutdown(write)`.
- The outcome rules match the probe:
  - a failure on the auth line is Retry;
  - a failure partway through the message line is InDoubt;
  - no live record is Waiting.
- Set `"crossSessionInbound": "accept"` in `~/.claude/settings.json` the way the
  probe does: keep every other key and back up once to
  `settings.json.relay-desktop-backup`.
- If managed settings override this key, fail the join inline and name the
  managed file.

**Codex terminal: `codex queue`, confirmed from the rollout**
- Run `codex queue --thread <id> --message=<text>` and parse
  `Queued message <id>`.
- Feature-detect the command with `codex queue --help`.
- Delivery is confirmed only by the rollout's `item_completed` `UserMessage`
  carrying the ref, never by the queue.
- A queued item that disappears without a rollout record for 45 s or more is
  InDoubt.
- A live TUI is found through the thread writer lock or `resume <id>` in argv:
  - on Linux, `/proc/<pid>/fd` and `/proc/<pid>/cmdline`;
  - on macOS, `lsof -p` and `ps -o args=`.

**Codex desktop app: `ipc.sock`**
- Pure `node:net`.
- Frames are a 4-byte little-endian length followed by JSON.
- Sequence: `initialize`, then `thread-owner-discovery`, then
  `thread-follower-start-turn`.
- Answer incoming `client-discovery-request` messages with
  `canHandle:false`.
- Keep the probe's pinned method versions.

**Codex shared app-server: `codex app-server proxy`**
- WebSocket over the proxy's stdio.
- Call `thread/loaded/list`, then `turn/start` only for a thread that is
  already loaded.
- This is phase 2. Phase 1 sessions reach Codex through the queue and the
  IPC route.

**SQLite**
- The probe reads `queue_1.sqlite` and `state_5.sqlite`.
- Use `node:sqlite` when the running Node has it. Otherwise:
  - find the rollout through `sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`;
  - read the queue with `sqlite3` if it is on `PATH`;
  - otherwise skip the queue read and rely on the rollout and the 45 s rule.
- Add no native npm dependency.

### Identifying the calling session

The probe identifies callers from Unix-socket peer credentials. Node has no
portable `SO_PEERCRED`, so the CLI identifies its own session and sends
`target` with the request. This works because the CLI always runs inside the
session.

- **Codex:** `CODEX_THREAD_ID` from the CLI's environment. It must be a UUID,
  and the thread must exist under `CODEX_HOME`.
- **Claude Code:** walk the CLI's parent processes to the first pid with
  `sessions/<pid>.json` whose `procStart` matches. This is the same rule as
  `local.rs` `caller_target`.

The daemon socket is created `0600` inside a `0700` directory. Same-user
processes can already write to the Claude inbox and the Codex queue, so a
caller that declares its own target gains no capability. The probe's
code-signing check of the Codex ancestor guarded the probe's broader socket.
It is not ported (see "Not ported").

## Lifecycle: an on-demand per-user daemon, not a service

**Not foreground.** `join` must return. A Claude Code or Codex shell tool call
that never exits would block the very session we want to inject into.

**Not a user service.** A LaunchAgent or systemd unit is the heavyweight path.
On macOS 13+ it raises a "Background Items Added" notice, and managed Macs can
block it through MDM policy. It also outlives the Connect, which a guest did
not ask for.

**What we do instead:**

1. **Stable runtime copy.** `join` copies the package's `dist/` into
   `~/.agentworkforce/connect/runtime/<version>/`, so cleaning the npx cache
   cannot remove a running daemon's code.
2. **Detached start.** It starts
   `process.execPath <runtime>/daemon.js` detached, with stdio going to
   `~/.agentworkforce/connect/daemon.log` plus an IPC channel.
   - This is the same Node binary that is already executing `npx`.
   - JavaScript files are not subject to Gatekeeper.
   - Nothing is downloaded.
3. **Handshake instead of a blind wait.** The daemon binds its socket, loads
   state and sends `{ready, version, socket}` over IPC within 10 s. If the child
   exits first or sends `{error}`, `join` prints that cause and the last log
   lines inline, then exits non-zero. There is no 60 s blind wait.
4. **Single instance.** A lock directory and a pidfile (the same pattern as
   today's `acquireInstallLock`) plus a socket liveness check. A newer CLI
   version asks an older idle daemon to exit, then starts its own.
5. **Exit rules.** The daemon exits 60 s after its last Connect ends, is left
   or expires. It exits after 15 min if no Connect ever attached. This mirrors
   `connect_lifetime.rs`.
6. **Recovery.** Credentials persist, so after a reboot or crash any
   `send`, `status` or `leave` revives the daemon before acting. The reply hint
   and the join summary already route through the CLI.
   - Inbound injection pauses while the daemon is down. Relaycast keeps the
     undelivered items until they are acked or failed, so nothing is lost
     while it is down.
   - The join summary says how to resume after a reboot:
     `npx -y @agent-relay/connect status`.
7. **Debugging.** `connect join --foreground` runs the daemon in the
   terminal.

## Exactly-once and ack: the probe's ledger, same rules

The state lives in `~/.agentworkforce/connect/state.json`: directory `0700`,
file `0600`, written atomically to a temp file with fsync, renamed, then the
directory fsynced. It uses the same map layout as the probe's
`connect-sessions.json`, but it is a separate file and is never shared with the
probe.

- **Ledger key.** `agent_id:delivery_id`.
- **Settled items.** If the entry is already settled, re-send its ack or fail
  without injecting again.
- **Persist before inject.** Persist the entry as `pending` before injecting.
  If that write fails, stop the pass without acking.
- **Outcomes:**

  | Outcome | Persisted as | Settlement | Notes |
  |---|---|---|---|
  | Delivered | Delivered | `ack` | |
  | InDoubt | InDoubt | `fail` with `retryable:false` | Never resent: at-most-once. |
  | Refused | failed | `fail` | |
  | Retry / Waiting | — | — | Back off 5, 10, 20, then 30 s. The pass stops here (head-of-line per target). After 1 h unaccepted, one final attempt, then Unavailable + `fail`. `AGENT_RELAY_CONNECT_HANDOFF_TIMEOUT_SECONDS` is honored. |
  | Accepted / WaitingForTurn (Codex queue holds it) | — | — | Later passes only observe the queue and rollout. No second write. |

- **Crash windows**, the same as the probe:
  - *Between injecting and persisting the outcome:* a not-yet-accepted item is
    attempted again.
    - Codex closes this window, because the router checks the rollout and the
      queue for the ref before it writes.
    - Claude Code does not, because its inbox gives no read-back. This remains
      at-least-once, as it is in the probe. `msg_id` is sent as the Relaycast
      message id in case Claude dedupes on it.
  - *Between persisting the outcome and acking:* the next pass re-acks from the
    ledger.
- **Tests pin each outcome against a fake Relaycast** (see Tests).

## Coexisting with the desktop probe

The CLI chooses a backend for each command:

1. **The session already joined through the Node relay** (it is in
   `state.json`): use the Node relay.
2. **A live, eligible desktop probe exists** (the pointer and socket pass
   today's ownership checks, `/setup/status` is ok, and its version is at least
   the minimum): use the probe, exactly as today. The probe's `connect-sessions`
   holds the credential. Its richer routes (Claude cloud sessions, Conductor,
   fleet) keep working.
3. **Otherwise:** use the Node relay.

Rules that keep them apart:

- **One owner per Connect credential.** A join goes to exactly one backend, and
  send, status and leave follow it. Neither backend ever polls the other's
  credential, so nothing is injected twice.
- **Probe too old.** `join` no longer refuses with "update required". It uses
  the Node relay and prints one line saying it did.
- **Leftover pointer, no live probe.** Ignored.
- **No more downloads from `join`.** `join` never downloads or starts the
  native probe. `connect install` stays as an explicit opt-in that installs the
  full probe for people who want it.
- **Testing override.** `AGENT_RELAY_CONNECT_BACKEND=node|probe` forces a
  backend.

## Failures print the real cause, inline

| Situation | What `join` prints |
|---|---|
| No `CODEX_THREAD_ID` and no Claude session record among the ancestors | "Run this from a live Claude Code or Codex session (no Codex thread id in env; no Claude Code session record for any parent process)." |
| Managed settings pin `crossSessionInbound` | The managed file path, plus "replies cannot be injected; ask your admin". |
| Codex too old for `queue` and no app IPC socket | "Codex <version> cannot receive injected messages; update Codex." |
| Cloud error | Cloud's code and message, through the existing `errorDetails` table. |
| Daemon failed to start | The child's error and the last log lines. |

**Preflight.** After a successful join, the CLI runs a no-write check that the
calling session is injectable now: the Claude record and key are readable, or
the Codex queue command or IPC socket exists. If the check fails, the CLI warns
inline instead of leaving the guest to wait for replies that never come.

## Not ported (deliberately)

| Probe feature | Why it stays out |
|---|---|
| Account sign-in, registrations, uploads, mailbox, webhooks and subscriptions, push WebSocket | Not part of a guest's Connect path. |
| Claude app cloud sessions (`claude --print --cloud`) | macOS app only, and needs a signed-in Claude CLI. A guest runs `npx` from a terminal session. |
| Conductor Stop-hook hold (writes `~/.codex/hooks.json` pointing at a binary) | Requires a persistent installed binary. A busy Conductor chat gets the message through the queue at its next turn. |
| Fleet and broker Codex workers; Paseo, Muse, OpenCode, Grok and Devin routes | Not guest surfaces. |
| Code-signing checks of Codex ancestors (`security_framework`), `SO_PEERCRED` | See "Identifying the calling session"; equivalent trust for a same-user socket. |
| Attachment downloads | Phase 1 injects the attachment names and URLs only. |

## Related fixes in this effort (separate PRs)

**(a) `connect_unreachable` covers five causes, and none are logged**

The cases, in `relay-desktop` `outbound.rs`:

- the join task panicked;
- a join transport failure;
- a 401/403 on send while the Connect is still active;
- the availability check failed;
- a DM with no HTTP status or a 5xx.

Proposed codes:

| Code | Meaning |
|---|---|
| `connect_unreachable` | Transport failure only. |
| `connect_upstream_error` | A 5xx, flagged "may have been sent". |
| `connect_auth_rejected` | A 401/403 while the Connect is active. |
| `connect_availability_unknown` | The availability check failed. |

Each is logged with `tracing::warn` and its cause, with no token or text. The
CLI maps the new codes. The Node relay uses the same codes from day one.

**(b) `leave` leaves the guest "online" and keeps its name reserved**

This is confirmed: the probe's `/connect/leave` is purely local. It makes no
Cloud or Relaycast call, so presence goes stale only when heartbeats stop.
Cloud's room has no `leave` operation; its `participants.left_at` column exists
but is never set, so the name check still sees the guest.

The fix:

- the clients call Relaycast `POST /v1/agents/disconnect` with the participant
  token;
- Cloud adds a participant-authorized `leave` room operation and route that
  sets `left_at`.

Both the probe and the Node relay call both.

**(c) "is ready." vs "is ready to help."**

The join notice comes from Cloud (`relay-connect-worker` `room-lifecycle.ts`
and `web/lib/mcp/connect-join-announcement.ts`), not from this package. Cloud
`main` says "…joined this Relay Connect and is ready." in both places, and
"ready to help" does not appear in any repo. We need the location where "ready
to help" was seen before changing anything.

## Phases

1. **Daemon and contract.**
   - The Node daemon, socket and IPC handshake, the state store and ledger,
     the Connect client.
   - The Claude inbox route; Codex `queue` with rollout confirmation; Codex IPC.
   - Backend selection in the CLI, and removal of the probe download from
     `join`.
2. **Remaining routes.** The Codex app-server proxy route and attachment
   downloads.
3. **Cleanup.** Retire the macOS probe-tarball path in `install.js` once
   `connect install` usage is gone.

## Tests

**Unit (vitest, in `packages/connect/tests`)**
- Link parsing and join idempotency, against a fake Cloud that counts
  idempotency keys.
- Ledger transitions for every outcome.
- Persist-before-inject: a crash between injecting and persisting the outcome,
  simulated by killing the daemon at that point.
- Head-of-line backoff, the unaccepted TTL, re-ack from the ledger.

**Injection**
- A fake Claude inbox socket asserts the two NDJSON lines and the token.
- Codex `queue`, through a fake `codex` on `PATH` and a fixture rollout
  `jsonl`.
- An IPC socket fake that speaks the length-prefixed frames.

**Lifecycle**
- The handshake: a daemon that exits early produces an inline error, not a
  timeout.
- Single instance, idle exit, revival from persisted state.

**Coexistence**
- An eligible fake probe socket wins.
- A session found in `state.json` stays on the Node relay.

**Real round trip** (manual, recorded in the PR)
- Create a throwaway Connect.
- Join from a live Claude Code session and from a live Codex session on a
  machine without the desktop app.
- Send in both directions. Confirm injection, then ack, by checking
  `/v1/deliveries` is empty.
- Leave, and confirm the guest shows offline.
- Never use a customer's Connect.
