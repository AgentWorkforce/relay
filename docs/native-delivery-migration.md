# Migration: native delivery

Status: proposal. Nothing here is built in this repo yet.

## What changes

Relay delivers a message to an agent by owning its terminal: `agent-relay-broker
wrap <cli> <args...>` spawns the CLI inside a PTY, runs a terminal emulator over
its output to guess when it is ready, and types the message in as paced
keystrokes (`crates/relay-pty/`, `crates/broker/src/pty_worker.rs`,
`crates/broker/src/wrap.rs`,
`crates/broker/src/broker/delivery_verification.rs` — roughly 15K lines).

Both Anthropic and OpenAI now ship supported ways to hand a _running_ session a
message. This migration puts a delivery-backend seam beside the PTY injector and
moves each CLI onto its native route where one exists, keeping the PTY for the
rest.

Coordination does not change. Workspaces, `register_agent`, `send_dm`,
channels, the agent directory and the receipt contract all stay exactly as they
are. This is about how a message _arrives_, not how agents address each other.

## Why

1. **Friction.** Only agents relay launched are reachable. A session the user
   started themselves is invisible. This is the most-reported complaint.
2. **Expense.** A broker process per agent, a VT parse of every output byte,
   repeated screen snapshots for readiness and echo checks.
3. **Fragility.** It breaks when a vendor restyles its TUI, and keystroke
   delivery is buggy in ways that are hard to fix.

On (3), `asheshgoplani/agent-deck` (~926★) moved its `session send` from
`tmux send-keys` to Claude Code's messaging socket (PR #2100, shipped in
v1.16.11; the code is in `main` at `internal/send/claudesocket.go`). The bugs it
cites are failure modes relay is equally exposed to:

- message stranded in the composer, Enter never submitted
- automated sends clobbering an open question picker and the user's unsent draft
- reporting "NOT delivered" for a message that was delivered
- Ctrl-C-then-resend recovery **delivering twice**
- automated sends merging with half-typed input and submitting it

Counter-evidence worth weighing: `anywhere-labs/Agents-Anywhere` (~1067★) built
on Codex's private IPC router and then removed it — not because it broke, but as
policy: _"It is not a documented OpenAI public API."_ That argues for preferring
public commands over reverse-engineered sockets wherever one exists, which is
what the plan below does.

## The mechanisms

Verified live on macOS, September 2026. Full wire-level detail, exact commands,
failure modes and delivery semantics are in
`../relay-desktop/docs/native-delivery-spec.md`, with the non-Claude/Codex
survey in §6a on the branch `docs/other-cli-injection-survey`.

| CLI                        | Route                                                                                          | Reaches a session relay did not launch? | Completion signal             |
| -------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------- |
| Codex (app + terminal)     | `codex queue --thread <uuid> --message=<text>` — public command over Codex's own durable queue | **yes**                                 | yes, from the session file    |
| Claude terminal            | the session's inbox socket (cross-session messaging, on by default since v2.1.224)             | **yes**                                 | via the transcript (to build) |
| Claude cloud / desktop app | `claude -p --cloud <id> --output-format json` — documented                                     | **yes**                                 | no — acks end at delivered    |
| grok, opencode, devin      | ACP; opencode also has an HTTP API with `--port`                                               | no — must be launched for it            | yes                           |
| muse                       | `muse serve` (MSP over stdio)                                                                  | no                                      | yes                           |
| cursor-agent               | none                                                                                           | no                                      | —                             |

Headless resume (`-p --resume`, `codex exec resume`, `devin -p -r`) is **not**
injection. It is a second process over the same history, invisible to the live
session and unsafe to run alongside it.

## Phases

Ordered by value over risk. Phase 6 is independent and can go first.

### Phase 0 — the seam

A delivery-backend trait beside the PTY injector: `discover` (list targets and
reachability), `send` (report _sent_ / _refused_ / _failed_ / _in doubt_),
`settle` (optionally report turn start, outcome and reply). The PTY injector
becomes one implementation. Relay's queue, verification states and telemetry are
kept; the four outcomes map onto them.

