# Agent Relay Protocol (Internal)

Advanced features for session continuity and trajectory tracking.

## Session Continuity

Use `mcp__relaycast__message_dm_send` with a continuity message to save state for session recovery:

```
mcp__relaycast__message_dm_send(to: "system", text: "KIND: continuity\nACTION: save\n\nCurrent task: Implementing user authentication\nCompleted: User model, JWT utils\nIn progress: Login endpoint")
```

### When to Save

- Before long-running operations (builds, tests)
- When switching task areas
- Every 15-20 minutes of active work
- Before ending session

## Work Trajectories

Record your work as a trajectory for future agents.

### Starting Work

```bash
trail start "Implement user authentication"
trail start "Fix login bug" --task "agent-relay-123"
```

### Recording Decisions

```bash
trail decision "Chose JWT over sessions" --reasoning "Stateless scaling"
trail decision "Used existing auth middleware"
```

### Completing Work

```bash
trail complete --summary "Added JWT auth" --confidence 0.85
```

Confidence: 0.9+ (high), 0.7-0.9 (good), 0.5-0.7 (some uncertainty), <0.5 (needs review)

### Abandoning Work

```bash
trail abandon --reason "Blocked by missing credentials"
```

## Cross-Project Messaging

In bridge mode, use `project:agent` format with `mcp__relaycast__message_dm_send`:

```
mcp__relaycast__message_dm_send(to: "frontend:Designer", text: "Please update the login UI.")
```

Special targets:

- `project:lead` - Lead agent of that project
- `project:*` - Broadcast to project
- `*:*` - Broadcast to all projects
