* Use the `bd` tool instead of markdown to coordinate all work and tasks.

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
<!-- PRPM_MANIFEST_START -->

<skills_system priority="1">
<usage>
When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

How to use skills (loaded into main context):
- Use the <path> from the skill entry below
- Invoke: Bash("cat <path>")
- The skill content will load into your current context
- Example: Bash("cat .openskills/backend-architect/SKILL.md")

Usage notes:
- Skills share your context window
- Do not invoke a skill that is already loaded in your context
</usage>

<available_skills>

<skill activation="lazy">
<name>frontend-design</name>
<description>Design and build modern frontend interfaces with best practices and user experience principles. Create beautiful, accessible, and performant web interfaces.</description>
<path>.openskills/frontend-design/SKILL.md</path>
</skill>

</available_skills>
</skills_system>

<!-- PRPM_MANIFEST_END -->

<!-- prpm:snippet:start @agent-relay/agent-relay-snippet@1.0.0 -->
# Agent Relay

Real-time agent-to-agent messaging. Output `->relay:` patterns to communicate.

## Sending Messages

**Always use the fenced format** for reliable message delivery:

```
->relay:AgentName <<<
Your message here.>>>
```

```
->relay:* <<<
Broadcast to all agents.>>>
```

**CRITICAL:** Always close multi-line messages with `>>>` on its own line!

## Receiving Messages

Messages appear as:
```
Relay message from Alice [abc123]: Message content here
```

If truncated, read full message:
```bash
agent-relay read abc123
```

## Spawning Agents

Spawn workers to delegate tasks:

```
->relay:spawn WorkerName claude "task description"
->relay:release WorkerName
```

## Threads

Use threads to group related messages together:

```
->relay:AgentName [thread:topic-name] <<<
Your message here.>>>
```

**When to use threads:**
- Working on a specific issue (e.g., `[thread:agent-relay-299]`)
- Back-and-forth discussions with another agent
- Code review conversations

## Common Patterns

```
->relay:* <<<
STATUS: Starting work on auth module>>>

->relay:* <<<
DONE: Auth module complete>>>

->relay:Developer <<<
TASK: Implement /api/register>>>

->relay:Reviewer [thread:code-review-auth] <<<
REVIEW: Please check src/auth/*.ts>>>

->relay:Architect <<<
QUESTION: JWT or sessions?>>>
```

## Rules

- Pattern must be at line start (whitespace OK)
- Escape with `\->relay:` to output literally
- Check daemon status: `agent-relay status`
<!-- prpm:snippet:end @agent-relay/agent-relay-snippet@1.0.0 -->
