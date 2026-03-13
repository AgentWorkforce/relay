---
name: relay-fanout
description: Run a fan-out relay pattern for independent subtasks. Use when the same kind of work can be split across files, components, services, or targets with minimal coordination.
argument-hint: "[task]"
disable-model-invocation: true
---

Run a relay fan-out for this task:

$ARGUMENTS

Protocol:

1. Confirm the work is truly parallelizable. Every worker should be able to finish without waiting on another worker's output.
2. Decide the worker count from the task shape. Prefer 2 to 8 workers, but keep the count low enough that you can still monitor ACKs and completions reliably.
3. Partition the work into independent units. Each unit should have its own files, target, or scope boundary and should not require shared intermediate state.
4. Spawn one Claude worker per unit with the Relaycast add-agent MCP tool.
5. Each worker task must include:
   - the unit it owns
   - the exact files, directories, or target it should handle
   - `ACK: <brief understanding>` on start
   - `DONE: <summary and evidence>` on completion
   - a requirement to report blockers immediately
6. Wait for ACK from every worker. Missing ACK means the worker is not ready.
7. Let workers run independently. Only interrupt for blockers, missing ACKs, or a global decision that changes all units.
8. Collect all DONE messages, verify the outputs, and merge the final summary. Call out any units that finished partially or encountered blockers.
9. Release temporary workers when the fan-out is complete unless the user asks to keep them active.

Rules:

- Do not use this pattern when stage N depends on stage N-1. That is a pipeline.
- Do not give multiple workers the same files unless duplicate review is intentional.
- Keep the task wording uniform so worker outputs are easy to compare and merge.
