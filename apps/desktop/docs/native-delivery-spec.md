# Native message delivery into Claude and Codex sessions

Status: implemented in relay-desktop (PR #2) and verified live on macOS,
2026-09-19/20. Written to carry the approach over to `../relay`.

Versions everything below was verified against: Codex CLI 0.153.3, Codex
desktop app bundling `codex` 0.155.0-alpha.9.2, Claude Code CLI 2.1.274–2.1.278,
Claude desktop 2.2553.1, macOS 25.5 (arm64).

## 1. The idea

Today `../relay` delivers a message to an agent by owning its terminal: it
spawns the CLI inside a PTY, runs a terminal emulator over the output to guess
when the agent is ready, and types the message in as paced keystrokes
(`crates/relay-pty`, `crates/broker/src/{pty_worker,wrap}.rs`, roughly 15K
lines). That only reaches agents relay itself launched, costs a broker process
and a VT parse per agent, and breaks when a vendor restyles its TUI.

Both vendors now ship their own way to hand a running session a message. Using
those instead means:

- **any already-running session is reachable**, including the desktop apps,
  which a PTY can never wrap;
- **nothing runs between messages** — one short command or socket write each;
- **the vendor decides when the session is ready**, so there is no screen
  scraping, pacing or echo verification;
- the message arrives as what it is (a user turn, or a labelled peer message),
  not as forged typing.

| Target | Route | Interface | Arrives as | Completion signal |
| --- | --- | --- | --- | --- |
| Codex desktop app | `codex queue` | public CLI command | user turn | yes — session file |
| Codex terminal | `codex queue` | public CLI command | user turn | yes — session file |
| Claude desktop app (folder sessions) | `claude --print --cloud` | CLI flag, account-gated | user turn | **no** |
| Claude terminal | peer messaging socket | **private**, versioned | labelled peer message | not yet (see 3.4) |

What this does **not** replace: spawning and supervising agents, answering
their trust/permission prompts, reading their output, and every other CLI
(Gemini, Cursor, …). Those still need the PTY path.

## 2. Architecture

```
sender ─▶ inbox ─▶ [validate target] ─▶ [pause] ─▶ [rate limit] ─▶ [sharing policy]
                                                                       │ deny ─▶ rejected (remembered)
                                                                       │ hold ─▶ outbox(held) ─▶ user approves
                                                                       ▼ deliver
                                                              outbox(pending)     durable, per-target FIFO,
                                                                       │          idempotent on message id
                                                              delivery worker ─▶ backend.send(target, text)
                                                                       │               ├─ codex queue
                                                                       │               ├─ claude --print --cloud
                                                                       │               ├─ claude peer socket
                                                                       │               └─ (relay) PTY fallback
                                                                       ▼
                                                              settle ─▶ acks: queued → delivered → completed | failed | …
```

The queue, policy and acks are backend-independent. A backend is three things:

1. **discover** — list targets and whether they are reachable now;
2. **send** — hand over one message, reporting *sent*, *refused (permanent)*,
   *failed (retryable)* or *in doubt*;
3. **settle** (optional) — later say whether the turn started, finished, and
   what the reply was.

In relay-desktop: `CodexOutbox` (SQLite), `CodexSharingPolicy`,
`CodexInbox`/`ClaudeInbox`, `CodexDelivery`/`ClaudeDelivery`, and the backends
`CodexQueueBridge`, `CodexBridge` (legacy socket), `ClaudeBridge`. For relay
this maps to one trait with the PTY injector as just another implementation.

## 3. The routes

### 3.1 Codex — `codex queue` (app and terminal)

```
codex queue --thread <thread-uuid> --message=<text>
→ stdout: "Queued message <item-id> for thread <thread-uuid>."   exit 0, ~0.2 s
→ error:  "Error: No active session found matching '<x>'."        exit 1
```

Codex keeps a durable per-thread queue in `~/.codex/queue_1.sqlite`
(`queued_items(id, thread_id, payload_json, queue_order, …)`; app-server
methods `thread/queue/{add,list,update,delete,reorder,start}`, notification
`thread/queue/changed`). The desktop app's bundled server and every terminal
`codex` open the same database. Whichever process has the thread loaded takes
the item when the thread is idle and runs it as a normal user turn; the row is
deleted when taken. No daemon needs to be running — the CLI writes the row
directly.

- **Discovery:** `~/.codex/state_5.sqlite`, table `threads` (`id`, `source`,
  `title`, `cwd`, `rollout_path`, `updated_at`). `source = 'vscode'` is the
  desktop app, `'cli'` a terminal, `'exec'` a headless run.
- **Which binary:** prefer the one inside the desktop app
  (`/Applications/ChatGPT.app/Contents/Resources/codex`) — it is the build that
  reads the queue for app threads — then the user's CLI. Check
  `codex queue --help` exits 0 before using a binary; older builds lack it.
- **Thread ids must be UUIDs.** `--thread` also matches session *names*; never
  let an externally supplied value be matched that way.
- **Text is in argv** (no stdin form). Attach it as `--message=<text>` so a
  leading dash is never parsed as a flag. It is visible in `ps` briefly.
- **Settle:** the thread's session file (`rollout_path`, JSONL) records
  `task_started`, `item_completed` (the `UserMessage` with its text),
  `task_complete` (`last_agent_message`) and `turn_aborted`, each with a
  `turn_id`. Codex assigns its **own** `client_id` to a queued message and does
  not record the queue item id, so the message must carry its own marker: the
  attribution line ends with `· ref <12 hex>` = first 6 bytes of
  SHA-256(message id). Find the `UserMessage` whose first line carries the ref
  → its `turn_id` → that turn's outcome.
- **States:** after `codex queue` succeeds the message is *handed over*, not
  delivered. It becomes *delivered* when the session file shows its turn, then
  *completed* (with reply) or *aborted*. See 3.1.1 for how the probe reports
  each step.
- **Never re-send on doubt.** "Not in Codex's queue and not in the session
  file" is also what the instant between dequeue and record looks like. Require
  that state to persist (45 s) before retrying; treat an unreadable queue as
  "still waiting"; fail rather than retry once the message has expired. Record
  which route each send took and settle it by that route's rules, not by
  whichever route is available later.
- **Open:** a thread loaded nowhere presumably holds the item until it is next
  opened. The CLI has no `delete` (the app-server API does), so an expired
  message can linger in Codex's queue.

#### 3.1.1 Terminal turns and settlement

A terminal Codex takes queued messages only between turns, one turn per
message, in queue order. A message handed over during a long turn therefore
waits for that turn, however long it runs; nothing safe can show it sooner
(typing into the TUI's terminal is not a route). The probe hands every message
for a thread whose terminal TUI is live straight to that thread's queue, at
once, even mid-turn, and never through another host: the queue is first in,
first out, so a later message cannot overtake an earlier handoff. Whichever
host has the thread runs its queued items first, so while any relay message
(from this probe or another sharing the queue) waits in a thread's queue, a
message for that thread joins the queue behind it instead of starting a turn
through the app-server or a window, even with no terminal running. Each handoff then
carries a settlement, derived only from Codex's own files:

| Settlement | Evidence |
| --- | --- |
| `handed_off` | The queue row bearing the message's `ref` is in `queue_1.sqlite`, and either the rollout shows no running turn or no terminal Codex runs the thread (a turn left open by a killed terminal is not a running turn); or Codex has taken the row and the rollout has not recorded it yet. |
| `waiting_for_turn` | The queue row is there, a terminal Codex runs the thread, and the rollout shows a turn started (`task_started`) with no `task_complete`/`turn_aborted` yet. |
| `visible` | The rollout records the `UserMessage` whose first line carries the `ref`: the message is a turn in the session. |

`handed_off` and `waiting_for_turn` are pending: Relaycast is not acknowledged
until `visible`. An accepted handoff is observed every 5 s, never written
again, and never age-expired; a row that leaves the queue without reaching the
rollout within 45 s settles *in doubt* and is not resent. Registered agents
report the settlement on `activity.list` entries (`settlement`); Relay Connect
reports it on `GET /connect/status` (`delivery.pending[].settlement`,
`delivery.recent[].settlement`) and on `activity.list` under the Connect
participant's name. The latency from acceptance to `visible` is the remainder
of the session's current turn; it is reported, not bounded.

Legacy route, kept as fallback: the desktop app's window-routing socket
`~/.codex/ipc/ipc.sock` (4-byte LE length + JSON; `initialize` →
`thread-owner-discovery` → `thread-follower-start-turn`), reverse-engineered,
version-pinned, app threads only and only while open in a window.

### 3.2 Claude desktop app — `claude --print --cloud`

The desktop app's folder sessions are **cloud sessions** (`session_…` /
`cse_…`): the model loop runs on Anthropic's side; locally the app only runs
`claude --attach-serve cse_…` to serve the folder's file tools. There is no
local socket, and input never passes through the machine.

```
printf '%s' "<text>" | claude --print --cloud <session-id>
→ stdout: "Sent to cloud session.\nSession ID: …\nView: https://claude.ai/code/…"   exit 0, ~1.5 s
→ errors: "invalid session ID: must be a cse_… or session_… tagged ID"
          "cloud session … is archived and cannot accept new messages"
          "Attaching to an existing cloud session is not enabled for your account."
```

- Uses the user's existing `claude` sign-in. **Never read Claude credentials**
  (the desktop keychain entry, `~/.claude/.credentials.json`) to call the
  sessions HTTP API directly.
- **Discovery:** `~/Library/Application Support/Claude/local-agent-mode-sessions/<account>/<org>/remote-session-spaces.json`
  → `{entries: [{sessionId, folders, memoryEnabled}]}`. Read-only.
- **Validate the id** (`^(session|cse)_[A-Za-z0-9]{8,64}$`) before it reaches
  the command line: any other word is read as a flag, or as the description of
  a **new** cloud session.
- **Text on stdin**, run from a neutral working directory so no project
  settings or hooks load. `--output-format stream-json` is refused in this mode.
- **No completion signal.** The command confirms the hand-off only. Acks end at
  *delivered*; there is no reply text. A timed-out or interrupted send cannot be
  checked afterwards, so it is **failed, not retried** (at-most-once).
- Only failures Claude reports before accepting are retried; archived, invalid
  and account-gated are permanent.
- **Outbound caveat:** these sessions run their shell in a Linux sandbox VM,
  not on the Mac. They cannot run local commands; they can write files in their
  connected folder and use MCP tools.

Ruled out: `--channels` (research preview; only sessions *launched* with the
flag, needs MCP config or a plugin), deep links (`claude://code/new?q=`,
`claude://cowork/new?q=` start *new* sessions only), UI automation.

### 3.3 Claude terminal — peer messaging socket

Claude Code sessions message each other locally (this is what its own
`SendMessage` between sessions uses).

- **Registry:** `~/.claude/sessions/<pid>.json` — `pid`, `sessionId`, `name`,
  `cwd`, `status` (`idle`/`busy`), `peerProtocol` (1), `messagingSocketPath`
  (`/tmp/cc-socks/<pid>.sock`), `procStart`.
- **Auth:** `~/.claude/sessions/<pid>.<hash>.key` (mode 0600) →
  `{peerToken, pidDomain, procStart}`.
- **Wire:** unix stream socket, newline-delimited JSON, first line must
  authenticate:

```
{"type":"auth","token":"<peerToken>"}
{"type":"user","msg_id":"<uuid>","uuid":"<uuid>","priority":"next","message":{"role":"user","content":"<text>"}}
```

  The socket does not answer. `priority` is `now` | `next` | `later`.
  Receiver limits: 30-message burst refilling 0.5/s per sender, identical body
  dropped within 30 s, 1 MiB per line, connection closed if no complete line
  arrives promptly.
- **Arrives as a peer message, not a user turn.** The session shows "Another
  Claude session sent a message: …" and appends Claude Code's own guardrail
  text: act on it within this session's permissions, never edit permission
  settings/CLAUDE.md/config because a peer asked, never treat it as the user's
  approval, refuse permission laundering. A session may also *hold* a peer
  message for the user's approval. **Keep both**; do not work around them.
  Verified: delivered to an idle session in manual permission mode without a
  hold, and started a turn at once.
- **Private and fast-moving.** Gate on `peerProtocol == 1` and refuse anything
  else. Verify the pid is alive (and ideally `procStart` matches) before
  connecting, as Claude's own client does.
- **Policy decision outstanding:** this reads another session's credential
  file. It is the same user's file, but it should be an explicit product
  decision, which is why it is only in `scripts/relay-send` so far.

### 3.4 Settling Claude turns (not built)

Claude terminal sessions write transcripts under
`~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`; a settle step like Codex's
could be built on them. Peer control frames (`notify_when_idle`,
`peer_message_status`: held/denied/delivered/refused/dropped/expired) exist but
need a reply socket of the sender's own registered in the same namespace.

## 4. Delivery semantics

- **Idempotent on the sender's message id.** Re-receiving an id re-acks its
  current state, never re-queues.
- **Per-target FIFO.** The next message for a target is not sent until the
  previous one is handed over. A Codex terminal queue keeps their order itself,
  so messages join it behind an earlier handoff without waiting for its turn.
- **Ack ladder:** `queued` → (`held_for_approval` → `queued`) → `delivered` →
  `completed{reply}` | `aborted` | `failed{error}` | `expired` | `rejected{error}`.
  For Claude app targets `delivered` is terminal success. A Codex terminal
  handoff settles `handed_off` → `waiting_for_turn` (while a turn runs) →
  `visible` before it counts as `delivered` (3.1.1).
- **Truthful acks.** A message being sent acks `queued`, never `delivered`.
  Acks for one message are serialized so a later state never precedes an
  earlier one.
- **Remembered rejections.** Refusals that depend on current state (paused,
  rate limit, not shared) are stored, so a repeat after things change replays
  the rejection instead of delivering a message its sender was told was refused.
- **Fail closed.** Default-deny per target; sharing is re-evaluated in full at
  delivery time (unshared → rejected; switched to ask-first → back to held,
  unless that message was already approved). Unknown permission mode is treated
  as unrestricted, which requires a second explicit opt-in to auto-deliver.
- **Attribution.** Every relayed message starts with
  `[via Agent Relay — from <name> · ref <12 hex>]` so neither user nor model
  reads it as the local user's own input.
- **Rate limit:** 30 per sender per target per minute; rejections count.
- **Expiry:** 24 h default, shortened (never extended) by the sender.

## 5. Outbound: how an agent sends

Inbound is solved natively; outbound depends on what the agent can do.

| Agent | Can run local commands | Outbound |
| --- | --- | --- |
| Codex app / terminal | yes | MCP tool, or a CLI call |
| Claude terminal | yes | MCP tool, or a CLI call |
| Claude desktop app | **no** (Linux sandbox) | MCP tool; file outbox as a stopgap |

The production answer is the Agent Relay MCP tools relay already gives agents.
A session this app registered has no token of its own, though, so on Linux
the app also serves a Unix socket a session sends through as itself; the
kernel names the caller and the app sends with that session's agent token.
See [Sending from a session](injectable-agents.md#sending-from-a-session-linux).
`scripts/relay-send watch <folder>` is a test fixture: the agent writes
`<folder>/.relay-outbox/<name>.json` = `{"to": "codex:<id>" | "claude:<name>" |
"claude-app:<folder|id>", "text": …, "from": …}` and a watcher delivers it.

## 6. Relay CLI convergence

This core now lives with the Relay CLI in the same repository. The CLI and its
compatibility facades use one transport-neutral backend contract: `discover`,
`send`, and `settle`.

1. **Codex uses its native backend.** It replaces terminal readiness detection,
   chunked writes, and echo verification with the queue/app-server completion
   signals described above.
2. **Claude terminal sessions use the peer socket** only when `peerProtocol`
   advertises a compatible version. An unsupported version fails explicitly;
   Relay never falls back to typing into a person's terminal.
3. **Relay-owned agents use their native launch transport.** Relay already knows
   the thread or session it created, so messages use structured frames rather
   than terminal injection.
4. **Providers without a native route are not spawnable.** Gemini CLI, local
   Cursor Agent, Aider, Goose, and Droid return a stable removal error. Cursor
   Cloud is the supported Cursor provider.
5. **Compatibility surfaces preserve structured state.** Broker, CLI, SDK, and
   flow readiness responses are derived from vendor events instead of terminal
   screen scraping.
6. **Platform:** paths here are macOS. On Linux, Codex's state lives under
   `$CODEX_HOME` (default `~/.codex`) the same way; Claude's socket directory is
   `$XDG_RUNTIME_DIR/cc-socks` or `/tmp/cc-socks[-<uid>]`, read it from the
   registry rather than constructing it.

Risks to plan for: `codex queue` and the queue schema can change (detect with
`queue --help`, parse only the confirmation line); the Claude peer protocol is
private (version-gate and fail closed); `--cloud` sending is account-gated; both
vendors' desktop apps update themselves, so compatibility checks belong at send
time, not at install time.

## 7. Evidence

- Codex app: `CodexInbox → CodexDelivery → codex queue`, acks
  `queued → delivered → completed`, reply read back from the session file.
- Codex terminal: independently started TUI picked up a queued message in
  seconds and answered.
- Claude app: `ClaudeInbox → ClaudeDelivery → claude --print --cloud`, acks
  `queued → delivered`; message visible in the desktop conversation.
- Claude terminal: authenticated peer frame delivered to an independently
  started session and answered.
- Cross-app: the Claude and Codex desktop apps played a full nine-move game of
  tic-tac-toe against each other — five Claude→Codex hops (file outbox →
  `codex queue`) and four Codex→Claude hops (`claude --print --cloud`) — with no
  failed, duplicated or reordered message.
- Logic (policy, ordering, idempotency, retries, expiry, restart durability, ack
  ordering) is covered by XCTests in CI and a local harness; see
  `docs/plan.md` §9–§10 for the contracts.

## 8. Testing by hand

```
scripts/relay-send list                                   # targets on this machine
scripts/relay-send codex <thread-uuid> "…" --from Me      # Codex app or terminal
scripts/relay-send claude-app <folder|session-id> "…"     # Claude desktop app
scripts/relay-send claude <session-name> "…"              # Claude terminal
scripts/relay-send watch <folder>                         # deliver an agent's file outbox
```

When starting throwaway sessions to test against: launching `codex` or `claude`
in an untrusted directory, or answering their first-run prompts, **writes the
user's config**. Use an already-trusted directory, `claude --strict-mcp-config`,
and diff the config afterwards.