Four rules belong in the seam itself:

1. **Fall back to another transport only on a strictly pre-write error.**
   agent-deck encodes this as `Unavailable` (safe) versus `CommittedError`
   (post-write, never retried, because a retry double-delivers). relay-desktop
   reached the same rule independently.
2. **Never re-send on doubt.** "Not in the vendor's queue and not in the session
   file" is also what the instant between dequeue and record looks like.
3. **Record which route each send took** and settle by _that_ route's rules.
4. **Never claim an acknowledgement you did not observe.** A socket write that
   gets nothing back means handed over, not delivered.

_Effort: small. Exit: parity suite green, unchanged, with the PTY backend behind
the new trait._

### Phase 1 — Codex

`codex queue`, a public command, reaching both the desktop app and terminal
threads. Settle from the thread session file; Codex assigns its own `client_id`
to queued messages, so carry a marker in the message text and match on that.

**Blocking task:** relay must learn the thread id of a `codex` it spawned.
`~/.codex/state_5.sqlite`'s `threads` table has `id`, `source`, `cwd`,
`updated_at`. Solve this first — it gates the phase.

_Effort: medium, mostly discovery. Exit: parity + `eval:matrix` for codex._

### Phase 2 — Claude Code

Two targets that do not overlap: terminal sessions via the inbox socket, cloud
sessions via `--cloud`. Relay gets a simplification here because it launches its
agents — `claude --session-id <uuid>` assigns the id up front, so there is no
discovery problem. For sessions relay did _not_ launch, read the registry.

Correctness details, learned from agent-deck's review: verify the registry's
`procStart` against the live process (pids get recycled), resolve by the
selected account rather than the freshest record, and note a message beginning
with `/` will not run as a slash command.

_Effort: medium. Exit: parity + `eval:claude`._

### Phase 3 — one ACP backend for grok, opencode, devin

These cannot be reached when started plainly, but relay launches its agents, so
it can start them in a structured mode. One ACP backend covers all three.
opencode's HTTP API (`--port`, then `/tui/append-prompt` + `/tui/submit-prompt`
— **not** `prompt_async`, which does not render in the TUI) is the easier win if
the TUI must stay visible.

_Effort: medium. Exit: `eval:matrix` per harness. Blocked on decision D2._

### Phase 4 — what stays on the PTY

muse (first-class support landed in #1815; `muse serve` is the structured
alternative) and cursor-agent. Note `muse session-message` verifies the sender's
process ancestry and refuses outsiders with `sender_unverified` — **a security
boundary, not to be defeated.**

### Phase 5 — decouple spawning from wrapping

`add_agent` and the fleet `spawn` both end in `Spawner::spawn_wrap_with_token`,
which re-execs the broker as `wrap <cli>`. Every spawned agent is therefore a
PTY child. Once a CLI has native delivery its spawned agents need not be: start
the process detached, register it, deliver natively. This is where cost (2) is
actually recovered.

Must survive detachment: the `parent` lineage in
`{cwd}/.agentworkforce/relay/state.json`; `BrokerEvent::AgentSpawned`; the
`agent_spawn` telemetry with its `spawn_source`; and the declared workforce
metadata.

Two real losses to answer first: relay loses the agent's output stream
(readiness, liveness, session capture) and the prompt auto-answering that
handles first-launch trust dialogs. See decision D2.

_Effort: large. Exit: `tests/e2e/fleet` two-node matrix + `stability-soak`._

### Phase 6 — stop writing into user config

Relay already has the right pattern twice. `crates/broker/src/devin.rs` states
it: _"Isolate that directory in the worker process, leaving HOME/data paths
intact. **Never edit user files.**"_ Muse (#1815) does the same via a clean
config home and `--muse-config-home`. Claude gets `--mcp-config` inline, Codex
repeated `--config` args.

