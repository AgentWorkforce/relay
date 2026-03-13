---
name: relay-team
description: Spawn and coordinate a relay team for a multi-part task. Use when work should be split across several Claude workers with explicit ACK and DONE signaling.
argument-hint: "[task]"
disable-model-invocation: true
---

Build and run a coordinated relay team for this task:

$ARGUMENTS

Protocol:

1. Read the task, inspect the relevant code or files, and decide whether parallel work is justified. Prefer 1 worker for tightly coupled work and 2 to 5 workers for genuinely separable work.
2. Break the task into clear, non-overlapping worker scopes. Each worker needs a concrete deliverable, the relevant files or directories, and an explicit success condition.
3. Spawn Claude workers with the Relaycast add-agent MCP tool. Use stable names that avoid collisions, preferably `relay-<role>-<n>`.
4. If the runtime supports a dedicated `relay-worker` agent type, use it. Otherwise include the relay worker protocol directly in each worker task:
   - check relay inbox immediately
   - send `ACK: <brief understanding>` before substantive work
   - report blockers immediately
   - finish with `DONE: <summary and evidence>`
5. Monitor the relay inbox for ACKs. Do not assume a worker is active until it ACKs. Follow up, restate the task, or replace the worker if an ACK does not arrive.
6. Coordinate dependencies explicitly. Relay only the minimum context each worker needs, and keep workers independent whenever possible.
7. Maintain a live worker table in your own notes with: worker name, scope, ACK status, blocker status, and DONE status.
8. Collect every DONE message, verify the results, and synthesize the final output. Include what each worker finished and any remaining gaps or risks.
9. Release temporary workers with the Relaycast remove-agent tool after integration unless the user asks to keep them alive.

Rules:

- Prefer fewer well-scoped workers over many vague workers.
- Do not let workers infer coordination details. Send explicit follow-up instructions when assumptions change.
- If the task turns out to be independent across targets, switch to the fan-out pattern instead of keeping a central coordinator busy.
- If the task turns out to be sequential, switch to the pipeline pattern instead of forcing parallelism.
