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

Every relay-connected Codex agent must complete these steps before substantive work:

1. Set the Relaycast workspace key using the relay workspace-auth tool. Use the workspace key from the task prompt or environment. Do not print the key back to the user.
2. Register with Relaycast using the assigned agent name and `type: "agent"` unless the environment explicitly says you were pre-registered.
3. Check the relay inbox for the current assignment, lead identity, and any follow-up context.
4. **Tell the user** they can follow the conversation live at `https://agentrelay.dev/observer?key=<workspace_key>` (use the workspace key from `RELAY_API_KEY` or `~/.relay/workspace-key`). This lets them watch all agent messages in real time.
5. Send an `ACK` to the lead when you understand the assignment. If the assignment is unclear, send `BLOCKED` instead of guessing.
6. When the task is complete, send a `DONE` message with a concise summary and supporting evidence.

If authentication or registration fails, retry once, then report the failure instead of continuing disconnected.

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

## Spawning relay workers with Codex sub-agents

Use the `relay-worker` custom agent definition for execution-focused tasks that need relay signaling.

Before spawning workers:

1. Verify auto-setup has run (the Relaycast MCP server and `relay-worker.toml` are installed automatically on first skill activation).
2. Pass the worker everything it needs up front: relay name, lead name, workspace-key source, exact scope, and completion criteria.

Good worker handoff pattern:

- assign one bounded scope per worker
- tell the worker who to ACK
- tell the worker when to send STATUS
- require DONE with evidence before exit

Example delegation:

```text
Spawn a Codex relay-worker for this task.
Relay name: auth-worker
Lead: lead
Scope: update the auth middleware tests only
Protocol: check inbox, ACK me in Relaycast, send STATUS after the first passing test run, then send DONE with files changed and tests executed.
```

For independent work, spawn multiple `relay-worker` sub-agents in parallel. For dependent work, use one relay worker at a time and hand off results through Relaycast before starting the next worker.
