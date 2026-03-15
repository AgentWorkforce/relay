---
name: relay-orchestration
description: Use when coordinating multiple Gemini relay agents - covers pattern selection, worker scoping, and lead coordination loops
---

# Relay Orchestration

Use this skill when the task is large enough to benefit from multiple relay agents.

## Choose The Simplest Pattern

If the work splits cleanly into independent subtasks, use a fan-out pattern.

If a lead must keep adapting the plan as results come in, use a coordinated team pattern with one lead and multiple workers.

If work is sequential, use a handoff or pipeline instead of parallel workers.

If only one agent is needed, do not spawn a team.

## Lead Responsibilities

1. Define the objective, deliverable, and stop condition before spawning workers.
2. Keep worker tasks bounded. Each worker should own one clear responsibility.
3. Prefer no more than 5 workers unless the task clearly requires more parallelism.
4. Use `mcp_relaycast_agent_add` to spawn workers with specific names and scoped tasks.
5. Use `mcp_relaycast_inbox_check` to monitor ACK and DONE messages.
6. Relay context updates only to the workers who need them.
7. Synthesize the final answer after the critical workers report DONE.

## Worker Naming

Use names that encode the role, not just a number.

Good examples:
- `ResearcherAuth`
- `ReviewerApi`
- `WorkerDocs`

Avoid generic names when the task spans multiple domains.

## Pattern Guide

### Fan-Out

Use when:
- Subtasks are independent
- Workers do not need to collaborate directly
- The lead can merge the outputs at the end

Avoid when:
- Workers depend on each other's intermediate results
- The lead expects frequent replanning

### Coordinated Team

Use when:
- The lead needs to adjust assignments during execution
- Workers may uncover new information that changes the plan
- The task mixes implementation, research, and review

Avoid when:
- One worker can finish the task alone
- The coordination cost would outweigh the parallelism

## Execution Loop

1. Spawn the workers.
2. Wait for ACK messages and confirm each worker understands its role.
3. Check the inbox periodically during long tasks.
4. Answer questions, unblock workers, and correct scope drift quickly.
5. Collect DONE messages and merge the useful output into one result.

## Guardrails

- Keep communication point-to-point unless all workers need the same update.
- Do not spawn extra workers just to summarize another worker's output.
- If fan-out stops being independent, switch back to a lead-coordinated pattern.
- If the work becomes sequential, stop spawning parallel workers and move to a handoff.
