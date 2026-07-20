# Feature Verification Procedures

This document is the executable companion to `../manifest.yaml`. Its `verification.categories` map assigns every feature in a category to one procedure below. The tier orders work, but never replaces the stated prerequisites, assertions, cleanup, or automation limitation.

Use `relay` (or the equivalent `agent-relay` binary). Run all mutations in a disposable project, workspace, account, configuration directory, or provider fixture. Never use global `update`, non-dry-run `sync`/`uninstall`, `node down --all`, or production credentials in an unattended test.

## Shared fixtures

For a local broker, use a disposable project and only stop the broker it created:

```bash
RUN="feature-$(date +%s)"; TMP="$(mktemp -d)"; cd "$TMP"
relay node up --background --no-spawn
trap 'relay node down --force 2>/dev/null || true; rm -rf "$TMP"' EXIT
```

For hosted APIs, use explicit disposable credentials rather than an operator's active workspace:

```bash
export RELAY_WORKSPACE_KEY='<disposable workspace key>'
export RELAY_BASE_URL='<test API URL>'
RUN="feature-$(date +%s)"
A_JSON="$(relay agent register "audit-a-$RUN")"; TOKEN_A="$(jq -er .token <<<"$A_JSON")"
B_JSON="$(relay agent register "audit-b-$RUN")"; TOKEN_B="$(jq -er .token <<<"$B_JSON")"
cleanup_agents() { relay agent remove "audit-a-$RUN" 2>/dev/null || true; relay agent remove "audit-b-$RUN" 2>/dev/null || true; }
```

SDK-backed CLI commands emit JSON already; do not add an unsupported `--json` flag.

## broker-lifecycle

**Features:** `broker-up`, `broker-down`, `broker-status`, `broker-metrics`, `broker-deadletters`, `broker-redeliver`.

**Prerequisites:** local fixture and broker binary.

```bash
relay node status | grep -Eiq 'running|stopped'
relay node metrics | jq -e 'type == "object"'
relay node deadletters --json | jq -e 'type == "object" or type == "array"'
relay status | grep -Eiq 'Local broker:'
relay node down; relay node status | grep -Eiq 'stopped|not running'
```

Assert daemon state and structured metrics/deadletters, then restart only when a later local test needs it. A successful redelivery needs a real dead-letter addressed to a live worker; the public CLI cannot seed one. Use the broker integration fixture, run exactly one of `relay node redeliver <id>` or `relay node redeliver --all`, and assert the delivery leaves the dead-letter queue.

## workspace-agents-and-capabilities

**Features:** `agent-register`, `agent-add`, `agent-list`, `agent-remove`, `agent-capabilities`, `capabilities-register`, `capabilities-delete`, `system-status`.

**Prerequisites:** hosted fixture; a local broker is not the dependency.

```bash
CAP="audit-cap-$RUN"
relay agent list | jq -e --arg n "audit-a-$RUN" '.[] | select(.name == $n)'
relay agent add "audit-extra-$RUN" | jq -e '.token'
relay capabilities register "$CAP" --description 'audit capability' --handler "audit-a-$RUN"
relay capabilities list | jq -e --arg c "$CAP" '.[] | select(.command == $c)'
relay capabilities delete "$CAP"; relay agent remove "audit-extra-$RUN"
relay status | grep -Eiq 'Workspace:|Local broker:|Cloud:'
```

Assert list visibility after every create and absence after every delete; finish with `cleanup_agents`.

## channel-messaging

**Features:** `channel-create`, `channel-list`, `channel-join`, `channel-leave`, `channel-invite`, `channel-set-topic`, `channel-archive`.

**Prerequisites:** hosted fixture with two identities.

```bash
CH="audit-channel-$RUN"
RELAY_AGENT_TOKEN="$TOKEN_A" relay channel create "$CH" --topic 'first topic'
RELAY_AGENT_TOKEN="$TOKEN_A" relay channel join "$CH"
RELAY_AGENT_TOKEN="$TOKEN_A" relay channel set_topic "$CH" 'second topic'
RELAY_AGENT_TOKEN="$TOKEN_A" relay channel invite "$CH" "audit-b-$RUN"
RELAY_AGENT_TOKEN="$TOKEN_B" relay channel list | jq -e --arg n "$CH" '.[] | select(.name == $n)'
RELAY_AGENT_TOKEN="$TOKEN_A" relay channel leave "$CH"
RELAY_AGENT_TOKEN="$TOKEN_A" relay channel archive "$CH"
RELAY_AGENT_TOKEN="$TOKEN_A" relay channel list --archived | jq -e --arg n "$CH" '.[] | select(.name == $n)'
```

