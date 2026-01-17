# Agent Relay Examples

Practical examples for common multi-agent patterns.

---

## Example 1: Hierarchical Planning (Lead Spawns Workers)

A Lead agent decomposes a task and spawns workers to execute in parallel.

### Scenario
Build a REST API with authentication. Lead breaks it down and assigns to specialized workers.

### Lead Agent Setup

```bash
# Start Lead agent
agent-relay -n Lead claude --agent lead
```

### Lead's Task Decomposition

```
User: Build a REST API with user authentication

Lead thinks: I'll decompose this into parallel tasks...

Lead outputs:
->relay-file:spawn-backend
```

Where `spawn-backend` contains:
```
KIND: spawn
NAME: Backend
CLI: claude --agent backend

Implement the Express server with routes:
- POST /auth/register
- POST /auth/login
- GET /auth/me (protected)
Use JWT for tokens. Create in src/api/
```

```
->relay-file:spawn-database
```

Where `spawn-database` contains:
```
KIND: spawn
NAME: Database
CLI: claude --agent database

Create PostgreSQL schema for users table:
- id, email, password_hash, created_at
Use Drizzle ORM. Create migration in src/db/
```

### Workers Report Back

```
# Backend worker completes
->relay-file:done

TO: Lead

DONE: Express server implemented
- Created src/api/server.ts
- Routes: /auth/register, /auth/login, /auth/me
- JWT middleware in src/api/middleware/auth.ts
- Ready for integration testing
```

```
# Database worker completes
->relay-file:done

TO: Lead

DONE: Database schema created
- Created src/db/schema.ts with users table
- Migration: 0001_create_users.sql
- Drizzle config ready
```

### Lead Integrates

```
Lead receives both DONE messages...

Lead outputs:
->relay-file:integrate

TO: *

Both components ready. Backend, please integrate with Database schema.
The Drizzle client is exported from src/db/index.ts.
```

---

## Example 2: Consensus Code Review (2+ Agents Approve)

Multiple agents review code and must reach consensus before merge.

### Scenario
A PR needs approval from at least 2 of 3 reviewers (Security, Backend, QA).

### Proposing the Review

```bash
# Lead proposes the review
cat > /tmp/relay-outbox/Lead/propose << 'EOF'
TO: _consensus

PROPOSE: Approve PR #42 - Add password reset feature
TYPE: quorum
PARTICIPANTS: Security, Backend, QA
QUORUM: 2
TIMEOUT: 600000

Review criteria:
- Security: No vulnerabilities, proper input validation
- Backend: Code quality, error handling
- QA: Test coverage, edge cases

Files changed:
- src/auth/password-reset.ts
- src/api/routes/reset.ts
- tests/auth/reset.test.ts
EOF
```

### Reviewers Vote

```bash
# Security approves
cat > /tmp/relay-outbox/Security/vote << 'EOF'
TO: _consensus
PROPOSAL: pr-42-review
VOTE: approve

Reasoning:
- Input validation on email and token ✓
- Rate limiting on reset endpoint ✓
- Token expiry properly implemented ✓
- No SQL injection vectors ✓
EOF
```

```bash
# Backend approves with suggestions
cat > /tmp/relay-outbox/Backend/vote << 'EOF'
TO: _consensus
PROPOSAL: pr-42-review
VOTE: approve

Reasoning:
- Clean code structure ✓
- Error handling complete ✓
- Consider adding retry logic for email sending (minor, non-blocking)
EOF
```

```bash
# QA approves
cat > /tmp/relay-outbox/QA/vote << 'EOF'
TO: _consensus
PROPOSAL: pr-42-review
VOTE: approve

Reasoning:
- 94% test coverage ✓
- Edge cases covered: expired token, invalid email, rate limit ✓
- Integration test passes ✓
EOF
```

### Consensus Reached

Lead receives:
```
Relay message from _consensus [abc123]:

CONSENSUS REACHED: PR #42 - Add password reset feature
Status: APPROVED
Votes: 3/3 approve (quorum: 2)

Summary:
- Security: Approved - No vulnerabilities found
- Backend: Approved - Clean code, minor suggestion for retry logic
- QA: Approved - 94% coverage, all edge cases tested

Ready to merge.
```

---

## Example 3: Long-Running Task with Continuity

An agent works on a complex feature over multiple sessions, using continuity for handoffs.

### Session 1: Starting the Work

```bash
# Worker starts feature
agent-relay -n FeatureWorker claude
```

