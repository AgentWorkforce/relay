---
name: orchestrating-agent-relay
description: The canonical way to run agent-relay - self-bootstrap the local broker and autonomously spawn, monitor, and coordinate a team of worker agents without human intervention. Covers infrastructure startup, agent spawning, lifecycle monitoring, message-based reading via the relay MCP, and team coordination.
---

### Overview

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

### The model

- Agent Relay delivers messages **node-only**: every agent is owned by a node,
- A **fleet** is the set of nodes advertising **capabilities** (`spawn:<harness>`
- Agent-to-agent coordination is messages — channels, DMs, threads — plus

### When to Use

- Agent needs full control over its worker team
- No human available to run `agent-relay node up` manually
- Agent should manage agent lifecycle autonomously
- Building self-contained multi-agent systems

### Quick Reference

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

### Bootstrap Flow

#### Step 0: Verify Installation

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

#### Step 1: Start the Broker

```bash
# Starts a detached broker and returns after API readiness
agent-relay node up --background --verbose
```

#### Step 2: Spawn Workers

```bash
agent-relay node agent spawn claude \
  --name Worker1 \
  --task "Implement the authentication module following the existing patterns"
```

#### Step 2.5: Give the Human a Way to Watch (optional)

```bash
agent-relay observer
```

#### Step 3: Monitor and Coordinate

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

#### Step 4: Release Workers

```text
remove_agent(name: "Worker1", reason: "Work accepted")
```

#### Step 5: Shutdown (optional)

```bash
agent-relay node down
```


### Coordination Commands

#### Channel vs DM — When to Use Each

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

#### Plain-Shell Orchestration (no relay MCP configured)

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

#### Monitoring Workers (Essential)

```bash
# Exits the moment a matching relay_inbound event arrives.
# Anchor on the body VALUE starting with the marker — not a loose substring.
agent-relay node tail | grep -m1 '"body":"DONE Implementer r2'
```

#### Troubleshooting

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


### Orchestrator Instructions Template

#### Give your lead agent these instructions. The bootstrap/spawn/monitor commands

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


### Multi-Round Review Loops (DONE → NO-GO → fix → re-review)

#### Workers must not self-remove until you tell them

```text
Do NOT release yourself (no remove_agent / agent-relay node agent release on
yourself). Report DONE and stay alive and idle. The orchestrator will send you
review findings to fix, or release you when the work is fully accepted.
Self-removing before then breaks the fix loop.
```

#### The respawn-with-full-context fallback

```bash
agent-relay node agent spawn codex --name Implementer2 \
  --task "Continuation of prior work. \
Branch: feature/auth. Last commit: <sha>. \
The reviewer returned NO-GO with these findings: <full verdict text>. \
Check out the branch, address every finding, re-run tests, report DONE. \
Do NOT self-remove — stay alive for re-review."
```


### Lifecycle Events

`agent-relay node tail` streams broker events. The broker emits these (also
available via SDK subscriptions):

| Event                    | When                        |
| ------------------------ | --------------------------- |
| `agent_spawned`          | Worker process started      |
| `worker_ready`           | Worker connected to relay   |
| `agent_idle`             | Worker waiting for messages |
| `agent_exited`           | Worker process ended        |
| `agent_permanently_dead` | Worker failed after retries |

### Fleet and Capabilities

#### When you coordinate across nodes rather than only the local broker, capabilities

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

#### Is the node actually available?

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

#### Enrolling a new machine as a fleet node

```bash
read -r -s -p 'Enrollment token: ' RELAY_ENROLLMENT_TOKEN; printf '\n'
trap 'unset RELAY_ENROLLMENT_TOKEN' EXIT

RELAY_ENROLLMENT_TOKEN="$RELAY_ENROLLMENT_TOKEN" \
RELAY_ENROLLMENT_URL='https://<app>/api/v1/fleet/register' \
RELAY_NODE_NAME='<name>' \
  sandbox-node-bootstrap.sh enroll
```

#### Reaching a `--state-dir` broker

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


### Common Mistakes

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

### Overview

Self-bootstrap agent-relay infrastructure and manage a team of agents autonomously.

### Prerequisites

#### 1. **agent-relay CLI installed** (required)

```bash
npm install -g agent-relay
   # Or use npx without installing: npx agent-relay <command>
```
