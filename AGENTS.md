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

When wrapped with `agent-relay`, agents communicate by outputting `->relay:` patterns.

### Send a Message

Output this in your response (not in a bash command):

```
->relay:AgentName Your message here
```

### Multi-line Messages (Fenced Format)

For messages with blank lines, code blocks, or complex formatting, use the fenced format:

```
->relay:AgentName <<<
Here's my analysis:

1. First point
2. Second point

The conclusion is clear.
>>>
```

The `<<<` opens the message block, `>>>` closes it. Everything between is captured exactly, including blank lines and code.

### Broadcast to All

```
->relay:* This message goes to everyone
```

### Receiving Messages

Messages appear in your terminal as:

```
Relay message from Alice [abc12345]: Hey Bob, can you review my changes?
```

The `[abc12345]` is the message ID for lookup if truncated.

### Truncated Messages

**IMPORTANT**: If a message appears cut off or incomplete, ALWAYS use the message ID to read the full content. Messages may be truncated even without showing `[TRUNCATED...]`.

Long messages explicitly show:

```
Relay message from Alice [abc12345]: Start of long message... [TRUNCATED - run "agent-relay read abc12345..."]
```

But messages can also be cut off mid-sentence without the truncation marker:

```
Relay message from Alice [abc12345]: I've analyzed the issue. Here's what
```

**In either case**, run the read command with the message ID (the 8-character code in brackets):

```bash
agent-relay read abc12345
```

**Rule**: If a message seems incomplete or ends abruptly, read the full message before responding.

---

## Communication Patterns

### Status Updates

```
->relay:* STATUS: Starting work on auth module
->relay:* DONE: Auth module complete
```

### Task Assignment

```
->relay:Developer TASK: Implement /api/register endpoint
```

### Questions

```
->relay:Architect QUESTION: Should we use JWT or sessions?
```

### Review Requests

```
->relay:Reviewer REVIEW: Please check src/auth/*.ts
```

---

## Pattern Rules

The `->relay:` pattern must be at the start of a line:

```
->relay:Name message           # Works
  ->relay:Name message         # Works (whitespace OK)
> ->relay:Name message         # Works (prompt OK)
- ->relay:Name message         # Works (list OK)
Some text ->relay:Name msg     # Won't work
```

### Escape

To output literal `->relay:` without sending:

```
\->relay: This won't be sent
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Messages not sending | `agent-relay status` to check daemon |
| Socket not found | `agent-relay up` to start daemon |
| Truncated message | `agent-relay read <id>` for full content |

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

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
