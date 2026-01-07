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

**CRITICAL:** Always close multi-line messages with `>>>` after the very last character.

**WARNING:** Do NOT put blank lines before `>>>` - it must immediately follow your content:

```
# CORRECT - >>> immediately after content
->relay:Agent <<<Your message here.>>>

# WRONG - blank line before >>> breaks parsing
->relay:Agent <<<
Your message here.

>>>
```

## Communication Protocol

**ACK immediately** - When you receive a task, acknowledge it before starting work:

```
->relay:Sender <<<
ACK: Brief description of task received>>>
```

**Report completion** - When done, send a completion message:

```
->relay:Sender <<<
DONE: Brief summary of what was completed>>>
```

## Receiving Messages

Messages appear as:
```
Relay message from Alice [abc123]: Message content here
```

### Channel Routing (Important!)

Messages from #general (broadcast channel) include a `[#general]` indicator:
```
Relay message from Alice [abc123] [#general]: Hello everyone!
```

**When you see `[#general]`**: Reply to `*` (broadcast), NOT to the sender directly.

```
# Correct - responds to #general channel
->relay:* <<<
Response to the group message.>>>

# Wrong - sends as DM to sender instead of to the channel
->relay:Alice <<<
Response to the group message.>>>
```

If truncated, read full message:
```bash
agent-relay read abc123
```

## Spawning Agents

Spawn workers to delegate tasks:

```
# Short tasks - single line with quotes
->relay:spawn WorkerName claude "short task description"

# Long tasks - use fenced format (recommended)
->relay:spawn WorkerName claude <<<
Implement the authentication module.
Requirements:
- JWT tokens with refresh
- Password hashing with bcrypt
- Rate limiting on login endpoint>>>

# Release when done
->relay:release WorkerName
```

**Use fenced format for tasks longer than ~50 characters** to avoid truncation from terminal line wrapping.

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

## Status Updates

**Send status updates to your lead, NOT broadcast:**

```
# Correct - status to lead only
->relay:Lead <<<
STATUS: Working on auth module>>>

# Wrong - don't broadcast status to everyone
->relay:* <<<
STATUS: Working on auth module>>>
```

## Common Patterns

```
->relay:Lead <<<
ACK: Starting /api/register implementation>>>

->relay:Lead <<<
STATUS: Working on auth module>>>

->relay:Lead <<<
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
- **Do NOT include self-identification or preamble in messages** - start with your actual response content, not "I'm [agent type] running as..."

## Writing Examples (For Documentation)

When showing examples of relay syntax in documentation or explanations, **escape the markers** so they don't get interpreted as actual messages:

```
# Escape the opening marker
\->relay:AgentName \<<<
Example content here.\>>>
```

**What to escape:**
- `\->relay:` - Prevents the pattern from being detected as a real message
- `\<<<` - Prevents the fenced block from being parsed
- `\>>>` - Prevents the block from being closed

This ensures your examples are displayed literally rather than sent as messages.