Assert the new topic and invited-agent membership, not just success output. Archive the test channel and remove test identities.

## message-round-trip

**Features:** `message-post`, `message-list`, `message-reply`, `message-get-thread`, `message-search`, `message-file-upload`.

**Prerequisites:** hosted fixture and a channel owned by A.

```bash
CH="audit-messages-$RUN"; TEXT="audit message $RUN"
RELAY_AGENT_TOKEN="$TOKEN_A" relay channel create "$CH"
POST="$(RELAY_AGENT_TOKEN="$TOKEN_A" relay message post "$CH" "$TEXT")"; MSG_ID="$(jq -er '.id // .messageId' <<<"$POST")"
RELAY_AGENT_TOKEN="$TOKEN_A" relay message list "$CH" --limit 10 | jq -e --arg t "$TEXT" '.[] | select(.text == $t)'
RELAY_AGENT_TOKEN="$TOKEN_A" relay message reply "$MSG_ID" 'audit reply'
RELAY_AGENT_TOKEN="$TOKEN_A" relay message get_thread "$MSG_ID" | jq -e 'tostring | contains("audit reply")'
RELAY_AGENT_TOKEN="$TOKEN_A" relay message search "$RUN" --channel "$CH" --from "audit-a-$RUN" | jq -e 'tostring | contains("audit message")'
echo "attachment $RUN" > "$TMP/attachment.txt"
RELAY_AGENT_TOKEN="$TOKEN_A" relay message file upload "$TMP/attachment.txt" --channel "$CH" --text 'attachment audit'
RELAY_AGENT_TOKEN="$TOKEN_A" relay message list "$CH" --limit 20 | jq -e 'tostring | contains("attachment audit")'
RELAY_AGENT_TOKEN="$TOKEN_A" relay channel archive "$CH"
```

Assert that the returned parent ID links the reply, search filters return the unique text, and the attachment is listed. Remove the temp file, archive, and call `cleanup_agents`.

## direct-messages

**Features:** `dm-send`, `dm-list`, `dm-list-conversations`, `dm-send-group`.

**Prerequisites:** hosted fixture; group DM needs third identity C.

```bash
C_JSON="$(relay agent register "audit-c-$RUN")"; TOKEN_C="$(jq -er .token <<<"$C_JSON")"
DM="$(RELAY_AGENT_TOKEN="$TOKEN_A" relay message dm send "audit-b-$RUN" "dm $RUN")"; CONV="$(jq -er '.conversationId // .conversation_id' <<<"$DM")"
RELAY_AGENT_TOKEN="$TOKEN_B" relay message dm list "$CONV" | jq -e --arg t "dm $RUN" 'tostring | contains($t)'
RELAY_AGENT_TOKEN="$TOKEN_A" relay message dm send_group "group $RUN" --to "audit-b-$RUN" "audit-c-$RUN"
relay agent remove "audit-c-$RUN"
```

Use `list_dms` through the MCP client and assert the same conversation appears. Assert both group recipients see it before cleanup.

## reactions-and-read-status

**Features:** `reaction-add`, `reaction-remove`, `inbox-check`, `inbox-mark-read`, `inbox-get-readers`.

**Prerequisites:** hosted fixture with two identities.

