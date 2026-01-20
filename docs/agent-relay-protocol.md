# Agent Relay Protocol (Internal)

Advanced features for session continuity, consensus voting, and trajectory tracking.

---

## Session Continuity

Save your state for session recovery using file-based format.

### Continuity Commands

| Action | Description |
|--------|-------------|
| `save` | Save current session state to ledger |
| `load` | Load previous context (auto-runs on startup) |
| `search` | Search past handoffs |
| `uncertain` | Flag item for future verification |
| `handoff` | Create permanent handoff document |

### Save Ledger

Save current work state before long operations:

```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/continuity << 'EOF'
KIND: continuity
ACTION: save

Current task: Implementing user authentication
Completed: User model, JWT utils, Password hashing
In progress: Login endpoint, Session management
Blocked: OAuth integration (waiting for client ID)
Key decisions: Using JWT with refresh tokens
Uncertain: Rate limit handling unclear
Files: src/auth/*.ts, src/middleware/auth.ts
EOF
```
Then: `->relay-file:continuity`

**When to Save:**
- Before long-running operations (builds, tests)
- When switching task areas
- Every 15-20 minutes of active work
- Before ending session
- Before asking user a blocking question

### Load Previous Context

Context auto-loads on startup. To manually request:

```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/load << 'EOF'
KIND: continuity
ACTION: load
EOF
```
Then: `->relay-file:load`

### Search Past Handoffs

Find previous work on a topic:

```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/search << 'EOF'
KIND: continuity
ACTION: search

Query: authentication JWT implementation
EOF
```
Then: `->relay-file:search`

### Mark Uncertainties

Flag items needing future verification:

```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/uncertain << 'EOF'
KIND: continuity
ACTION: uncertain

API rate limit handling unclear - needs investigation
EOF
```
Then: `->relay-file:uncertain`

### Create Handoff

Create permanent record on task/session completion:

```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/handoff << 'EOF'
KIND: continuity
ACTION: handoff

Summary: User authentication 80% complete
Task: Implement user authentication system
Completed work:
- User model with Drizzle ORM
- JWT token generation and validation
- Password hashing with bcrypt
Next steps:
- Complete login endpoint
- Add refresh token rotation
Key decisions:
- JWT over sessions: Stateless, scales horizontally
Learnings:
- Token refresh should happen server-side
EOF
```
Then: `->relay-file:handoff`

---

## Consensus Voting

Distributed decision-making via the `_consensus` system target.

### The `_consensus` Target

`_consensus` is a special relay target (not an agent) that routes to the daemon's consensus engine:
- Receives PROPOSE commands to create proposals
- Receives VOTE commands to cast votes
- Broadcasts results when consensus is reached

### Create a Proposal

```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/propose << 'EOF'
TO: _consensus

PROPOSE: Approve PR #42 - Add authentication feature
TYPE: quorum
PARTICIPANTS: Security, Backend, QA
QUORUM: 2
TIMEOUT: 600000
DESCRIPTION: Review the authentication implementation.
EOF
```
Then: `->relay-file:propose`

**Proposal Fields:**
- `PROPOSE:` (required) - Title
- `TYPE:` - `majority` | `supermajority` | `unanimous` | `weighted` | `quorum`
- `PARTICIPANTS:` (required) - Comma-separated agent names
- `QUORUM:` - Minimum votes (for quorum type)
- `THRESHOLD:` - Threshold 0-1 (for supermajority, default 0.67)
- `TIMEOUT:` - Milliseconds until expiry (default 5 min)
- `DESCRIPTION:` - Detailed description

### Cast a Vote

```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/vote << 'EOF'
TO: _consensus

VOTE prop_1737500000_abc12345 approve

Security checks passed. No vulnerabilities found.
EOF
```
Then: `->relay-file:vote`

**Vote Format:**
```
VOTE <proposal-id> <approve|reject|abstain> [reason]
```

### Receive Results

Participants automatically receive:
```
Relay message from _consensus [abc123]:

CONSENSUS RESULT: Approve PR #42
Decision: APPROVED
Participation: 100.0%

Approve: 3 | Reject: 0 | Abstain: 0
```

---

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

Confidence levels:
- 0.9+ - High confidence, well-tested
- 0.7-0.9 - Good confidence, standard implementation
- 0.5-0.7 - Some uncertainty, edge cases possible
- <0.5 - Significant uncertainty, needs review

### Abandoning Work

```bash
trail abandon --reason "Blocked by missing credentials"
```

### Check Status

```bash
trail status
```

---

## Cross-Project Messaging

In bridge mode, use `project:agent` format:

```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/msg << 'EOF'
TO: frontend:Designer

Please update the login UI.
EOF
```
Then: `->relay-file:msg`

**Special Targets:**
- `project:lead` - Lead agent of that project
- `project:*` - Broadcast to project
- `*:*` - Broadcast to all projects

---

## Quick Reference

| Pattern | Description |
|---------|-------------|
| `->relay-file:continuity` | Save/load session state |
| `->relay-file:handoff` | Create permanent handoff |
| `->relay-file:propose` | Start consensus proposal |
| `->relay-file:vote` | Vote on proposal |
| `TO: _consensus` | Route to consensus engine |
| `TO: project:agent` | Cross-project message |
| `trail start` | Begin trajectory |
| `trail complete` | End trajectory |
