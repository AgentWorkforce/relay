* Use the `bd` tool instead of markdown to coordinate all work and tasks.
* NEVER commit changes unless the user explicitly asks you to.

# Using bv as an AI sidecar

bv is a fast terminal UI for Beads projects (.beads/beads.jsonl). It renders lists/details and precomputes dependency metrics (PageRank, critical path, cycles, etc.) so you instantly see blockers and execution order. For agents, it's a graph sidecar: instead of parsing JSONL or risking hallucinated traversal, call the robot flags to get deterministic, dependency-aware outputs.

*IMPORTANT: As an agent, you must ONLY use bv with the robot flags, otherwise you'll get stuck in the interactive TUI that's intended for human usage only!*

- bv --robot-help — shows all AI-facing commands.
- bv --robot-insights — JSON graph metrics (PageRank, betweenness, HITS, critical path, cycles) with top-N summaries for quick triage.
- bv --robot-plan — JSON execution plan: parallel tracks, items per track, and unblocks lists showing what each item frees up.
- bv --robot-priority — JSON priority recommendations with reasoning and confidence.
- bv --robot-recipes — list recipes (default, actionable, blocked, etc.); apply via bv --recipe <name> to pre-filter/sort before other flags.
- bv --robot-diff --diff-since <commit|date> — JSON diff of issue changes, new/closed items, and cycles introduced/resolved.

Use these commands instead of hand-rolling graph logic; bv already computes the hard parts so agents can act safely and quickly.

## Integrating with Beads (dependency-aware task planning)

Beads provides a lightweight, dependency-aware issue database and a CLI (`bd`) for selecting "ready work," setting priorities, and tracking status. Project: [steveyegge/beads](https://github.com/steveyegge/beads)

Recommended conventions
- **Single source of truth**: Use **Beads** for task status/priority/dependencies.
- **Shared identifiers**: Use the Beads issue id (e.g., `bd-123`) as identifiers and prefix message subjects with `[bd-123]`.

Typical flow (agents)
1) **Pick ready work** (Beads)
   - `bd ready --json` → choose one item (highest priority, no blockers)
2) **Announce start**
   - Update status: `bd update <id> --status=in_progress`
3) **Work and update**
   - Make progress on the task
4) **Complete**
   - `bd close <id> --reason "Completed"` (Beads is status authority)

Pitfalls to avoid
- Don't create or manage tasks in markdown; treat Beads as the single task queue.
- Always include `bd-###` in commit messages for traceability.

---

# Agent Relay

Real-time agent-to-agent messaging.

## Quick Start

```bash
# Terminal 1: Start daemon
agent-relay up

# Terminal 2: Start agent
agent-relay -n Alice claude

# Terminal 3: Start another agent
agent-relay -n Bob claude
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `agent-relay <cmd>` | Wrap agent with messaging (e.g., `agent-relay claude`) |
| `agent-relay -n Name <cmd>` | Wrap with specific agent name |
| `agent-relay up` | Start daemon + dashboard |
| `agent-relay down` | Stop daemon |
| `agent-relay status` | Check if daemon is running |
| `agent-relay read <id>` | Read full truncated message |

---

## For Agents: How to Communicate

When wrapped with `agent-relay`, agents communicate by outputting `>>relay:` patterns.

### Send a Message

Output this in your response (not in a bash command):

```
>>relay:AgentName Your message here
```

### Broadcast to All

```
>>relay:* This message goes to everyone
```

### Receiving Messages

Messages appear in your terminal as:

```
Relay message from Alice [abc12345]: Hey Bob, can you review my changes?
```

### Truncated Messages

Long messages show:

```
Relay message from Alice [abc12345]: Start of message... [TRUNCATED - run "agent-relay read abc12345..."]
```

Read the full message:

```bash
agent-relay read abc12345...
```

---

## Communication Patterns

```
>>relay:* STATUS: Starting work on auth module
>>relay:* DONE: Auth module complete
>>relay:Developer TASK: Implement /api/register
>>relay:Reviewer REVIEW: Please check src/auth/*.ts
>>relay:Architect QUESTION: JWT or sessions?
```

---

## Pattern Rules

`>>relay:` must be at the start of a line:

```
>>relay:Name message           # Works
  >>relay:Name message         # Works (whitespace OK)
- >>relay:Name message         # Works (list OK)
Some text >>relay:Name msg     # Won't work
```

Escape with `\>>relay:` to output literally.
