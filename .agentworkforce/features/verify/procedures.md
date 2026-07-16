# Feature Verification Procedures

How an agent verifies that each feature works from a user perspective. Organized by tier (what's required to run). Always run lower tiers first — they establish prerequisites for higher ones.

---

## Tier 1 — No dependencies

Features that can be verified with just the CLI installed. Run these first.

### CLI Health

```bash
relay version
# → prints version string like "10.x.x"

relay --help
# → shows command list without error

relay telemetry status
# → prints "enabled" or "disabled"

relay workspace list
# → prints list (may be empty) without error
```

### Setup and Doctor

```bash
relay version
# → confirms CLI is installed (relay setup does not exist)

relay node --help
# → shows node subcommand options without error
```

Pass criteria: all commands exit 0, output is non-empty and sensibly formatted.

---

## Tier 2 — Broker running

Start the broker first: `relay node up --background`

Confirm it started: `relay status` should show "running".

### Broker Lifecycle

```bash
relay node up --background
relay status
# → shows "running", agent count, queue stats

relay metrics
# → shows memory, CPU, message throughput

relay deadletters
# → shows empty list or existing dead letters (not an error)

relay node down
relay status
# → shows "stopped" or "not running"

relay node up --background   # restart for subsequent tests
```

### Agent Management

```bash
# Register agents
relay agent register verify-agent-1
# → prints token: RELAY_AGENT_TOKEN=<token>

relay agent list
# → shows verify-agent-1 in list

relay agent remove verify-agent-1
relay agent list
# → verify-agent-1 no longer appears
```

### Local Agent Orchestration

```bash
relay node agent list
# → shows empty list or running agents

# If claude harness is available:
relay node agent spawn claude --name test-worker
relay node agent list
# → shows test-worker with status active

relay node agent message hold test-worker
# → message delivery paused

relay node agent message auto test-worker
# → message delivery resumed

relay node agent release test-worker
relay node agent list
# → test-worker no longer appears
```

### Local Workflow

```bash
# Requires a minimal workflow file; check examples/ or create one:
cat > /tmp/test-workflow.yaml << 'EOF'
version: "1"
swarm:
  agents:
    - name: test-agent
      harness: claude
  workflows:
    - name: health-check
      steps:
        - agent: test-agent
          prompt: "Reply with just: OK"
EOF

relay node workflow run /tmp/test-workflow.yaml
# → executes without crashing, agent responds
```

### Workspace

```bash
relay workspace active
# → prints active workspace name/id

relay workspace list
# → lists stored workspaces
```

### Fleet Status

```bash
relay fleet status
# → shows local broker status and provider attachment (even if no fleet configured)
```

Pass criteria: each command exits 0, output matches expected description.

---

## Tier 3 — Broker running + agent token

Register at least one agent (`relay agent register <name>`) and export its token:

```bash
export RELAY_AGENT_TOKEN=$(relay agent register verify-agent | grep -oP 'RELAY_AGENT_TOKEN=\K\S+')
```

Or pass `--token <value>` to commands that support it.

### Channel Operations

```bash
# Create
relay channel create verify-test-channel
# → success message

# List
relay channel list
# → shows verify-test-channel

# Join
relay channel join verify-test-channel
# → success message

# Set topic
relay channel set_topic verify-test-channel "verification test"
# → success message

# Leave
relay channel leave verify-test-channel
# → success message

# Archive
relay channel archive verify-test-channel
# → success message
relay channel list
# → verify-test-channel absent (or present with archived flag if --archived passed)
```

### Message Operations

```bash
# Post
relay channel create verify-msgs
relay channel join verify-msgs
relay message post verify-msgs "verification message $(date +%s)"
# → success

# List and confirm delivery
relay message list verify-msgs --limit 1
# → shows the message just posted with correct text

# Reply (create thread)
MSG_ID=$(relay message list verify-msgs --limit 1 --json | jq -r '.[0].id')
relay message reply "$MSG_ID" "thread reply"
# → success

# Get thread
relay message get_thread --message-id "$MSG_ID"
# → shows original message + the reply

# Search
relay message search --query "verification"
# → returns at least one result containing the posted message

# Inbox
relay message inbox check
# → shows unread count (may be 0 if no messages directed to this agent)

# Mark read
relay message inbox mark_read --message-id "$MSG_ID"
# → success
```

### Reactions

```bash
relay message reaction add --message-id "$MSG_ID" --emoji thumbsup
# → success

relay message reaction remove --message-id "$MSG_ID" --emoji thumbsup
# → success
```

### Webhooks (requires auth token)

```bash
relay integration webhook list
# → success (empty or populated)

relay integration webhook create --url https://example.com/hook --events message.created
# → prints webhook id

HOOK_ID=$(relay integration webhook list --json | jq -r '.[0].id')
relay integration webhook delete "$HOOK_ID"
# → success
```

### Subscriptions

```bash
relay integration subscription list
# → success (empty or populated)
```

Pass criteria: all channel/message round-trips show data that matches what was written.

---

## Tier 4 — Broker running + two agents

Register two agents and test cross-agent features:

```bash
export TOKEN_A=$(relay agent register verify-alice | grep -oP 'RELAY_AGENT_TOKEN=\K\S+')
export TOKEN_B=$(relay agent register verify-bob | grep -oP 'RELAY_AGENT_TOKEN=\K\S+')
```

### Channel Invite

```bash
RELAY_AGENT_TOKEN=$TOKEN_A relay channel create private-verify
RELAY_AGENT_TOKEN=$TOKEN_A relay channel join private-verify
RELAY_AGENT_TOKEN=$TOKEN_A relay channel invite private-verify verify-bob
# → success

RELAY_AGENT_TOKEN=$TOKEN_B relay channel list
# → shows private-verify as a channel bob is in
```

### Direct Messages

```bash
# Send DM and capture conversationId from JSON output:
RELAY_AGENT_TOKEN=$TOKEN_A relay message dm send verify-bob "hello bob"
# → success; note the conversationId from the JSON response

# dm list requires the conversationId returned by send:
# RELAY_AGENT_TOKEN=$TOKEN_B relay message dm list <conversationId>

RELAY_AGENT_TOKEN=$TOKEN_A relay message dm send_group "group hello" --to verify-bob
# → success
```

### Read Receipts

```bash
MSG_ID=$(RELAY_AGENT_TOKEN=$TOKEN_A relay message list private-verify --limit 1 --json | jq -r '.[0].id')
RELAY_AGENT_TOKEN=$TOKEN_B relay message inbox mark_read --message-id "$MSG_ID"

RELAY_AGENT_TOKEN=$TOKEN_A relay message inbox get_readers --message-id "$MSG_ID"
# → shows verify-bob has read the message
```

### Cleanup

```bash
relay agent remove verify-alice
relay agent remove verify-bob
```

Pass criteria: messages posted by agent A appear in agent B's list, DMs route correctly.

---

## Tier 5 — Cloud auth required

Requires `relay cloud login` to have been completed.

### Auth Checks

```bash
relay cloud whoami
# → shows authenticated user/org

relay cloud session
# → shows session details (workspace, expiry, etc.)
```

### Cloud Workflow Run

```bash
relay cloud run examples/basic-workflow.yaml
# → prints run ID

RUN_ID=<id from above>
relay cloud status "$RUN_ID"
# → shows run status (queued, running, completed)

relay cloud logs "$RUN_ID"
# → shows log output from the run
```

### Schedules

```bash
relay cloud schedule examples/basic-workflow.yaml --cron "0 * * * *"
# → prints schedule ID

relay cloud schedules
# → shows the schedule just created
```

Pass criteria: cloud commands return data consistent with the authenticated account.

---

## Tier 6 — Manual / Browser

These cannot be automated from CLI. A human must verify them.

| Feature                              | How to Verify                                                               |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `relay cloud login`                  | Open browser OAuth flow, complete auth, check `relay cloud whoami` succeeds |
| Cursor harness                       | Open Cursor, run cursor-agent, confirm PTY injection works                  |
| Web dashboard (relay-dashboard repo) | Navigate to dashboard, confirm agents/channels visible                      |
| `relay cloud connect`                | SSH session must complete provider auth interactively                       |
| `relay cloud enroll`                 | Machine enrollment requires cloud account and browser confirmation          |

---

## Verification Checklist by Change Type

Use this to determine which tiers to run:

| Change area                                                        | Tiers to run                         |
| ------------------------------------------------------------------ | ------------------------------------ |
| Broker Rust code (`crates/broker/`)                                | 1, 2, 3, 4                           |
| PTY/harness code (`crates/relay-pty/`, `packages/harness-driver/`) | 2 (spawn tests)                      |
| CLI commands (`packages/cli/src/cli/commands/`)                    | 1 + tier matching the command        |
| MCP tools (`packages/cli/src/cli/mcp/`)                            | 2, 3 (MCP server + tool calls)       |
| SDK (`packages/sdk/`)                                              | 3, 4                                 |
| Cloud client (`packages/cloud/`)                                   | 5                                    |
| Any auth/token change                                              | 2, 3, 4                              |
| Message ordering/delivery                                          | 3, 4 (post then list, confirm order) |
| Harness definitions (`packages/harnesses/`)                        | 2 (spawn that harness)               |

---

## Quick Sanity Check (Run After Any Change)

```bash
relay version && relay status || relay node up --background && relay status
relay agent register quick-check-$(date +%s)
relay agent list
relay channel create quick-check-ch
relay channel join quick-check-ch
relay message post quick-check-ch "sanity $(date)"
relay message list quick-check-ch --limit 1
relay channel archive quick-check-ch
relay agent remove quick-check-$(date +%s)
```

All steps should succeed. Total runtime: under 10 seconds.
