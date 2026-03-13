---
name: relay-pipeline
description: Run a sequential relay pipeline where each stage feeds the next. Use when worker N plus 1 depends on worker N's output or decisions.
argument-hint: "[task]"
disable-model-invocation: true
---

Run a relay pipeline for this task:

$ARGUMENTS

Protocol:

1. Break the task into ordered stages. Each stage must have a clear handoff artifact for the next stage: a summary, decision, file path, diff, or verified output.
2. Keep the number of stages low and explicit. Prefer 2 to 5 stages with distinct responsibilities.
3. Start stage 1 first. Spawn its Claude worker with the Relaycast add-agent MCP tool and require:
   - immediate inbox check
   - `ACK: <brief understanding>`
   - `DONE: <summary and evidence>`
4. Wait for stage 1 DONE before starting stage 2. Do not start downstream work on assumptions.
5. For each later stage, spawn a new worker with:
   - the original task context
   - the upstream DONE summary
   - any produced files, decisions, or constraints that now define the handoff
   - the same ACK and DONE protocol
6. After each stage finishes, validate that the handoff is sufficient. If the output is ambiguous, ask for clarification before starting the next stage.
7. Continue until the final stage completes, then synthesize the end-to-end result and highlight where each handoff happened.
8. Release temporary workers when the pipeline is complete unless the user asks to keep them running.

Rules:

- Use pipeline only for genuine dependencies. If stages can run independently, switch to fan-out.
- Handoffs must be explicit. A downstream worker should never need to guess what mattered from the previous stage.
- If a stage fails or is blocked, stop the pipeline, resolve the blocker, and then resume from the blocked stage.
