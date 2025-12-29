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

**CRITICAL:** Always end with `>>>` at the end of the last line of content!

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

## Common Patterns

```
->relay:* <<<
STATUS: Starting work on auth module>>>

->relay:* <<<
DONE: Auth module complete>>>

->relay:Developer <<<
TASK: Implement /api/register>>>

->relay:Reviewer <<<
REVIEW: Please check src/auth/*.ts>>>

->relay:Architect <<<
QUESTION: JWT or sessions?>>>
```

## Rules

- Pattern must be at line start (whitespace OK)
- Escape with `\->relay:` to output literally
- Check daemon status: `agent-relay status`