Three still mutate state the user owns:

- **grok** — `configure_grok_mcp` runs `mcp remove` then `mcp add` against the
  user's registry. grok has no per-launch MCP flag, so the isolated-config-home
  route is the answer.
- **opencode** — writes `opencode.json` into the working directory.
- **cursor / cursor-agent** — writes `.cursor/mcp.json` into the working
  directory.

`side_effect_files_for` in `crates/broker/src/cli_mcp_args.rs` already
enumerates the last two, so the blast radius is known.

**Out of scope: gemini and droid.** Leave `configure_gemini_droid_mcp` alone.

_Effort: small, per CLI. Independent of everything else._

## Readiness gates

The existing suites decide this, not new ones. `tests/parity/*` currently
asserts PTY behaviour — `orch-to-worker.ts` says so in its header — which is
exactly what makes it the right gate: **the same assertions must pass with the
backend swapped.**

| Gate                                                                    | What it proves                                |
| ----------------------------------------------------------------------- | --------------------------------------------- |
| `tests/parity/orch-to-worker.ts`                                        | a spawned worker receives                     |
| `tests/parity/multi-worker.ts`                                          | fan-out holds                                 |
| `tests/parity/broadcast.ts`                                             | channel delivery holds                        |
| `tests/parity/continuity-handoff.ts`                                    | handoff across agents                         |
| `tests/parity/stability-soak.ts`                                        | no drift or leak over time                    |
| `npm run eval:matrix` / `eval:claude` (`RELAY_INTEGRATION_REAL_CLI=1`)  | per-harness, against real CLIs                |
| `evals/suites/{delivery-modes,messaging,read-receipts,agent-directory}` | the delivery contract is unchanged            |
| `tests/e2e/fleet`                                                       | two-node fleet, needed for Phase 5            |
| `tests/e2e/tic-tac-toe`                                                 | sustained multi-turn cross-agent conversation |
| `tests/e2e/prod-smoke`                                                  | end to end against prod                       |

A phase is done when its gates pass **and** the PTY path still passes for every
CLI not yet migrated. No phase retires the PTY; that is decision D3, taken only
after a soak.

### Hooking into targeted feature verification (#1812)

#1812 added a changed-files → feature-manifest → cleanroom-scenario selector
(`scripts/verify-features/targeted-pr-plan.mjs`), reading
`.agentworkforce/features/manifest.yaml` (196 features, each with a
`criticality` and a `verify_tier`) and
`tests/relayflows/cleanroom/relay.matrix.json`. Use it; do not invent a
parallel harness.

Two consequences to plan for:

- **It fails closed.** An unmapped runtime path falls back to the complete
  smoke profile — 62 scenarios across 30 shards, up to ~53 minutes. Every new
  backend file must be mapped in the manifest in the same PR that introduces
  it, or every migration PR runs a full smoke.
- **Register each backend as a feature.** There are already neighbours to model
  on: `sdk-delivery`, `broker-redeliver`, `local-agent-spawn`, `fleet-spawn`,
  `mcp-spawn`, `opencode-relay-spawn`. Expect roughly one feature per backend
  (`codex-queue-delivery`, `claude-socket-delivery`, `claude-cloud-delivery`,
  `acp-delivery`) plus one for the seam itself. Delivery is `critical`; tier is
  4 or higher for anything needing two agent identities, 6 for PTY parity.
- Changing the manifest triggers the selector's own self-check, and `docs/` is
  inert — this document will not trigger verification.

### The gate that does not exist yet

No current scenario delivers into a session relay did **not** launch. That
capability is the entire point of the migration and nothing tests it today. Add
a cleanroom scenario that starts a bare `claude` and a bare `codex` outside the
broker, has them `set_workspace_key` + `register_agent`, and asserts a message
reaches each of them unprompted — no PTY, no wrap, no polling. Until that
exists there is no proof of the thing being claimed.

## The Mac apps

