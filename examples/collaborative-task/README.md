# Collaborative Task Example

Multiple AI agents working together on a shared coding task using agent-relay.

## Scenario

Three agents collaborate on building a feature:
- **Architect** - Designs the solution and coordinates
- **Developer** - Implements the code
- **Reviewer** - Reviews code and suggests improvements

## Prerequisites

- agent-relay installed
- Three terminal windows (or use file-based inboxes)

## Quick Start with PTY Wrapper

### Terminal 1: Daemon
```bash
npx agent-relay start -f
```

### Terminal 2: Architect
```bash
npx agent-relay wrap -n Architect "claude"
```

Tell the agent:
> "You are the Architect. Your job is to design a solution for adding user authentication. Once you have a plan, message Developer with the design using >>relay:Developer"

### Terminal 3: Developer
```bash
npx agent-relay wrap -n Developer "claude"
```

### Terminal 4: Reviewer
```bash
npx agent-relay wrap -n Reviewer "claude"
```

## File-Based Approach

For automation or when PTY wrapping isn't ideal:

```bash
# Run setup
./setup.sh /tmp/collab-task

# In three separate agent sessions, read the instruction files:
# Agent 1: cat /tmp/collab-task/Architect/INSTRUCTIONS.md
# Agent 2: cat /tmp/collab-task/Developer/INSTRUCTIONS.md
# Agent 3: cat /tmp/collab-task/Reviewer/INSTRUCTIONS.md
```

## Communication Flow

```
Architect                Developer                Reviewer
    |                        |                       |
    |---(design doc)-------->|                       |
    |                        |                       |
    |                        |---(code for review)-->|
    |                        |                       |
    |                        |<--(review feedback)---|
    |                        |                       |
    |<--(status update)------|                       |
    |                        |                       |
```

## Message Protocol

Agents use structured communication:

```bash
# Architect assigns task
>>relay:Developer TASK: Implement user registration endpoint.
Requirements: POST /api/register, validate email, hash password, return JWT.

# Developer requests review
>>relay:Reviewer REVIEW REQUEST: Please review src/api/register.ts

# Reviewer provides feedback
>>relay:Developer FEEDBACK: Line 23: Use bcrypt instead of md5 for password hashing.

# Developer notifies completion
>>relay:Architect DONE: Registration endpoint implemented and reviewed.
```

## Tips

- Use clear prefixes (TASK:, REVIEW:, FEEDBACK:, DONE:) for structured communication
- Broadcast status updates with `>>relay:*`
- Keep messages concise - agents can read files for details