```bash
CH="audit-read-$RUN"; RELAY_AGENT_TOKEN="$TOKEN_A" relay channel create "$CH"
POST="$(RELAY_AGENT_TOKEN="$TOKEN_A" relay message post "$CH" "read $RUN")"; MSG_ID="$(jq -er '.id // .messageId' <<<"$POST")"
RELAY_AGENT_TOKEN="$TOKEN_B" relay message reaction add "$MSG_ID" thumbsup
RELAY_AGENT_TOKEN="$TOKEN_B" relay message reaction remove "$MSG_ID" thumbsup
DM="$(RELAY_AGENT_TOKEN="$TOKEN_A" relay message dm send "audit-b-$RUN" "inbox $RUN")"; DM_ID="$(jq -er '.id // .messageId' <<<"$DM")"
RELAY_AGENT_TOKEN="$TOKEN_B" relay message inbox check | jq -e --arg t "inbox $RUN" 'tostring | contains($t)'
RELAY_AGENT_TOKEN="$TOKEN_B" relay message inbox mark_read "$DM_ID"
RELAY_AGENT_TOKEN="$TOKEN_A" relay message inbox get_readers "$DM_ID" | jq -e --arg n "audit-b-$RUN" 'tostring | contains($n)'
RELAY_AGENT_TOKEN="$TOKEN_A" relay channel archive "$CH"
```

Assert the reaction is observable after add and absent after remove, and B's unread message becomes A-visible read receipt. Archive and remove identities.

## local-agent-lifecycle

**Features:** `local-agent-spawn`, `local-agent-new`, `local-agent-release`, `local-agent-list`, `local-agent-set-model`, `local-agent-attach`, `local-agent-flush`, `local-agent-hold`, `local-agent-auto`, `local-agent-tail`.

**Prerequisites:** local broker; spawn/new/set-model need an installed authenticated provider CLI and can incur cost.

```bash
AGENT="audit-worker-$RUN"
relay node agent list | jq -e 'type == "array"'
relay node agent spawn "$PROVIDER" --name "$AGENT" --task 'Reply relay-e2e-ok' --spawn-mode task-exit --exit-after-task
relay node agent list | jq -e --arg n "$AGENT" '.[] | select(.name == $n)'
relay node agent message hold "$AGENT" | jq -e 'tostring | test("manual|hold"; "i")'
relay node agent message auto "$AGENT" | jq -e 'tostring | test("auto"; "i")'
relay node agent release "$AGENT" || true
```

`new` and `attach` are attended PTY checks; verify `drive`, `view`, and `passthrough`. `tail` streams until interrupted: filter by agent, create output, assert it, then stop its exact child process. A model switch proves broker acceptance only, not provider-side model change.

## local-workflow-lifecycle

**Features:** `local-workflow-run`, `local-workflow-logs`, `local-workflow-sync`.

**Prerequisites:** disposable local project and selected workflow runtime; no broker.

```bash
echo 'console.log("relay-workflow-e2e")' > "$TMP/workflow.js"
RUN_JSON="$(relay node workflow run "$TMP/workflow.js" --json)"; RUN_ID="$(jq -er .runId <<<"$RUN_JSON")"
relay node workflow logs "$RUN_ID" --follow --json | jq -e 'tostring | contains("relay-workflow-e2e")'
relay node workflow sync "$RUN_ID" --dry-run --json | jq -e 'type == "object"'
```

Assert completed status and log content. Local run records have no delete command; remove only the disposable state/project directory.

## cloud-workflows

**Features:** `cloud-login`, `cloud-logout`, `cloud-whoami`, `cloud-session`, `cloud-connect`, `cloud-enroll`, `cloud-run`, `cloud-schedule`, `cloud-schedules`, `cloud-status`, `cloud-logs`, `cloud-sync`, `cloud-cancel`.

**Prerequisites:** dedicated Cloud account/workspace. Login and connect are browser/SSH interactive; enrollment needs a one-time test token or test-workspace mint.

```bash
relay cloud whoami
relay cloud session --json | jq -e '.apiUrl'
RUN_JSON="$(relay cloud run "$TMP/noop.yaml" --no-sync-code --json)"; CLOUD_RUN="$(jq -er '.runId // .id' <<<"$RUN_JSON")"
relay cloud status "$CLOUD_RUN" --json | jq -e 'type == "object"'
relay cloud logs "$CLOUD_RUN" --follow --json | jq -e 'type == "object"'
relay cloud sync "$CLOUD_RUN" --dry-run
```

Use a no-op workflow, long disposable workflow for cancel, and only `sync --dry-run`. Schedules lack a CLI delete, so create them only in an isolated workspace and remove through Cloud control plane. Logout only an isolated account.

## cloud-workers

**Features:** `cloud-worker-register`, `cloud-worker-start`, `cloud-worker-status`, `cloud-worker-logs`.

