# Critical Paths

These are the product sequences to run first after a related change. They use the exact public surface recorded in `manifest.yaml`; detailed fixtures, assertions, and cleanup live in `verify/procedures.md`.

## Path 1: Relay Init For Your Tools

Run in a disposable home, or use the automated form: `node tests/relayflows/core/init-parity.mjs`.

```bash
relay init --tools claude,codex,cursor,grok
relay status
relay init --uninstall
relay init --stop
```

Each tool must report injection, its own settings file must gain the route, and `--uninstall` must remove it and keep the person's settings.

## Path 2: A Message Reaches A Running Session

Use real sessions, or the automated forms: `node tests/relayflows/core/delivery.mjs` and `node tests/relayflows/core/grok-join.mjs`.

```bash
relay agent list
relay agent register alice
relay message dm send <session-name> 'hello' --as alice
```

The session must join on its own and receive the message as a new turn, without checking an inbox.

## Path 3: Cross-Agent Channel Message

**Prerequisite:** disposable hosted workspace; `TOKEN_A` must be the token returned for
`critical-a`, and `TOKEN_B` must be the token returned for `critical-b`.

```bash
RELAY_AGENT_TOKEN="$TOKEN_A" relay channel create critical-path
RELAY_AGENT_TOKEN="$TOKEN_A" relay channel invite critical-path critical-b
POST="$(RELAY_AGENT_TOKEN="$TOKEN_A" relay message post critical-path 'critical-path-message')"
RELAY_AGENT_TOKEN="$TOKEN_B" relay message list critical-path --limit 10
RELAY_AGENT_TOKEN="$TOKEN_A" relay channel archive critical-path
```

Agent B must see the exact text from A. Remove both test identities after archiving the channel.

## Path 4: MCP Stdio Round Trip

**Prerequisite:** disposable hosted workspace and an MCP JSON-RPC client.

```text
start relay mcp over stdio
initialize → tools/list → prompts/list
set_workspace_key or create_workspace → register_agent(A and B)
create_channel → post_message → list_messages
reply_to_thread → get_message_thread
send_dm → list_dms → check_inbox → mark_message_read → get_message_readers
close the stdio child
```

Assert every static MCP tool in the manifest is listed and that the returned content reflects the values written by the test. The messaging tools require a workspace and agent identities.

## Path 5: Local Workflow Run, Logs, and Sync

```bash
echo 'console.log("critical-workflow-ok")' > workflow.js
RUN_JSON="$(relay node workflow run workflow.js --json)"
RUN_ID="$(jq -er .runId <<<"$RUN_JSON")"
relay node workflow logs "$RUN_ID" --follow --json
relay node workflow sync "$RUN_ID" --dry-run --json
```

Assert completed status and the sentinel output. Run it in a disposable project because local workflow records are retained.

## Path 6: Direct Message and Read Receipt

**Prerequisite:** disposable hosted workspace; `TOKEN_A` must be the token returned for
`critical-a`, and `TOKEN_B` must be the token returned for `critical-b`.

```bash
DM="$(RELAY_AGENT_TOKEN="$TOKEN_A" relay message dm send critical-b 'critical-dm')"
DM_ID="$(jq -er '.id // .messageId' <<<"$DM")"
CONV_ID="$(jq -er '.conversationId // .conversation_id' <<<"$DM")"
RELAY_AGENT_TOKEN="$TOKEN_B" relay message dm list "$CONV_ID"
RELAY_AGENT_TOKEN="$TOKEN_B" relay message inbox mark_read "$DM_ID"
RELAY_AGENT_TOKEN="$TOKEN_A" relay message inbox get_readers "$DM_ID"
```

Assert B reads the exact DM and A sees B in readers. Remove the disposable agents afterward.

## Fast Health Triage

```bash
relay version
relay status
relay agent list
```

If any command fails, diagnose that subsystem before testing higher-level paths.
