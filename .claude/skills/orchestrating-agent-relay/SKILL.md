---
name: orchestrating-agent-relay
description: The canonical way to run agent-relay - self-bootstrap the local broker and autonomously spawn, monitor, and coordinate a team of worker agents without human intervention. Covers infrastructure startup, agent spawning, lifecycle monitoring, message-based reading via the relay MCP, and team coordination.
---

# Orchestrating Agent Relay

Self-bootstrap agent-relay infrastructure and manage a team of agents autonomously.

## Overview

A headless orchestrator is an agent that:

1. Starts the local relay broker itself (`agent-relay node up`)
2. Spawns and manages worker agents on that broker
3. Monitors agent lifecycle events
4. Coordinates work without human intervention

The orchestrator drives the team and reads/sends/lists through the **Agent
Relay MCP server** (`agent-relay mcp`). The session registers itself once with
the `register_agent` tool (name it `orchestrator`) — every messaging tool
errors with `Not registered. Call the "register_agent" tool first.` until it
does. Lifecycle
control — starting the broker, spawning/releasing local agents, streaming
broker debug events — goes through the `agent-relay node` command group. The
workers it spawns are registered participants too; their peer-messaging
reference is the **`using-agent-relay`** skill.

## The model

- Agent Relay delivers messages **node-only**: every agent is owned by a node,
  and the engine routes that agent's messages to its node reliably (ordered,
  resumable). The local broker is a node; agents you spawn on it are bound to
  it.
- A **fleet** is the set of nodes advertising **capabilities** (`spawn:<harness>`
  plus custom node actions). The engine **places** a spawn or action onto a node
  by capability + liveness + capacity + least-loaded, or onto a named
  `target_node`. Spawning and releasing agents are actions. Most orchestration
  spawns on the local broker; fleets matter when coordinating across nodes.
- Agent-to-agent coordination is messages — channels, DMs, threads — plus
  reactions and read receipts. Reading another agent's replies is a messaging
  operation (`check_inbox`, `list_messages`, `get_message_thread`), **not** a
  broker-event tail.

## When to Use

- Agent needs full control over its worker team
- No human available to run `agent-relay node up` manually
- Agent should manage agent lifecycle autonomously
- Building self-contained multi-agent systems

## Quick Reference

| Step                              | Command/Tool                                                      |
| --------------------------------- | ----------------------------------------------------------------- |
| Verify installation               | `command -v agent-relay` or `npx agent-relay --version`           |
| Verify Node runtime if shim fails | `node --version` or fix mise/asdf first                           |
| Start broker                      | `agent-relay node up --background --verbose`                     |
| Check broker readiness            | `agent-relay node status --wait-for 10`                          |
| Workspace + cloud + broker status | `agent-relay status`                                              |
| Spawn worker                      | `agent-relay node agent spawn claude --name Worker1 --task "..."`|
| List workers                      | `agent-relay node agent list`                                    |
| Resource usage                    | `agent-relay node metrics`                                       |
| Send DM to worker (MCP)           | `send_dm(to: "Worker1", text: "...")`                             |
| Post to channel (MCP)             | `post_message(channel: "general", text: "...")`                  |
| Read worker replies (MCP)         | `check_inbox(limit: 20)` / `list_messages(channel: "general")`   |
| Give a human a follow-along link  | `agent-relay observer`                                          |
| Inspect a worker's TTY            | `agent-relay node agent attach Worker1 --mode view`             |
| Release worker                    | `agent-relay node agent release Worker1`                         |
| Stop broker                       | `agent-relay node down`                                          |

## Bootstrap Flow

### Step 0: Verify Installation

```bash
# Check if agent-relay is available
command -v agent-relay || npx agent-relay --version

# If your shell reports a mise/asdf shim error, fix Node first
node --version
# e.g. for mise: mise use -g node@22.22.1

# If not installed, install globally
npm install -g agent-relay

# Or use npx (no global install)
npx agent-relay --version
```

### Step 1: Start the Broker

```bash
# Starts a detached broker and returns after API readiness
agent-relay node up --background --verbose
```

Verify broker readiness before spawning any workers:

```bash
# Polls for readiness; must report the daemon running before you spawn workers
agent-relay node status --wait-for 10
```

`agent-relay status` (top level) reports workspace, cloud login, and local
broker status together; `agent-relay node status` is the focused broker-daemon
readiness check.

> The broker/agent lifecycle commands live under `agent-relay node …`. The old
> flat `agent-relay local …` group still works as a **hidden, deprecated alias**
> and prints a removal warning — use `node` in new work.

When verifying from a source checkout or throwaway git worktree, run these
commands from the project/worktree root. The CLI writes runtime state to
`.agentworkforce/relay/` and may create `.mcp.json`; clean those files after
validation if the worktree should remain clean.