Today relay has no story for the Codex and Claude desktop apps: you cannot wrap
a GUI application in a PTY, so they are invisible to it. Native delivery is what
brings them into scope, and it is worth stating what that does and does not get
you.

**Inbound works and is proven.** `codex queue` reaches Codex app threads —
verified end to end against an open thread, including reading its reply back
from the session file. `claude -p --cloud <id>` reaches Claude desktop folder
sessions, likewise verified. Neither needs the app to be launched any
particular way.

**Outbound needs MCP in the app, and the shape differs per app.**

- **Codex app** — supports MCP servers and plugins, configured once by the
  user. Relay cannot pass `--config` args to an app the user opened, so this is
  a user-initiated setup step, not something relay can arrange at launch.
- **Claude app** — its cloud sessions carry a `remoteMcpServersConfig`, so a
  **hosted** MCP endpoint works without any local process. Relaycast already
  has one. That is the cleanest outbound path of the two.

**Spawning into an app is possible but only half-verified.** Claude's deep
links (`claude://code/new?q=…`, `claude://cowork/new?q=…`) create new sessions
with a starting prompt, which would let relay open work in the app rather than
a terminal. No equivalent was confirmed for the Codex app. Deep links only
_create_; they cannot address an existing session.

**What relay gives up for an app session.** It is not a broker child, so there
is no PTY, no output stream, no supervision or restart, and no spawn lineage —
it registers itself as an agent via MCP rather than being spawned with a token.
Its lifecycle belongs to the user.

That is the same shape as any agent relay did not launch; the Mac apps are
simply the most visible instance. Which is the argument for treating
"unlaunched agent" as a first-class case in the model rather than a special
case bolted on for desktop apps.

## Open decisions

**D1 — how does relay discover the thread id of a `codex` it spawned?**
Match on cwd plus recency in `state_5.sqlite`, or find a better handle. Gates
Phase 1. _Recommend: resolve during Phase 0 spike, before committing to Phase 1
scope._

**D2 — for ACP-hosted and detached agents, does relay keep a PTY for the
human's view?** An agent run as an ACP server is not a TUI. Keeping a PTY purely
for display retains the per-agent cost but preserves the experience.
_Recommend: keep it initially, make it optional, measure before removing._

**D3 — is the PTY path ever retired, or permanently demoted to fallback?**
_Recommend: permanent fallback. cursor-agent has no native route, new CLIs will
appear without one, and version gates need somewhere to fall back to._

**D4 — are the Mac apps a supported target, or a side effect?** Supporting them
properly means owning an outbound MCP setup story per app and accepting agents
relay neither spawned nor supervises. _Recommend: treat "agent relay did not
launch" as a first-class case; the desktop apps then follow for free._

## Risks

- **Vendor surfaces change.** Mitigate by version-gating every reverse-engineered
  surface and falling back to the PTY rather than failing the message, and by
  checking capabilities at send time, not install time — vendors auto-update.
- **Double delivery.** The worst failure mode, and the one agent-deck hit. The
  seam rules in Phase 0 exist for this; treat any violation as a release blocker.
- **Silent behaviour drift.** Native routes differ in what they report. Claude
  cloud has no completion signal at all; a Claude peer message arrives labelled
  "from another session" with slash commands disabled. The parity gates catch
  contract drift, not semantic drift — review per phase.
- **Platform.** The spec's paths are macOS. On Linux, Codex uses `$CODEX_HOME`
  the same way; Claude's socket directory is `$XDG_RUNTIME_DIR/cc-socks` or
  `/tmp/cc-socks[-<uid>]` — read it from the registry rather than constructing it.

## Testing hazard

Launching `codex` or `claude` in an untrusted directory, or answering their
first-run prompts, **writes the user's config**. Use an already-trusted
directory, pass `claude --strict-mcp-config`, back up `~/.codex/config.toml` and
`~/.config/muse/settings.json` first, and diff afterwards. This bit us during
the spec work.