**Prerequisites:** dedicated enrollment token and isolated worker state.

```bash
relay cloud worker register --token "$WORKER_TOKEN" --name "audit-worker-$RUN" --json | jq -e '.workerId'
relay cloud worker start --name "audit-worker-$RUN" --daemon
relay cloud worker status --name "audit-worker-$RUN" --json | jq -e '.localDaemon'
relay cloud worker logs --name "audit-worker-$RUN"
```

Record the daemon PID/log path and terminate only that daemon; no worker-stop command exists. Use `--once` when a bounded assignment fixture is available.

## fleet-management

**Features:** `fleet-nodes`, `fleet-config`, `fleet-enable`, `fleet-disable`, `fleet-inherit`, `fleet-status`.

**Prerequisites:** disposable workspace; `fleet-status` additionally benefits from a local broker.

```bash
relay fleet nodes | jq -e '.nodes'
BEFORE="$(relay fleet config)"
relay fleet enable; relay fleet config | jq -e 'type == "object"'
relay fleet disable; relay fleet inherit; relay fleet status | jq -e '.broker'
```

Snapshot and restore configuration or discard the workspace. For full two-node dispatch/enrollment coverage, run `npm run test:e2e` with `tests/e2e/fleet/README.md` prerequisites.

## workspace-management

**Features:** `workspace-active`, `workspace-create`, `workspace-list`, `workspace-set-key`, `workspace-join`, `workspace-switch`.

**Prerequisites:** isolated `AGENT_RELAY_HOME`; active/create also require Cloud API/auth.

```bash
export AGENT_RELAY_HOME="$(mktemp -d)"
relay workspace set_key audit-one rk_live_example
relay workspace join audit-two rk_live_example_two
relay workspace switch audit-one
relay workspace list | jq -e '.active == "audit-one"'
rm -rf "$AGENT_RELAY_HOME"
```

Create remote workspaces only in a test tenant, assert `workspace active --json` returns canonical IDs, and delete them through the control plane.

## skills-installation

**Features:** `skills-add`.

**Prerequisites:** network and disposable project/configuration.

```bash
mkdir -p "$TMP/skills-project"; cd "$TMP/skills-project"
relay skills add --local --harness codex
test -e .agents/skills/orchestrate/SKILL.md
```

Assert the downloaded skill and delete only this disposable project. Do not run `--global` in automation.

## integrations-and-webhooks

**Features:** `integration-subscribe`, `integration-unsubscribe`, `integration-list-bindings`, all `webhook-*`, and all `subscription-*` entries.

**Prerequisites:** disposable workspace, identity, externally reachable controlled receiver. Relayfile also needs compatible authenticated daemon, connected provider, real provider resource, and provider observation API; first connection can require browser OAuth.

```bash
HOOK="$(relay integration webhook create "$CAPTURE_URL" --event message.created)"; HOOK_ID="$(jq -er '.id // .webhookId' <<<"$HOOK")"
relay integration webhook trigger "$HOOK_ID" --payload '{"audit":true}'
relay integration webhook list | jq -e --arg id "$HOOK_ID" 'tostring | contains($id)'
relay integration webhook delete "$HOOK_ID"
```

Assert exact receiver payload/signature, then delete it. For inbound, create channel/hook, POST the returned URL with token and documented payload, assert message, delete hook. Create/list/get/delete a unique subscription. For Relayfile, `subscribe --no-input`, assert `subscribe --list`, cause provider event and Relay reply, `unsubscribe` with same provider/resource, assert absent. Localhost cannot receive hosted webhooks.

## reflex-history

**Features:** `reflex-on`, `reflex-off`, `reflex-status`.

**Prerequisites:** isolated home; `on` is interactive and can use Cloud login.

```bash
echo y | relay reflex on; relay reflex status | grep -Eiq 'on'
relay reflex off; relay reflex status | grep -Eiq 'off'
```

Run only against a disposable home/configuration and assert cleanup leaves Reflex off.

## mcp-stdio

**Features:** `mcp-server-start` and all `mcp-*` tool/prompt entries.

**Prerequisites:** Node MCP SDK client, disposable hosted workspace, registered identities. `add_agent`, `spawn`, and `submit_result` need real provider/callback fixtures.

