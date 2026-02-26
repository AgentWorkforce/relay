# Collaborative Task Example

Multiple AI agents working together on a shared coding task using agent-relay.

## Scenario

Three agents collaborate on building a feature:

- **Architect** - Designs the solution and coordinates
- **Developer** - Implements the code
- **Reviewer** - Reviews code and suggests improvements

## Prerequisites

- agent-relay installed
- Three terminal windows

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

> "You are the Architect. Your job is to design a solution for adding user authentication. Once you have a plan, message Developer with the design using: relay_send(to: 'Developer', message: 'your design here')"

### Terminal 3: Developer

```bash
npx agent-relay wrap -n Developer "claude"
```

### Terminal 4: Reviewer

```bash
npx agent-relay wrap -n Reviewer "claude"
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

Agents use structured communication via MCP tools:

```
# Architect assigns task
relay_send(to: "Developer", message: "TASK: Implement user registration endpoint. Requirements: POST /api/register, validate email, hash password, return JWT.")

# Developer requests review
relay_send(to: "Reviewer", message: "REVIEW REQUEST: Please review src/api/register.ts")

# Reviewer provides feedback
relay_send(to: "Developer", message: "FEEDBACK: Line 23: Use bcrypt instead of md5 for password hashing.")

# Developer notifies completion
relay_send(to: "Architect", message: "DONE: Registration endpoint implemented and reviewed.")
```

## Tips

- Use `relay_send(to: "Name", message: "...")` for direct messages
- Use clear prefixes (TASK:, REVIEW:, FEEDBACK:, DONE:) for structured communication
- Keep messages concise - agents can read files for details
