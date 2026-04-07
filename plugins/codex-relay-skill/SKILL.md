---
name: agent-relay
description: Use when you need Codex to coordinate multiple agents through Relaycast for peer-to-peer messaging, lead/worker handoffs, or shared status tracking across sub-agents and terminals.
---

# Agent Relay

Use this skill when Codex needs real-time coordination across multiple agents. It gives Codex a repeatable workflow for:

- connecting to a Relaycast workspace
- spawning relay-aware workers
- sending direct messages, channel updates, and thread replies
- keeping lead and worker state synchronized through ACK, STATUS, BLOCKED, and DONE signals

Relay fills the peer-to-peer gap in Codex sub-agent workflows. Codex can spawn and collect worker results, but Relaycast gives those workers a shared message bus so they can talk to the lead and to each other.

## Auto-setup

On first activation, this skill auto-configures Codex by running `scripts/setup.sh`. This adds the Relaycast MCP server to `.codex/config.toml`, enables hooks, installs `hooks.json`, and copies the `relay-worker.toml` agent definition. No manual setup is required after installing the skill.

## Startup protocol

Every relay-connected Codex agent must complete these steps IN ORDER before substantive work:

1. **Check for a workspace.** Call `workspace.list` to see if a workspace is already active.
   - If no workspace is active and `RELAY_API_KEY` is set in the environment, call `workspace.set_key` with that key.
   - If no workspace is active and no key is available, call `workspace.create` to auto-create one. This returns a workspace key — save it for workers.
   - If a workspace is already active, skip to step 2.

2. **Register as an agent.** Call `agent.register` with your agent name and `type: "agent"`. Use `RELAY_AGENT_NAME` from the environment if set, otherwise derive a name from the task context (e.g., `lead`, `auth-worker`).

3. **Tell the user** they can follow the conversation live at `https://agentrelay.com/observer?key=<workspace_key>` (use the workspace key from step 1). This lets them watch all agent messages in real time.

4. **Check the relay inbox.** Call `inbox.check` to see if there are any pending messages or task assignments.

5. **Send an ACK.** If you received a task assignment, send `ACK: <one-sentence understanding>` to your lead via `dm.send`. If the assignment is unclear, send `BLOCKED: <question>` instead of guessing.

6. **When the task is complete**, send `DONE: <summary with evidence>` before stopping.

If workspace creation or registration fails, retry once, then report the failure to the user — do not proceed without a relay connection.

## Critical rule

**Do not assume the current MCP session already has an active Relaycast workspace.** Always check with `workspace.list` first and create or set one if missing.

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

## Two kinds of workers

There are two ways to create workers. Use the right one for the job:

### Relaycast workspace agents (preferred for messaging tasks)

Use `agent.add` to create a Relaycast-native agent. Best for tasks that are primarily about messaging, inbox checks, coordination, or lightweight work that doesn't need a full Codex sub-agent runtime.

**Lead steps:**

1. Ensure workspace exists (call `workspace.list`, then `workspace.create` if needed).
2. Register the lead (`agent.register`).
3. Add the worker with `agent.add(name: "worker-name", type: "agent")`.
4. Send the assignment via `dm.send(to: "worker-name", text: "...")`.
5. Poll lead inbox for ACK (`inbox.check`).

**Worker steps:**

1. Check inbox (`inbox.check`).
2. Send ACK to lead via `dm.send`.
3. Perform the assigned scope.
4. Send DONE to lead via `dm.send`.

### Codex sub-agents (for code-heavy tasks)

Use `spawn_agent` with the `relay-worker` agent definition for tasks that need full code editing, file access, and tool use. The worker gets its own Codex runtime with Relaycast MCP tools available.

**Lead steps:**

1. Ensure workspace exists and lead is registered (same as above).
2. Spawn the worker: include relay name, lead name, workspace key, exact scope, and completion criteria in the task prompt.
3. Poll lead inbox for ACK.

**Worker steps:**

1. Call `workspace.set_key` with the workspace key from the task prompt.
2. Register with `agent.register`.
3. Check inbox, send ACK, do work, send DONE.

## Worker ACK fallback

If a worker does not ACK within 30 seconds:

1. Check whether the worker appears in `agent.list`.
2. If not listed, register or add the worker directly with `agent.add`.
3. Send (or re-send) the assignment via `dm.send`.
4. Poll the lead inbox again for ACK.
5. If still no ACK after a second attempt, report the exact failed step to the user.

## Handoff template

```text
Worker: api-worker
Type: relay workspace agent (use agent.add, not spawn_agent)
Lead: lead
Scope: check the Relaycast inbox and confirm connectivity
Protocol:
  1. Check inbox
  2. DM lead with ACK
  3. Perform scope
  4. DM lead with DONE
```

For code-heavy tasks, change the type line to:

```text
Type: Codex sub-agent (use spawn_agent with relay-worker)
```
