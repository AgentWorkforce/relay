---
name: relay-pipeline
description: Run a sequential relay pipeline where each stage feeds the next. Use when worker N plus 1 depends on worker N's output or decisions.
argument-hint: "[task]"
disable-model-invocation: true
---

Run a relay pipeline for this task:

$ARGUMENTS

## How spawning works

Workers are spawned using Claude Code's built-in **Agent tool**, not the relay MCP tools. The relay is only used for communication between agents.

- You **must** use `subagent_type: "relay-worker"` when spawning workers. Only `relay-worker` subagents get the Relaycast MCP server, inbox-polling hooks, and the worker protocol. Regular subagent types (e.g. `researcher`, `general-purpose`) cannot communicate via relay.
- Run pipeline stages in **foreground mode** (default) so you wait for each stage to complete before starting the next.
- Each worker's prompt **must include the workspace key** so the worker can authenticate. See the spawn example below.
- The `SubagentStart` hook automatically injects relay bootstrap instructions into every spawned worker.
- Do not introduce extra setup scripts or dependencies in this workflow. Use the existing plugin hooks, Relaycast MCP tools, and `relay-worker` agent definition only.
- Use relay MCP tools (`send_dm`, `check_inbox`) to receive handoff artifacts from each stage.

## Protocol

1. Pick a stable coordinator name such as `relay-lead`. On every relay tool call you make as the coordinator, include `as: "relay-lead"` so your messages, inbox checks, and reactions stay attributed to the lead.
2. **Set up the workspace.** Try calling `register` with a coordinator name like `relay-lead`. If it fails with "Workspace key not configured", call `create_workspace` to generate one, then call `set_workspace_key` with the returned key, then `register`. Save the workspace key — you will pass it to every worker.
3. **Tell the user they can follow along with the conversation.** Print the full observer URL with the real key value: `https://agentrelay.dev/observer?key=<the actual key>`. Do not print a placeholder — print the real URL the user can click. This is mandatory.
4. Break the task into ordered stages. Each stage must have a clear handoff artifact for the next stage: a summary, decision, file path, diff, or verified output.
5. Keep the number of stages low and explicit. Prefer 2 to 5 stages with distinct responsibilities.
6. Start stage 1. Spawn its worker using the Agent tool in foreground mode. **Include the workspace key**:
   ```
   Agent(
     subagent_type: "relay-worker",
     prompt: "You are relay-stage-1. Your lead is relay-lead.
              Workspace key: <the actual key>.
              CRITICAL: On every relay tool call, include as: \"relay-stage-1\". Without as, your messages can be attributed to another agent.
              Your task: [stage 1 scope].
              Files: [relevant files].
              When done, send your lead a DONE message with: [handoff artifact description]."
   )
   ```
7. Wait for the stage 1 DONE message via relay inbox with `check_inbox(as: "relay-lead")`. Do not start downstream work on assumptions.
8. For each later stage, spawn a new worker with:
   - the workspace key
   - the original task context
   - the upstream DONE summary and handoff artifact
   - any produced files, decisions, or constraints from previous stages
   ```
   Agent(
     subagent_type: "relay-worker",
     prompt: "You are relay-stage-2. Your lead is relay-lead.
              Workspace key: <the actual key>.
              CRITICAL: On every relay tool call, include as: \"relay-stage-2\". Without as, your messages can be attributed to another agent.
              Previous stage completed: [DONE summary from stage 1].
              Your task: [stage 2 scope using stage 1 output].
              Files: [relevant files]."
   )
   ```
9. After each stage finishes, validate that the handoff is sufficient. If the output is ambiguous, ask the user for clarification before starting the next stage.
10. Continue until the final stage completes, then synthesize the end-to-end result and highlight where each handoff happened.

## Rules

- Use pipeline only for genuine dependencies. If stages can run independently, switch to fan-out.
- Handoffs must be explicit. A downstream worker should never need to guess what mattered from the previous stage.
- If a stage fails or is blocked, stop the pipeline, resolve the blocker, and then resume from the blocked stage.
- Workers cannot spawn their own subagents — only the lead can spawn workers.