The broker:

- Auto-creates a Relaycast workspace if no workspace key is set
- Removes the `CLAUDECODE` env var when spawning (fixes nested session error)
- Persists state to `.agentworkforce/relay/` (broker connection metadata,
  lock/pid, and `.agentworkforce/relay/connection.json`)

### Step 2: Spawn Workers

The orchestrator's MCP session can spawn through the relay MCP, or you can spawn
directly on the local broker via the CLI.

CLI:

```bash
agent-relay node agent spawn claude \
  --name Worker1 \
  --task "Implement the authentication module following the existing patterns"
```

MCP (relay MCP, when the orchestrating session runs `agent-relay mcp`):

```text
add_agent(
  name: "Worker1",
  cli: "claude",
  task: "Implement the authentication module following the existing patterns"
)
```

`node agent spawn` takes the provider as a positional argument
(`claude`, `codex`, `gemini`, `droid`, …) and `--name` / `--task` / `--channels`
/ `--model` / `--cwd` flags. By default the agent joins the `general` channel and
runs in `interactive` spawn mode; pass `--exit-after-task` for a one-shot worker.

> **Expect a 30–60s gap between spawn and the first ACK.** A worker shows in
> `node agent list` within ~5s (the process is up), but the underlying CLI
> (claude/codex) is still cold-starting and won't send its ACK DM until it
> finishes booting — typically 30–45s, occasionally longer, after it appears.
> Appearing in the list means "process alive," **not** "agent responsive." Don't
> treat ACK silence in the first minute as a stuck worker; size ACK-wait loops
> for at least 60s (e.g. a 30-iteration poll) before escalating to
> troubleshooting.

### Step 2.5: Give the Human a Way to Watch (optional)

A human driving an autonomous run usually wants to see what the team is saying
without joining it. Hand them a read-only observer link:

```bash
agent-relay observer
```

That prints a URL backed by a scoped `ot_live_` token — read-only, expiring in
24 hours, agent DMs excluded. Narrow it with `--channels build,review`, widen it
with `--include-dms` or `--expires 7d`, and cut it off early with
`agent-relay observer revoke <id>`.

From the relay MCP, the equivalent is `get_observer_url`.

> **Never build an observer URL from the workspace key.** `rk_live_` is an
> administrative credential — it can send messages, spawn agents, and change
> workspace settings — and a URL query string is not a place to put one. The
> realtime endpoint rejects it anyway; only a scoped observer token with
> `stream:read` is accepted.

### Step 3: Monitor and Coordinate

The orchestrator reads and sends through the relay MCP (after its one-time
`register_agent` call):

```text
# Read messages directed to you — DM replies, mentions, reactions
check_inbox(limit: 20)

# Read a channel's history
list_messages(channel: "general", limit: 50)

# Read a full thread off a specific message
get_message_thread(message_id: "msg_123")

# Send a targeted DM to a specific worker
send_dm(to: "Worker1", text: "Also add unit tests")

# Broadcast to a channel
post_message(channel: "general", text: "All workers: wrap up current task")

# See who is present
list_agents(status: "online")
```

For broker-side liveness and resource visibility, use the CLI:

```bash
# Agents running on the local broker (pid, status, uptime)
agent-relay node agent list

# Resource usage for the broker and its agents
agent-relay node metrics
```

> **Reading worker replies is a messaging operation, never `node tail`.**
> `agent-relay node tail` streams **broker debug events** (spawn/exit/queue
> internals); `agent-relay node tail --agent <name>` streams that worker's
> **raw output/TTY**. Neither is the durable message log workers write to each
> other. To read a worker's ACK, STATUS, or DONE, use `check_inbox` /
> `list_messages` / `get_message_thread` over the relay MCP. Use `node tail`
> only when debugging broker delivery or watching a worker's raw output.

### Step 4: Release Workers

```text
remove_agent(name: "Worker1", reason: "Work accepted")
```

CLI equivalent:

```bash
agent-relay node agent release Worker1
```

### Step 5: Shutdown (optional)

```bash
agent-relay node down
```

## Coordination Commands

**Lean on the relay MCP for messaging and on `agent-relay node` for
lifecycle.** Together they give full visibility into agent activity.

### Channel vs DM — When to Use Each

**DM** — targeted, private, for responses you need to read back:

- `send_dm(to: "Worker1", text: "...")` — sends a DM to Worker1
- Worker replies arrive in your inbox; read new ones with `check_inbox`, and
  re-read consumed history with `list_dms` + `agent-relay message dm list <conversationId>`

**Channel post** — broadcast, visible to all agents on that channel:

- `post_message(channel: "general", text: "...")` — posts to #general
- Use for coordination messages, status updates, announcements
- Read channel history with `list_messages(channel: "general")`

