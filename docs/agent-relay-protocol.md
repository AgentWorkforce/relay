# Agent Relay Protocol (Internal)

Advanced features for session continuity and trajectory tracking.

## Session Continuity

Save your state for session recovery using file-based format (same as messaging):

```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/continuity << 'EOF'
KIND: continuity
ACTION: save

Current task: Implementing user authentication
Completed: User model, JWT utils
In progress: Login endpoint
Key decisions: Using refresh tokens
Files: src/auth/*.ts
EOF
```
Then: `->relay-file:continuity`

### When to Save

- Before long-running operations (builds, tests)
- When switching task areas
- Every 15-20 minutes of active work
- Before ending session

### Load Previous Context

Context auto-loads on startup. To manually request:

```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/load << 'EOF'
KIND: continuity
ACTION: load
EOF
```
Then: `->relay-file:load`

### Mark Uncertainties

Flag items needing future verification:

```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/uncertain << 'EOF'
KIND: continuity
ACTION: uncertain

API rate limit handling unclear
EOF
```
Then: `->relay-file:uncertain`

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

In bridge mode, use `project:agent` format:

```
TO: frontend:Designer

Please update the login UI.
```

Special targets:
- `project:lead` - Lead agent of that project
- `project:*` - Broadcast to project
- `*:*` - Broadcast to all projects