Launch `relay mcp` as stdio child. Initialize it, call `tools/list` and `prompts/list`, and assert all 31 static tool names in the manifest plus prompt `system`. Call `set_workspace_key`/`register_agent` for A and B; repeat channel/message/thread/DM/reaction/read assertions through MCP fields (`message_id`, `include_archived`, `participants`, `as`). Register an action before `list_actions`/`invoke_action`. Spawn only a disposable worker then `remove_agent`. Configure result callback environment before testing conditional `submit_result`, assert receiver payload, and close the child cleanly.

## harnesses

**Features:** all `harness-*` entries.

**Prerequisites:** named provider CLI installed/authenticated, disposable project, and budget; custom harness only needs the SDK contract.

Run the bounded local-agent spawn test for each installed provider with `--task`, `--spawn-mode task-exit`, and `--exit-after-task`; assert list, sentinel response, and release. PTY providers need attended verification. For a custom harness, run `npm test --workspace @agent-relay/harnesses` plus a `defineHarness` create/send/release fixture.

## typescript-sdk

**Features:** all `sdk-*` entries.

**Prerequisites:** local engine or disposable hosted workspace.

```bash
node tests/integration/sdk/v8-api-smoke.mjs
```

Assert bootstrap/reconnect, participants, channel/thread/reaction/DM/group-DM/listener/action/DeliveryRunner/webhook/node behavior. Release all identities and clean up remote workspace through its control plane; the smoke script does not delete it.

## python-sdk

**Features:** all `python-sdk-*` entries.

```bash
cd packages/sdk-py && python -m pytest
```

For true E2E, create a disposable Relay, send/receive unique message, then release agents and shut down. Adapter/workflow tests require their provider CLI and must clean up spawned work.

## swift-sdk

**Features:** `swift-sdk-hosted`, `swift-sdk-broker`.

```bash
cd packages/sdk-swift && swift test
```

Run hosted and local-broker round trips, assert receipt/listener behavior, then release identities and clean up the disposable workspace.

## opencode-plugin

**Features:** all `opencode-relay-*` entries.

```bash
npm --prefix plugins/opencode-relay-plugin test
```

Connect two disposable OpenCode sessions, prove each native tool, spawn one worker, use `relay_dismiss`, and assert idle/compaction/end hooks preserve then clean state.

## codex-relay-skill

**Features:** all `codex-relay-*` entries.

Copy the skill into a temporary `.agents/skills/agent-relay`, run setup twice, and diff resulting `.codex/config.toml`, hooks, and worker template to prove idempotence. In disposable Codex, require a relay-worker ACK/STATUS/DONE via MCP and assert hooks connect, surface inbox, and protect completion with unread work.

## gemini-relay-extension

**Features:** all `gemini-relay-*` entries.

Install with `gemini extensions install AgentWorkforce/relay`; with experimental agents and disposable workspace run `/relay:status`, `/relay:team <bounded task>`, `/relay:fanout <bounded task>`. Assert worker ACK/DONE and session-start/after-tool/before-model/stop/session-end hook behavior, including cleanup.

## cli-maintenance

**Features:** `cli-version`, `cli-update`, `cli-uninstall`.

```bash
relay version | grep -E '.'
relay update --check
relay uninstall --dry-run --keep-data
```

Assert version/update/removal-plan output. Mutating update/uninstall requires isolated OS/container and attended approval.

## telemetry

**Features:** `telemetry-enable`, `telemetry-disable`, `telemetry-status`.

```bash
export AGENT_RELAY_DATA_DIR="$(mktemp -d)"
relay telemetry disable; relay telemetry status | grep -Eiq 'Enabled: No'
relay telemetry enable; relay telemetry status | grep -Eiq 'Enabled: Yes'
rm -rf "$AGENT_RELAY_DATA_DIR"
```

Assert both persisted states; unset telemetry opt-out environment variables because they override stored preference.

## node-command-discovery

**Features:** `node-up`, `node-workflow`.

```bash
relay node up --help | grep -Eiq 'config|no-spawn'
relay node workflow --help | grep -Eiq 'run|logs|sync'
```

Use `broker-lifecycle` for start behavior and `local-workflow-lifecycle` for the three workflow leaves. This group procedure is discoverability only, not workflow execution.
