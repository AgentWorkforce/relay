---
name: relay-team
description: Spawn and coordinate a relay team for a multi-part task. Use when work should be split across several Claude workers with explicit ACK and DONE signaling.
argument-hint: "[task]"
disable-model-invocation: true
---

Build and run a coordinated relay team for this task:

$ARGUMENTS

## How spawning works

Workers are spawned using Claude Code's built-in **Agent tool**, not the relay MCP tools. The relay is only used for communication between agents.

- You **must** use `subagent_type: "relay-worker"` when spawning workers. Only `relay-worker` subagents get the Relaycast MCP server, inbox-polling hooks, and the worker protocol. Regular subagent types (e.g. `researcher`, `general-purpose`) cannot communicate via relay.
- Run workers in **background mode** (`run_in_background: true`) so they execute concurrently.
- Each worker's prompt **must include the workspace key** so the worker can authenticate. See the spawn example below.
- The `SubagentStart` hook automatically injects relay bootstrap instructions (register, check inbox, ACK, DONE protocol) into every spawned worker.
- Do not introduce extra setup scripts or dependencies in this workflow. Use the existing plugin hooks, Relaycast MCP tools, and `relay-worker` agent definition only.
- Use relay MCP tools (`send_dm`, `post_message`, `check_inbox`) to communicate with workers after they're running.

## Protocol

1. Pick a stable coordinator name such as `relay-lead`. On every relay tool call you make as the coordinator, include `as: "relay-lead"` so your messages, inbox checks, and reactions stay attributed to the lead.
2. **Set up the workspace.** Try calling `register` with a coordinator name like `relay-lead`. If it fails with "Workspace key not configured", call `create_workspace` to generate one, then call `set_workspace_key` with the returned key, then `register`. Save the workspace key — you will pass it to every worker.
3. **Tell the user they can follow along with the conversation.** Print the full observer URL with the real key value: `https://agentrelay.dev/observer?key=<the actual key>`. Do not print a placeholder — print the real URL the user can click. This is mandatory.
4. Read the task, inspect the relevant code or files, and decide whether parallel work is justified. Prefer 1 worker for tightly coupled work and 2 to 5 workers for genuinely separable work.
5. Break the task into clear, non-overlapping worker scopes. Each worker needs a concrete deliverable, the relevant files or directories, and an explicit success condition.
6. Spawn each worker using the Agent tool. **You must include the workspace key in the prompt** so the worker can call `set_workspace_key`:
   ```
   Agent(
     subagent_type: "relay-worker",
     run_in_background: true,
     prompt: "You are relay-worker-1. Your lead is relay-lead.
              Workspace key: <the actual key>.
              CRITICAL: On every relay tool call, include as: \"relay-worker-1\". Without as, your messages can be attributed to another agent.
              Your task: [specific scope and deliverables].
              Files: [list of files/directories].
              Success condition: [what done looks like]."
   )
   ```
7. After spawning, send each worker a DM via relay with any additional context they need. Include `as: "relay-lead"` on those coordinator messages.
8. Monitor the relay inbox for ACKs with `check_inbox(as: "relay-lead")`. Do not assume a worker is active until it ACKs. Send a follow-up DM if an ACK does not arrive.
9. Maintain a live worker table in your own notes with: worker name, scope, ACK status, blocker status, and DONE status.
10. Coordinate dependencies explicitly. Relay only the minimum context each worker needs, and keep workers independent whenever possible.
11. Collect every DONE message, verify the results, and synthesize the final output. Include what each worker finished and any remaining gaps or risks.

## Rules

- Prefer fewer well-scoped workers over many vague workers.
- Do not let workers infer coordination details. Send explicit follow-up instructions when assumptions change.
- If the task turns out to be independent across targets, switch to the fan-out pattern instead of keeping a central coordinator busy.
- If the task turns out to be sequential, switch to the pipeline pattern instead of forcing parallelism.
- Workers cannot spawn their own subagents — only the lead can spawn workers.
