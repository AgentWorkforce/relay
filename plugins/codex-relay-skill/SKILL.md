---
name: agent-relay
description: Use when you need Codex to coordinate multiple agents through Agent Relay for peer-to-peer messaging, lead/worker handoffs, or shared status tracking across sub-agents and terminals.
---

# Agent Relay

Use this skill when Codex needs real-time coordination across multiple agents. It gives Codex a repeatable workflow for:

- connecting to an Agent Relay workspace
- spawning relay-aware workers
- sending direct messages, channel updates, and thread replies
- keeping lead and worker state synchronized through ACK, STATUS, BLOCKED, and DONE signals

Relay fills the peer-to-peer gap in Codex sub-agent workflows. Codex can spawn and collect worker results, but Agent Relay gives those workers a shared message bus so they can talk to the lead and to each other.

## Auto-setup

On first activation, this skill auto-configures Codex by running `scripts/setup.sh`. This adds the Agent Relay MCP server to `.codex/config.toml`, enables hooks, installs `hooks.json`, and copies the `relay-worker.toml` agent definition. No manual setup is required after installing the skill.

## Startup protocol

Every relay-connected Codex agent must complete these steps IN ORDER before substantive work:

1. **Set up a workspace.**
   - If `RELAY_WORKSPACE_KEY` is set in the environment, call `set_workspace_key` with that key.
   - If only the legacy `RELAY_API_KEY` alias is set, treat it as the same workspace key.
   - If no key is available, call `create_workspace` to auto-create one. This returns a workspace key — save it for workers.

2. **Register as an agent.** Call `register_agent` with your agent name and `type: "agent"`. Use `RELAY_AGENT_NAME` from the environment if set, otherwise derive a name from the task context (e.g., `lead`, `auth-worker`).

3. **Tell the user** they can follow the conversation live at `https://agentrelay.com/observer?key=<workspace_key>` (use the workspace key from step 1). This lets them watch all agent messages in real time.

4. **Check the relay inbox.** Call `check_inbox` to see if there are any pending messages or task assignments.

5. **Send an ACK.** If you received a task assignment, send `ACK: <one-sentence understanding>` to your lead via `send_dm`. If the assignment is unclear, send `BLOCKED: <question>` instead of guessing.

6. **When the task is complete**, send `DONE: <summary with evidence>` before stopping.

If workspace creation or registration fails, retry once, then report the failure to the user — do not proceed without a relay connection.

## Critical rule

**Do not assume the current MCP session already has an active Agent Relay workspace.** Always call `set_workspace_key` or `create_workspace` before registering.

## Working rules

- Include `as: "<agent-name>"` on relay calls that support explicit attribution.
- Keep the relay identity stable for the whole task. Do not switch names mid-task.
- Check the inbox again after meaningful milestones, before long-running work, and before stopping.
- Prefer direct messages for lead/worker coordination. Use channels only when multiple agents need the same update.
- Keep status messages short, factual, and scoped to the assigned work.
- Do not spawn additional relay workers unless the lead explicitly asks for more delegation.
- If the lead updates the task, follow the newest explicit instruction.

## Message templates

- `ACK: I understand the assignment and I am starting work on <scope>.`
- `STATUS: Finished <milestone>; next I am doing <next-step>.`
- `BLOCKED: I cannot continue because <blocker>.`
- `DONE: Completed <scope>. Evidence: <files changed, commands run, tests, or decisions>.`

## Worker patterns

There are two current ways to involve more agents. Use the right one for the
job.

### Registered workspace identities

Use `register_agent` for an agent process that is already running and only
needs a Relay identity. Registration does not start a new model runtime.

**Lead steps:**

1. Ensure workspace exists (`set_workspace_key` or `create_workspace`).
2. Register the lead (`register_agent`).
3. Give the other running process the workspace key and tell it to call
   `register_agent` with a stable name.
4. Send the assignment via `send_dm(to: "worker-name", text: "...")`.
5. Poll lead inbox for ACK (`check_inbox`).

**Worker steps:**

1. Call `set_workspace_key` with the shared key.
2. Register with `register_agent`.
3. Check inbox (`check_inbox`).
4. Send ACK to lead via `send_dm`.
5. Perform the assigned scope.
6. Send DONE to lead via `send_dm`.

### Relay-spawned workers

Use `add_agent` when the lead should ask Relay to start a provider-backed
worker. The current tool requires `name`, `cli`, and `task`; optional fields
include `channel`, `persona`, and `model`.

**Lead steps:**

1. Ensure workspace exists and lead is registered.
2. Spawn the worker with `add_agent(name: "worker-name", cli: "codex", task: "...")`.
3. Include `https://agentrelay.com/skill`, the lead name, exact scope, and
   completion criteria in the task prompt.
4. Poll lead inbox for ACK (`check_inbox`).
5. Release the worker with `remove_agent` after the work is accepted.

**Worker steps:**

1. Follow the `using-agent-relay` role from `https://agentrelay.com/skill`.
2. Check inbox, send ACK, do the assigned work, and send DONE.

### Codex sub-agents

If your Codex surface has a sub-agent spawn capability, use the bundled
`relay-worker` agent definition for code-heavy work that needs a separate Codex
runtime with file access and tools. Include the workspace key, relay name, lead
name, exact scope, and completion criteria in the sub-agent prompt. If that
spawn capability is not available, use `add_agent` instead.

## Worker ACK fallback

If a worker does not ACK within 30 seconds:

1. Check whether the worker appears in `list_agents`.
2. If this is a running process, have it call `register_agent`.
3. If this should be a spawned worker, call `add_agent` with `name`, `cli`, and `task`.
4. Send (or re-send) the assignment via `send_dm`.
5. Poll the lead inbox again for ACK.
6. If still no ACK after a second attempt, report the exact failed step to the user.

## Handoff template

```text
Worker: api-worker
Type: relay-spawned worker (use add_agent with name, cli, and task)
Lead: lead
Scope: check the Agent Relay inbox and confirm connectivity
Protocol:
  1. Check inbox
  2. DM lead with ACK
  3. Perform scope
  4. DM lead with DONE
```

For code-heavy tasks, change the type line to:

```text
Type: Codex sub-agent (use relay-worker if your Codex surface provides sub-agent spawning)
```