**`check_inbox` is the canonical way to read *unread* messages directed at
you** — it returns unread DMs, mentions, and reactions and does not resurface
messages once read. For a full channel transcript use `list_messages`; for one
thread use `get_message_thread`. To re-read a DM conversation you already
consumed (an ACK/DONE you saw earlier, or a worker's full DM history), enumerate
conversations with `list_dms`, then read one persistently with the CLI
`agent-relay message dm list <conversationId>` — unlike `check_inbox`, that view
does not clear on read.

```text
# WRONG — node tail --agent streams the worker's raw output, not durable messages
agent-relay node tail --agent Worker1

# RIGHT — read messages addressed to you (DM replies, mentions)
check_inbox(limit: 20)

# RIGHT — read a channel's evidence trail (diffs, grep counts, GO/NO-GO)
list_messages(channel: "general", limit: 100)

# RIGHT — read one thread end to end
get_message_thread(message_id: "msg_123")
```

CLI-only equivalents (agent-token based, useful from a plain shell) live under
the `message` group: `agent-relay message inbox check`,
`agent-relay message list <channel>`,
`agent-relay message dm list <conversationId>` (persistent DM history —
`list_dms` gives the conversation id),
`agent-relay message get_thread <messageId>`,
`agent-relay message dm send <agent> <text>`,
`agent-relay message post <channel> <text>`,
`agent-relay message reply <messageId> <text>`.

### Plain-Shell Orchestration (no relay MCP configured)

An orchestrating session without the relay MCP still has full read access:
`agent-relay message list <channel> --limit 50` works with no credentials and
returns a JSON array (**newest first**; `[]` when the channel is empty — each
item carries `text`, `from.name`, `createdAt`, `kind`). Every **send**, however,
fails with `requires agentToken or agentClient` until the shell holds an agent
token. Mint one once per project and keep it inside the gitignored broker state
dir:

```bash
grep -qxF '.agentworkforce/' .gitignore 2>/dev/null || echo '.agentworkforce/' >> .gitignore
TOKEN=$(agent-relay agent register orchestrator --type system | grep -oE 'at_live_[A-Za-z0-9_-]+' | head -1)
[ -n "$TOKEN" ] || { echo "registration failed — no token captured" >&2; exit 1; }
(umask 077 && printf '%s' "$TOKEN" > .agentworkforce/relay/orchestrator.token)
chmod 600 .agentworkforce/relay/orchestrator.token   # tighten a pre-existing file too

TOKEN=$(cat .agentworkforce/relay/orchestrator.token)   # later shells re-read it
RELAY_AGENT_TOKEN="$TOKEN" agent-relay message post general "checkpoint: reviews start after both DONEs"
RELAY_AGENT_TOKEN="$TOKEN" agent-relay message dm send Worker1 "NO-GO findings: …"
RELAY_AGENT_TOKEN="$TOKEN" agent-relay message inbox check
```

Never echo, commit, or log the token. Registering also makes `orchestrator` a
DM-able recipient for workers — the same identity an MCP-based session creates
with the `register_agent` tool.

### Monitoring Workers (Essential)

Spawn/send/release commands are in the Quick Reference and Bootstrap Step 3 —
not repeated here. For monitoring specifically: poll `agent-relay node agent
list` for broker-side liveness (pid, status, uptime) instead of scraping the
worker TTY, and use `agent-relay node agent attach <name> --mode view` to watch
real-time output when debugging.

> **Harness note: don't poll with a bare foreground `sleep`.** Many harnesses
> (Claude Code included) block a foreground `sleep` used to wait for ACK/DONE —
> e.g. `sleep 25; check_inbox ...` is rejected with a directive to use a
> backgrounded loop or a Monitor/until-loop instead. The inline `sleep`-based
> snippets shown elsewhere in this skill are illustrative of the *logic*; in a
> harnessed environment, run the wait loop with `run_in_background` (or the
> harness's Monitor + until-loop), polling `check_inbox` and
> `agent-relay node agent list` from inside the backgrounded loop rather than
> blocking the foreground on `sleep`.

The push-style alternative to polling is a `node tail` pipeline used purely as
a **wake-up trigger**, run through the harness's background-task facility (or
with `&` in a plain shell — in the foreground it blocks until a match):

```bash
# Exits the moment a matching relay_inbound event arrives.
# Anchor on the body VALUE starting with the marker — not a loose substring.
agent-relay node tail | grep -m1 '"body":"DONE Implementer r2'
```

`relay_inbound` events carry each message's `body`, `from`, and `target`, and
the stream replays a bounded window before following live. Two independent traps
make a loose `grep` fire on the wrong event, and you need to defend against both:

- **Replay + quoting.** A substring like `REVIEW VERDICT: GO` matches not only the
  real verdict but every earlier message that *quoted* the marker — an ACK saying
  "I'll post `REVIEW VERDICT: GO` when done" is in the replay window and fires
  first. Anchoring the pattern on `"body":"<marker>` (the body value **beginning**
  with the marker) rejects quotes, since a quoted marker sits mid-sentence after
  some other opening text.
- **Your own outbound.** If you DM a worker the instructions containing the marker
  string, that DM is a `relay_inbound` event too (with `"from":"orchestrator"`).
  Add `"from":"<Worker>"` to the pattern, or anchor on the body as above, so your
  own messages can't trip it.

Give workers a run-specific marker (`DONE <name> <round-tag> — <evidence>`) so a
replayed event from an earlier round can't match either. A bare `"body":"DONE`
substring is only safe for a first, one-shot wait in a fresh workspace. This
wakes you the second the event happens instead of on the next poll tick; it is
still not the durable log, so read the actual messages with `check_inbox` /
`list_messages` after waking. (Stock macOS has no `timeout(1)` — bound a one-off
listen with `python3` `subprocess.run(..., timeout=N)` or a backgrounded kill.)

### Troubleshooting

```bash
# Release an unresponsive worker (graceful stop)
agent-relay node agent release Worker1

# Re-check broker status
agent-relay node status

# Workspace + cloud + broker overview
agent-relay status

# If a worker looks stuck, attach in view mode to inspect its TTY
agent-relay node agent attach Worker1 --mode view
```

**Tip:** Attach with `--mode view` or watch `agent-relay node tail --agent
<name>` to monitor worker progress and catch errors early.

## Orchestrator Instructions Template

Give your lead agent these instructions. The bootstrap/spawn/monitor commands
are in the Bootstrap Flow and Quick Reference above — the paste-worthy part is
the **Protocol**, the ruleset a lead agent can't infer from the command list:

```text
You are an autonomous orchestrator. Bootstrap the local broker
(Bootstrap Flow Steps 0–2), then spawn and manage workers per the
Quick Reference. Then enforce this protocol:

## Protocol
- Workers will ACK when they receive tasks — but expect a 30–60s cold-start
  gap after spawn: a worker appears in `node agent list` (~5s) well before
  the CLI is booted enough to send its first ACK. Don't troubleshoot a "stuck"
  fresh worker until at least 60s has passed
- Workers will send DONE when complete
- In a harnessed environment, never wait with a bare foreground `sleep`
  (it is blocked) — run ACK/DONE poll loops with run_in_background or a
  Monitor/until-loop, polling `check_inbox` and `node agent list` from inside it
- **ACK/DONE target: `orchestrator` (the registered spawning identity) or
  the `general` channel — NEVER `broker`.** `broker` is the broker's internal
  routing self-name, not a spawnable/DM-able agent: a worker DM to `broker`
  fails with `Agent "broker" not found`. Write the worker task prompt to DM
  `orchestrator` (or post `general`) — never "DM the broker"
- Tell every worker explicitly: do NOT self-remove/release after DONE — stay
  alive and idle so you can DM them review findings to fix
- After DONE, run a reviewer; on NO-GO, DM the findings back to the SAME
  worker. If the worker is gone, spawn a fresh one and re-inject branch +
  commit SHA + the full verdict
- Read worker replies with `check_inbox` / `list_messages` / `get_message_thread`
  over the relay MCP — never `node tail` (that streams broker debug events,
  not worker messages). See the "Channel vs DM" section for the full reading
  model
- Poll `agent-relay node agent list` for worker liveness; set a wall-clock
  fallback so a silently-dead worker can't hang the loop
- If a human is watching, give them a follow-along link with
  `agent-relay observer` and print the URL it returns. Never print the
  workspace key or put it in a URL
```

## Multi-Round Review Loops (DONE → NO-GO → fix → re-review)

Spawning, monitoring, and releasing a worker is the easy path. The hard part
the basic flow does **not** cover: a worker reports DONE, a reviewer comes
back NO-GO, and now the work has to go back. Plan for this topology before you
spawn anything.

### Workers must not self-remove until you tell them

A worker's natural hygiene instinct is to release itself right after reporting
DONE. That **kills the review→fix→re-review loop**: when the reviewer returns
NO-GO there is no agent left to send the findings to, so you are forced to spawn
a fresh worker and re-inject the entire context (branch, commit, full verdict)
instead of just DMing the existing one.

**Put this in every implementer/worker task prompt explicitly:**

```text
Do NOT release yourself (no remove_agent / agent-relay node agent release on
yourself). Report DONE and stay alive and idle. The orchestrator will send you
review findings to fix, or release you when the work is fully accepted.
Self-removing before then breaks the fix loop.
```

The "release when done" guidance elsewhere in this skill applies to the
**orchestrator** releasing workers — never to a worker releasing itself
mid-loop.

### The respawn-with-full-context fallback

If a worker did self-remove (or died), you cannot just DM it. Spawn a fresh
worker and re-inject everything it needs to act with no prior memory:

```bash
agent-relay node agent spawn codex --name Implementer2 \
  --task "Continuation of prior work. \
Branch: feature/auth. Last commit: <sha>. \
The reviewer returned NO-GO with these findings: <full verdict text>. \
Check out the branch, address every finding, re-run tests, report DONE. \
Do NOT self-remove — stay alive for re-review."
```

Always pass branch + commit SHA + the **complete** reviewer verdict. A fresh
worker has none of the loop's history; a summarized verdict loses the
specifics it needs to fix.

### Detecting a silently-dead worker

Inbox polling fires on **messages only**. A worker that exits or self-removes
produces no message, so the inbox just goes quiet — indistinguishable from a
worker still thinking. Defenses:

- Poll `agent-relay node agent list` for liveness instead of inferring it from
  inbox silence. A worker that vanishes from the list is gone.
- `agent-relay node agent attach <name> --mode view` (or `node tail --agent
  <name>`) will show a self-issued release call — but it is noisy TTY/event
  scraping, a last resort, not a signal.
- Always set a wall-clock fallback (e.g. a ScheduleWakeup ~30 min out) so a
  silently-dead worker can't hang the loop forever waiting on a message that
  will never arrive.

## Lifecycle Events

`agent-relay node tail` streams broker events. The broker emits these (also
available via SDK subscriptions):

| Event                    | When                        |
| ------------------------ | --------------------------- |
| `agent_spawned`          | Worker process started      |
| `worker_ready`           | Worker connected to relay   |
| `agent_idle`             | Worker waiting for messages |
| `agent_exited`           | Worker process ended        |
| `agent_permanently_dead` | Worker failed after retries |

## Fleet and Capabilities

When you coordinate across nodes rather than only the local broker, capabilities
and placement come into play:

```bash
# Enable fleet nodes for the workspace FIRST — it is off by default, and a
# node you bring up before enabling will not register/list
agent-relay fleet enable
agent-relay fleet config          # inspect workspace fleet config
agent-relay fleet status          # local broker status + this node's provider attachment

# Bring this node up, serving its node definition (advertises its capabilities).
# `fleet serve` was replaced by `node up`; --config points at the node file
# (auto-discovers agent-relay.{ts,tsx,js,...} when omitted)
agent-relay node up --config ./node.ts

# List fleet nodes in the workspace
agent-relay fleet nodes

# Register a custom capability (command) on this node — both flags are required
agent-relay capabilities register <command> --description "<what it does>" --handler <agent>
agent-relay capabilities list
```

From the relay MCP, `query_nodes` finds nodes by capability or name and `spawn`
invokes the fleet spawn action — the engine places it on an eligible node (or a
named `target_node`).

### Is the node actually available?

`online` is not the same as **available for placement**. A node can be live and
still never receive a spawn. Check the capability list, not the status field:

```bash
# `fleet nodes` HIDES offline/non-fleet records by default (it hid 385 of 390
# on a real workspace), so a node you are looking for may simply not be printed.
agent-relay fleet nodes --all > /tmp/nodes.raw    # redirect: output truncates at 64KB through a pipe
python3 - <<'PY'
import json, re
raw = open("/tmp/nodes.raw").read()
m = re.search(r"^\{", raw, re.M)          # first brace at start of a line, not inside the preamble
if not m:
    raise SystemExit("No JSON in output. Raw:\n" + raw[:500])
for n in json.loads(raw[m.start():]).get("nodes", []):
    caps = [c["name"] for c in n.get("capabilities", [])]
    print(f'{n.get("name")}  id={n.get("id")}  {n.get("status")}  live={n.get("live")}  {caps}')
PY
```

`id` is printed because that is the field you compare against in the placement
proof below — `dispatchedNodeId` is a node **id**, not a name.

A placement target must carry the `spawn:<agent-type>` capability for the spawn
you are requesting — a node advertising only `spawn:claude` is a valid target for
`fleet spawn claude` and not for `fleet spawn codex`. `release` and
`relay:delivery-cursor-v1` are separate lifecycle capabilities, needed to manage
the worker once placed. A record with no `spawn:*` capability at all is
registered but cannot receive a spawn.

Prove placement end to end rather than trusting the roster — spawn **from a
different machine** so you are testing placement and not a local spawn, confirm
`dispatchedNodeId` matches the target's node id, then verify on the target host
that the process actually exists, and release:

```bash
# STEP 0 — run everything below from a machine OTHER than <node>. Spawning on the
# same host you are testing proves nothing about placement.

# Read the token without leaving it in shell history or `ps` argv.
read -r -s -p 'Agent token: ' RELAY_AGENT_TOKEN; printf '\n'
export RELAY_AGENT_TOKEN
trap 'unset RELAY_AGENT_TOKEN' EXIT

agent-relay fleet spawn claude \
  --name placement-proof --node <node> --channel general \
  --task "Run hostname -s and reply with its output only." > /tmp/spawn.json

# STEP 1 — the control plane says it dispatched where you asked. The response carries
# a human-readable preamble before the JSON. Never abort here: a failed spawn is a
# result, and a traceback would skip the STEP 3 release and leak a running agent.
python3 - <<'PY'
import json, re
raw = open("/tmp/spawn.json").read()
m = re.search(r"^\{", raw, re.M)          # first brace at start of a line
inv = None
if m:
    try:
        inv = json.loads(raw[m.start():]).get("invocation")
    except ValueError:
        pass
if not inv:
    print("Spawn did not return an invocation — it likely failed. Raw output:\n" + raw)
else:
    print("dispatched to:", inv.get("dispatchedNodeId"),
          "| name:", (inv.get("node") or {}).get("name"),
          "| status:", inv.get("status"))
PY
# `dispatchedNodeId` must equal <node>'s `id` from the roster command above — it is an
# id (`node_…`), not a name. A mismatch means placement ignored your target; a match
# still proves nothing about execution, hence STEP 2.

# STEP 2 — the process actually exists. Run this ON THE TARGET HOST.
pgrep -fl placement-proof            # broker pty + CLI process must both be present

# STEP 3 — release from the control plane. Works regardless of how the node's broker
# was started. Do NOT use `node agent release` here: a fleet node started with
# --state-dir (as the LaunchAgent does) is unreachable from that subcommand.
agent-relay fleet release placement-proof
```

Steps 1 and 2 are separate claims. Step 1 alone is the mistake that makes a broken
node look healthy — dispatch is recorded by the control plane whether or not
anything ran.

### Enrolling a new machine as a fleet node

Enrollment is a two-step API flow — mint on the control plane, redeem from the
node:

1. `POST /api/v1/fleet/enrollment-tokens` → single-use `ocl_node_enr_…`
2. `POST /api/v1/fleet/register`, from the machine being enrolled

The node-side script is `sandbox-node-bootstrap.sh`, with
`README.md` alongside it as the authoritative reference. Both live at
`dev-stack/fleet-node-bootstrap/` in the **`AgentWorkforce/cloud`** repository —
they are not shipped with this skill, so you need access to that repo to run an
enrollment. It supports Daytona, CF Containers, the local dev-stack runner, and
Mac minis.

The script takes its inputs from the environment so secrets never reach `ps`
argv. Populate the token with a silent read so it does not land in shell history
either:

```bash
read -r -s -p 'Enrollment token: ' RELAY_ENROLLMENT_TOKEN; printf '\n'
trap 'unset RELAY_ENROLLMENT_TOKEN' EXIT

RELAY_ENROLLMENT_TOKEN="$RELAY_ENROLLMENT_TOKEN" \
RELAY_ENROLLMENT_URL='https://<app>/api/v1/fleet/register' \
RELAY_NODE_NAME='<name>' \
  sandbox-node-bootstrap.sh enroll
```

> **Never skip `sandbox-node-bootstrap.sh preflight` on a machine that already
> runs brokers.** `agent-relay node up` calls `killOrphanedBrokerProcesses(projectRoot)`
> at startup, terminating **every broker whose CWD is that root**. `findProjectRoot()`
> walks up for markers (`.git`, `package.json`, `.agentworkforce/relay`), so a
> `$HOME`-rooted workdir resolves `projectRoot=$HOME` and reaps every
> `$HOME`-rooted broker. That is relay#1328 — a real incident that killed
> production brokers on a shared machine. Pin `AGENT_RELAY_PROJECT` to a unique
> per-instance dir and drop a physical `.agentworkforce/relay` marker there.

Enrollment persists to `~/.agentworkforce/relay/fleet-enrollments.json` (holds a
live `nt_live_…` node token — never echo this file). Once enrolled, a
`com.agentrelay.fleet-node` LaunchAgent brings the node back automatically across
reboots; a rebooted machine does **not** need re-enrolling.

### Reaching a `--state-dir` broker

`agent-relay node up --state-dir <dir>` (how the `com.agentrelay.fleet-node`
LaunchAgent starts every fleet node) writes its connection file to
`<dir>/connection.json`. Every `node agent` subcommand except `attach` reads only
the **default** `~/.agentworkforce/relay/connection.json`, rejects `--state-dir`,
and ignores `AGENT_RELAY_DATA_DIR` — so those subcommands report
`No running broker found` against a perfectly healthy broker (`relay#1446`).

**Prefer the control plane.** `agent-relay fleet nodes`, `fleet spawn` and
`fleet release` need no local connection file and work on any node regardless of
how its broker was started. Reach for the workaround below only for a node-local
subcommand that has no fleet equivalent.

```bash
DEF=~/.agentworkforce/relay/connection.json
SD=<state-dir>                       # the --state-dir the broker was started with

# -e alone is FALSE for a dangling symlink, which is exactly what a previous run
# leaves behind if it died before its cleanup — so test -L as well, or `ln -s`
# fails with "File exists" and the subcommand silently never runs.
if [ -e "$DEF" ] || [ -L "$DEF" ]; then
  echo "REFUSING: $DEF already exists — on some hosts this is a real connection file"
  echo "and clobbering it would break the default broker. If it is a dangling symlink"
  echo "from an interrupted run, remove it; otherwise inspect it before proceeding."
else
  mkdir -p "$(dirname "$DEF")"       # may not exist yet on a freshly provisioned node
  ln -s "$SD/connection.json" "$DEF"
  agent-relay node agent list        # ... or whichever node-local subcommand you need
  [ -L "$DEF" ] && rm "$DEF"         # remove ONLY a symlink, and only one we created
fi
```

Never use `ln -sf` here. The `-f` silently destroys a pre-existing connection file,
and that file is a real regular file on some hosts — not a stale leftover. Delete
this whole workaround once `relay#1446` lands rather than letting it outlive the bug.

## Common Mistakes

| Mistake                                                  | Fix                                                                                                                                                                                            |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-relay: command not found` or mise/asdf shim error | Ensure Node is available first (`node --version`); if a shim is broken, fix the runtime manager, then install/use `agent-relay`                                                                |
| "Nested session" error                                   | Broker handles this automatically; if running manually, unset `CLAUDECODE` env var                                                                                                             |
| Broker not starting                                      | Try `agent-relay node down` first, then `agent-relay node up --background --verbose` and `agent-relay node status --wait-for 10`                                                            |
| Broker not ready after `node status --wait-for`         | The process is alive but the broker API is not ready; inspect logs, retry readiness, or restart with `agent-relay node down --force` if it remains stuck                                      |
| Broker stops immediately after start                     | Check `ps aux \| grep agent-relay-broker` and `.agentworkforce/relay/connection.json`; if the process is alive but status is stopped, rerun status from the project root or pass `--state-dir` |
| Half-started broker: process alive but `node status` says stopped and `Failed to read broker connection metadata` | `node up` spawned a broker that never finished writing connection metadata (readiness timed out) and was not cleaned up. Do NOT just retry `node up` — it won't reap the orphan. Point **every** command at the same state dir — carrying it on only one kills one broker and then starts and inspects a different one. Order matters: the orphan's pid lives in `$SD`, so read it **before** anything deletes or recreates that directory. `SD=.agentworkforce/relay` (or the `--state-dir` the broker was started with), then (1) `agent-relay node down --force --state-dir "$SD"`; (2) if it is still alive, read the pid from `$SD` **now** and `kill` that single pid; (3) `rm -rf "$SD"`; (4) `agent-relay node up --state-dir "$SD"`; (5) `agent-relay node status --state-dir "$SD" --wait-for 30`. Doing (2) after (3)/(4) reads the **new** broker's pid and kills the healthy replacement while the orphan survives. **Never `pkill -f agent-relay-broker`** — `-f` matches the full command line, so on a shared host that kills every other project's broker and the agent PTYs they own |
| Worktree verification leaves git status dirty            | Run `agent-relay node down --force`, then remove generated `.agentworkforce/relay/` and `.mcp.json` from throwaway validation worktrees before committing                                    |
| Spawn fails with `internal reply dropped`                | Broker likely is not fully ready yet; wait for readiness, then spawn one worker first                                                                                                          |
| Workers not connecting                                   | Ensure broker started; check `agent-relay node agent list` and worker logs                                                                                                                   |
| Not monitoring workers                                   | Attach with `agent-relay node agent attach <name> --mode view` frequently to track progress                                                                                                  |
| Workers seem stuck                                       | Inspect with `agent-relay node agent attach <name> --mode view` for errors                                                                                                                   |
| Messages not delivered                                   | Check channel history with `list_messages(channel: "general")`; for new DMs use `check_inbox`, for already-read DM history use `list_dms` + `agent-relay message dm list <conversationId>`      |
| CLI send fails with `requires agentToken or agentClient` | Plain-shell sends need an agent token — register an `orchestrator` identity and pass it via `RELAY_AGENT_TOKEN` (see Plain-Shell Orchestration). Channel reads need no token                    |
| Monitor loop never matches the DONE post                 | `agent-relay message list <channel>` returns **newest first**; in `node tail`, message text is in `relay_inbound` events' `body` field                                                          |
| Tried to read replies with `node tail`                  | `node tail` streams broker events; `node tail --agent <name>` streams the worker's raw output — neither is durable messages. Read replies with `check_inbox` / `list_messages` / `get_message_thread` |
| Worker DM to `broker` fails with `Agent "broker" not found` | Expected — `broker` is the broker's internal routing self-name, not a DM-able agent. Workers must ACK/DONE to `orchestrator` or `general`. Fix the worker task prompt; never instruct "DM the broker" |
| `node status` says running but `node agent list`/MCP calls return empty or `Failed to query broker session` | The CLI is dialing a **stale/wrong broker** — leftover `.agentworkforce/relay/connection.json` from a prior run on an old port, or a second broker process. `ps aux \| grep -c '[a]gent-relay-broker'` (>1 ⇒ kill extras), compare `.agentworkforce/relay/connection.json` to the actual listening port, then `agent-relay node down --force`, delete `.agentworkforce/relay/`, `agent-relay node up` clean |
| `Invalid agent token` while broker + workers keep working | The orchestrator shell has an **unresolved `${RELAY_WORKSPACE_KEY}`-style template** being used as a literal key (broker/workers hold real tokens). Ensure the workspace key/token is actually resolved in the orchestrator env |
| New worker appears in `node agent list` but no ACK yet  | Expected — appearing means process up (~5s); the CLI cold-starts for another 30–45s before its first ACK DM. Wait ≥60s before troubleshooting a fresh worker                                   |
| A node you know exists is missing from `agent-relay fleet nodes` | The default view hides offline/non-fleet records (385 of 390 hidden on a real workspace) — and the node may be present but past the cut. Use `agent-relay fleet nodes --all` |
| `fleet nodes` JSON fails to parse mid-object | Output **truncates at 64KB** through a pipe. Redirect to a file first (`agent-relay fleet nodes --all > /tmp/nodes.raw`) and parse the file, never the pipe |
| `node agent list`/`release` says `No running broker found (…/relay/connection.json does not exist)` while the fleet node is clearly running | The subcommand is reading the **default** connection path, not the broker's `--state-dir` one (`relay#1446`). Use the control-plane equivalent — `agent-relay fleet release <name>` / `fleet nodes` — which needs no local connection file. See [Reaching a `--state-dir` broker](#reaching-a---state-dir-broker) for the guarded workaround when only a node-local subcommand will do |
| Targeted `fleet spawn` fails with `Targeted Fleet spawn requires an agent token` | Pass `--token` or set `RELAY_AGENT_TOKEN`; mint one with `agent-relay agent register <name> --type system` (capture it without echoing). `--task` is also mandatory and the error only surfaces one problem at a time |
| Node shows `online` but never receives a spawn | `online` ≠ available. Check `capabilities` contains `spawn:*` — a record can be live with no spawn capacity. Confirm with a throwaway targeted spawn, verified by `pgrep` **on the target host**, then release |
| Harness blocks `sleep 25; check_inbox ...`               | Bare foreground `sleep` wait loops are disallowed in harnessed environments. Run the poll loop with `run_in_background` (or Monitor + until-loop); the inline `sleep` snippets show logic only |
| Worker self-removed; can't send review fixes             | Instruct workers not to self-remove until told. If already gone, spawn a fresh worker and re-inject branch + commit SHA + full verdict (see Multi-Round Review Loops)                          |
| Told the user to open an observer URL built from the workspace key | That is an admin credential in a query string, and the realtime endpoint rejects it. Run `agent-relay observer` (or `get_observer_url`) and share the `ot_live_` URL it returns |
| Worker died silently; loop hangs                         | Inbox polling fires on messages only. Poll `agent-relay node agent list` for liveness and set a wall-clock fallback (~30 min ScheduleWakeup)                                                  |

## Prerequisites

1. **agent-relay CLI installed** (required)

   ```bash
   npm install -g agent-relay
   # Or use npx without installing: npx agent-relay <command>
   ```

2. **For spawning Claude agents**: Valid Anthropic credentials
   - Set `ANTHROPIC_API_KEY` or authenticate via `claude auth login`

3. **For MCP-based coordination**: run `agent-relay mcp` as the relay MCP stdio
   server in your client's MCP settings, then register the session once with
   the `register_agent` tool (as `orchestrator`). Messaging tools (`send_dm`,
   `post_message`, `check_inbox`, …) work only after that call — before it they
   fail with `Not registered. Call the "register_agent" tool first.`
