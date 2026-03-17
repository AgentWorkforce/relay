---
name: relay-fanout
description: Run a fan-out relay pattern for independent subtasks. Use when the same kind of work can be split across files, components, services, or targets with minimal coordination.
argument-hint: "[task]"
disable-model-invocation: true
---

Run a relay fan-out for this task:

$ARGUMENTS

## How spawning works

Workers are spawned using Claude Code's built-in **Agent tool**, not the relay MCP tools. The relay is only used for communication between agents.

- You **must** use `subagent_type: "relay-worker"` when spawning workers. Only `relay-worker` subagents get the Relaycast MCP server, inbox-polling hooks, and the worker protocol. Regular subagent types (e.g. `researcher`, `general-purpose`) cannot communicate via relay.
- Run all workers in **background mode** (`run_in_background: true`) so they execute concurrently.
- Each worker's prompt **must include the workspace key** so the worker can authenticate. See the spawn example below.
- The `SubagentStart` hook automatically injects relay bootstrap instructions into every spawned worker.
- Do not introduce extra setup scripts or dependencies in this workflow. Use the existing plugin hooks, Relaycast MCP tools, and `relay-worker` agent definition only.
- Use relay MCP tools (`send_dm`, `check_inbox`) to monitor worker progress.

## Protocol

1. Pick a stable coordinator name such as `relay-lead`. On every relay tool call you make as the coordinator, include `as: "relay-lead"` so your messages, inbox checks, and reactions stay attributed to the lead.
2. **Set up the workspace.** Try calling `register` with a coordinator name like `relay-lead`. If it fails with "Workspace key not configured", call `create_workspace` to generate one, then call `set_workspace_key` with the returned key, then `register`. Save the workspace key — you will pass it to every worker.
3. **Tell the user they can follow along with the conversation.** Print the full observer URL with the real key value: `https://agentrelay.dev/observer?key=<the actual key>`. Do not print a placeholder — print the real URL the user can click. This is mandatory.
4. Confirm the work is truly parallelizable. Every worker should be able to finish without waiting on another worker's output.
5. Decide the worker count from the task shape. Prefer 2 to 8 workers, but keep the count low enough that you can still monitor ACKs and completions reliably.
6. Partition the work into independent units. Each unit should have its own files, target, or scope boundary and should not require shared intermediate state.
7. Spawn one worker per unit using the Agent tool. **You must include the workspace key in the prompt**:
   ```
   Agent(
     subagent_type: "relay-worker",
     run_in_background: true,
     prompt: "You are relay-worker-N. Your lead is relay-lead.
              Workspace key: <the actual key>.
              CRITICAL: On every relay tool call, include as: \"relay-worker-N\". Without as, your messages can be attributed to another agent.
              Your unit: [specific target/scope].
              Files: [list of files/directories].
              Deliver: [concrete output]."
   )
   ```
8. Each worker's prompt must include:
   - the workspace key
   - the unit it owns
   - the exact files, directories, or target it should handle
   - its assigned relay name and who its lead is
   - a reminder to use `as: "<worker-name>"` on every relay tool call
9. Wait for ACK from every worker via relay inbox with `check_inbox(as: "relay-lead")`. Missing ACK means the worker is not ready.
10. Let workers run independently. Only send follow-up DMs for blockers, missing ACKs, or a global decision that changes all units, always using `as: "relay-lead"` for coordinator messages.
11. Collect all DONE messages, verify the outputs, and merge the final summary. Call out any units that finished partially or encountered blockers.

## Rules

- Do not use this pattern when stage N depends on stage N-1. That is a pipeline.
- Do not give multiple workers the same files unless duplicate review is intentional.
- Keep the task wording uniform so worker outputs are easy to compare and merge.
- Workers cannot spawn their own subagents — only the lead can spawn workers.