```
User: Implement real-time notifications using WebSockets

FeatureWorker works for 30 minutes...

# Save progress before a long build
cat > /tmp/relay-outbox/FeatureWorker/continuity << 'EOF'
KIND: continuity
ACTION: save

Current task: Real-time notifications with WebSockets
Completed:
- WebSocket server setup (src/ws/server.ts)
- Connection manager (src/ws/connections.ts)
- Basic pub/sub (src/ws/pubsub.ts)

In progress:
- Authentication middleware for WS connections

Key decisions:
- Using ws library instead of socket.io (lighter weight)
- Room-based architecture for channel subscriptions
- Redis pub/sub for horizontal scaling

Files:
- src/ws/*.ts
- src/middleware/ws-auth.ts (in progress)

Next steps:
- Complete WS auth middleware
- Add notification types
- Client SDK
EOF
```
Then: `->relay-file:continuity`

### Session 2: Resuming Work

```bash
# New session starts - context auto-loads
agent-relay -n FeatureWorker claude
```

FeatureWorker sees on startup:
```
## Previous Session Context

**Current Task:** Real-time notifications with WebSockets

**Completed:**
- WebSocket server setup (src/ws/server.ts)
- Connection manager (src/ws/connections.ts)
- Basic pub/sub (src/ws/pubsub.ts)

**In Progress:**
- Authentication middleware for WS connections

**Key Decisions:**
- Using ws library instead of socket.io (lighter weight)
- Room-based architecture for channel subscriptions
- Redis pub/sub for horizontal scaling

**Next Steps:**
1. Complete WS auth middleware
2. Add notification types
3. Client SDK
```

FeatureWorker continues from where it left off...

### Session 3: Completing with Handoff

```bash
# Worker finishing up
cat > /tmp/relay-outbox/FeatureWorker/handoff << 'EOF'
KIND: continuity
ACTION: handoff

Summary: Real-time notifications feature complete

Completed work:
- WebSocket server with auth middleware
- Pub/sub system with Redis backend
- Notification types: message, alert, update
- Client SDK for React (src/client/ws-hook.ts)
- Integration tests passing

Next steps for future work:
- Add notification preferences per user
- Implement push notifications fallback
- Add analytics for notification delivery

Key decisions made:
- ws over socket.io: 3x smaller bundle, sufficient features
- Room-based architecture: scales to 10k concurrent per room
- Redis pub/sub: enables horizontal scaling across instances

Files to know:
- src/ws/ - Server implementation
- src/client/ws-hook.ts - React hook
- tests/ws/ - Integration tests
- docs/WEBSOCKET.md - API documentation
EOF
```
Then: `->relay-file:handoff`

### Future: Searching Past Work

```bash
# New agent needs to understand WS implementation
cat > /tmp/relay-outbox/NewWorker/search << 'EOF'
KIND: continuity
ACTION: search

Query: WebSocket notifications architecture
EOF
```
Then: `->relay-file:search`

NewWorker receives:
```
## Search Results: "WebSocket notifications architecture"

### Handoff: Real-time notifications (2 days ago)
Agent: FeatureWorker
Summary: Complete WebSocket notification system with Redis pub/sub

Key decisions:
- ws library (lighter than socket.io)
- Room-based architecture (10k concurrent/room)
- Redis pub/sub for horizontal scaling

Files: src/ws/, src/client/ws-hook.ts

### Handoff: Initial WS exploration (1 week ago)
Agent: Researcher
Summary: Evaluated WebSocket libraries and architecture patterns
...
```

---

## Quick Reference

### Spawn a Worker
```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/spawn << 'EOF'
KIND: spawn
NAME: WorkerName
CLI: claude --agent worker-type

Task description here.
EOF
```
Then: `->relay-file:spawn`

### Send a Message
```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/msg << 'EOF'
TO: TargetAgent

Your message here.
EOF
```
Then: `->relay-file:msg`

### Broadcast to All
```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/broadcast << 'EOF'
TO: *

Message for everyone.
EOF
```
Then: `->relay-file:broadcast`

### Save Continuity
```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/continuity << 'EOF'
KIND: continuity
ACTION: save

Current task: ...
Completed: ...
In progress: ...
EOF
```
Then: `->relay-file:continuity`

### Create Handoff
```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/handoff << 'EOF'
KIND: continuity
ACTION: handoff

Summary: ...
Completed work: ...
Next steps: ...
EOF
```
Then: `->relay-file:handoff`

---

*See [INTEGRATION-GUIDE.md](./INTEGRATION-GUIDE.md) for detailed API documentation.*
