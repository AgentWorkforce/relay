# Proposal: Agent Relay + Conductor Integration

**Status**: Draft
**Author**: Agent Relay Team
**Date**: December 2024
**Target**: Conductor (conductor.build)

---

## Executive Summary

Conductor orchestrates multiple AI coding agents in parallel workspaces. Agent Relay enables real-time agent-to-agent messaging. Together, they create a coordinated multi-agent development environment where parallel agents can communicate, negotiate work, and avoid conflicts.

This proposal outlines a proof-of-concept integration demonstrating how Conductor-managed agents can communicate via Agent Relay.

---

## The Opportunity

### Conductor's Current Model

```
┌─────────────────────────────────────────────────────────┐
│                      Conductor                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  Agent A    │  │  Agent B    │  │  Agent C    │     │
│  │  (worktree) │  │  (worktree) │  │  (worktree) │     │
│  │             │  │             │  │             │     │
│  │  Isolated   │  │  Isolated   │  │  Isolated   │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
│         │                │                │              │
│         └────────────────┼────────────────┘              │
│                          │                               │
│                    No Communication                      │
└─────────────────────────────────────────────────────────┘
```

**Current limitations**:
- Agents work in isolation with no inter-agent awareness
- Risk of conflicting changes to shared files
- No way to share context or discoveries
- Coordination requires human intervention
- Duplicate work when agents solve similar problems independently

### With Agent Relay Integration

```
┌─────────────────────────────────────────────────────────┐
│                      Conductor                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  Agent A    │  │  Agent B    │  │  Agent C    │     │
│  │  (worktree) │  │  (worktree) │  │  (worktree) │     │
│  │             │  │             │  │             │     │
│  │  ->relay:B  │←→│  ->relay:A  │←→│  ->relay:*  │     │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │
│         │                │                │              │
│         └────────────────┼────────────────┘              │
│                          │                               │
│                ┌─────────▼─────────┐                    │
│                │   Agent Relay     │                    │
│                │      Daemon       │                    │
│                │  (message router) │                    │
│                └───────────────────┘                    │
└─────────────────────────────────────────────────────────┘
```

**Enabled capabilities**:
- Real-time agent-to-agent messaging (<5ms latency)
- File lock announcements ("I'm modifying auth.ts")
- Context sharing ("Found the bug in line 234")
- Review requests ("Please check my changes to api/")
- Task negotiation ("I'll take payments, you take auth")
- Broadcast status updates ("Done with feature X")

---

## Technical Compatibility

| Aspect | Conductor | Agent Relay | Compatibility |
|--------|-----------|-------------|---------------|
| Runtime | macOS app | Node.js CLI | ✅ Both local |
| Agents | Claude Code, Codex | Claude Code, any CLI | ✅ Overlap |
| Isolation | Git worktrees | Per-project namespace | ✅ Compatible |
| Auth | Uses existing API keys | No auth required | ✅ No conflict |
| Storage | Local | SQLite local | ✅ Both local |

---

## Integration Approaches

### Option A: Wrapper Pattern (Recommended for PoC)

**Effort**: Low
**Changes to Conductor**: Minimal (spawn command modification)

Conductor changes how it spawns agents:

```diff
- spawn: claude --task "implement feature"
+ spawn: agent-relay -n AgentA -- claude --task "implement feature"
```

Agent Relay wraps each agent, parsing output for `->relay:` patterns and injecting incoming messages.

**Pros**:
- Zero changes to Agent Relay
- Minimal changes to Conductor
- Works immediately with current versions
- Easy to test and validate

**Cons**:
- Requires Agent Relay CLI installed
- Less tight integration with Conductor UI

### Option B: Embedded Client

**Effort**: Medium
**Changes to Conductor**: Moderate (embed RelayClient)

Conductor embeds Agent Relay's `RelayClient` directly:

```typescript
import { RelayClient } from 'agent-relay';

// When spawning each agent
const client = new RelayClient({
  agentName: agentConfig.name,
  socketPath: getProjectSocket(repo),
  capabilities: { ack: true, resume: true }
});

await client.connect();

// Route messages from agent output
agentProcess.stdout.on('data', (data) => {
  const messages = parseRelayPatterns(data);
  messages.forEach(msg => client.sendMessage(msg.to, msg.body));
});

// Inject received messages
client.onMessage = (from, payload) => {
  agentProcess.stdin.write(`\nRelay message from ${from}: ${payload.body}\n`);
};
```

**Pros**:
- Tighter integration
- No external CLI dependency
- More control over message injection timing

**Cons**:
- Requires Conductor code changes
- Need to handle message parsing

### Option C: Daemon Sidecar with UI Integration

**Effort**: High
**Changes to Conductor**: Significant (UI + daemon management)

Conductor manages Agent Relay daemon lifecycle and integrates message feed into Conductor UI:

```typescript
// Conductor manages daemon
await exec('agent-relay up --no-dashboard');

// Conductor queries message history
const messages = await fetch(`http://localhost:3888/api/messages`);

// Conductor displays in unified UI
renderMessageFeed(messages);
```

**Pros**:
- Best user experience
- Unified monitoring
- Full control over lifecycle

**Cons**:
- Most development effort
- Requires API additions to Agent Relay

---

## Proof of Concept Scope

### Goals

1. Demonstrate two Conductor-style agents communicating via Agent Relay
2. Show conflict avoidance through file lock announcements
3. Validate latency and reliability
4. Produce demo video/recording

### Non-Goals (for PoC)

- Full Conductor integration
- UI changes to Conductor
- Production deployment
- Performance optimization

### PoC Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Demo Repository                           │
│                                                              │
│  Terminal 1:                    Terminal 2:                  │
│  ┌─────────────────────┐       ┌─────────────────────┐      │
│  │ agent-relay -n Dev1 │       │ agent-relay -n Dev2 │      │
│  │ -- claude           │       │ -- claude           │      │
│  │                     │       │                     │      │
│  │ Task: Implement     │       │ Task: Implement     │      │
│  │ user registration   │       │ payment processing  │      │
│  └──────────┬──────────┘       └──────────┬──────────┘      │
│             │                             │                  │
│             └──────────┬──────────────────┘                  │
│                        │                                     │
│              ┌─────────▼─────────┐                          │
│              │   Agent Relay     │                          │
│              │   Daemon + UI     │                          │
│              │   localhost:3888  │                          │
│              └───────────────────┘                          │
│                                                              │
│  Terminal 3:                                                 │
│  agent-relay up                                              │
└─────────────────────────────────────────────────────────────┘
```

### Demo Scenarios

#### Scenario 1: File Lock Announcement

```
Dev1: Starting work on src/auth/login.ts
      ->relay:* LOCK: src/auth/login.ts - implementing login flow

Dev2: [Receives message]
      Relay message from Dev1: LOCK: src/auth/login.ts - implementing login flow

Dev2: I see Dev1 is working on auth. I'll focus on payment module instead.
      ->relay:Dev1 Acknowledged. I'll work on src/payments/ instead.
```

#### Scenario 2: Context Sharing

```
Dev1: Found an issue with the database schema.
      ->relay:* DISCOVERY: users table missing 'email_verified' column

Dev2: [Receives discovery]
      Thanks for the heads up. I'll account for that in my payment flow.
      ->relay:Dev1 Good catch. I'll add a migration for that column.
```

#### Scenario 3: Code Review Request

```
Dev1: Finished auth implementation.
      ->relay:Dev2 REVIEW: Please check src/auth/*.ts when you have time

Dev2: [Receives request]
      ->relay:Dev1 Will review after I finish current task (~5 min)
```

#### Scenario 4: Task Handoff

```
Dev1: I need to work on something that touches payments.
      ->relay:Dev2 QUESTION: Can you take over the webhook handler? I need to add auth.

Dev2: ->relay:Dev1 Yes, I'll handle webhooks. You focus on auth integration.
```

---

## Implementation Plan

### Phase 1: Setup (Day 1)

1. Create demo repository with realistic structure
2. Verify Agent Relay works with Claude Code
3. Document agent prompts that encourage communication
4. Set up screen recording

### Phase 2: Basic Communication Demo (Day 1-2)

1. Start daemon: `agent-relay up`
2. Launch Agent A: `agent-relay -n Dev1 -- claude`
3. Launch Agent B: `agent-relay -n Dev2 -- claude`
4. Give both agents tasks that naturally intersect
5. Observe/guide communication patterns
6. Record successful exchanges

### Phase 3: Conflict Avoidance Demo (Day 2)

1. Create scenario where both agents might edit same file
2. Demonstrate how announcement prevents conflict
3. Show agents negotiating work distribution
4. Record before/after comparison

### Phase 4: Documentation (Day 3)

1. Write up findings
2. Create integration guide for Conductor team
3. Identify API additions needed for deeper integration
4. Package demo as reproducible script

---

## Communication Patterns for Agents

Recommended patterns for Conductor-managed agents:

### Status Updates
```
->relay:* STATUS: Starting work on [feature]
->relay:* DONE: Completed [feature]
->relay:* BLOCKED: Waiting on [dependency]
```

### File Coordination
```
->relay:* LOCK: path/to/file - [reason]
->relay:* UNLOCK: path/to/file
->relay:* MODIFIED: path/to/file - [summary of changes]
```

### Requests
```
->relay:AgentName REVIEW: [description]
->relay:AgentName QUESTION: [question]
->relay:AgentName TASK: [task description]
```

### Responses
```
->relay:AgentName ACK: [acknowledgement]
->relay:AgentName ANSWER: [answer to question]
->relay:AgentName DECLINED: [reason]
```

---

## Success Criteria

| Metric | Target |
|--------|--------|
| Message delivery latency | <100ms end-to-end |
| Message reliability | 100% delivery in demo |
| Conflict prevention | At least 1 prevented conflict |
| Communication patterns | 5+ meaningful exchanges |
| Demo recording | 3-5 minute polished video |

---

## API Requirements for Deep Integration

For Conductor to deeply integrate, Agent Relay should expose:

### REST API (Dashboard server)

```
GET  /api/agents              # List connected agents
GET  /api/messages            # Query message history
POST /api/messages            # Send message (for UI integration)
WS   /ws                      # Real-time message stream
```

### Node.js SDK

```typescript
// Already exists: RelayClient for agent communication
import { RelayClient } from 'agent-relay';

// Needed: DaemonManager for lifecycle control
import { DaemonManager } from 'agent-relay';
const daemon = new DaemonManager({ projectPath: '/path/to/repo' });
await daemon.start();
await daemon.stop();

// Needed: MessageStore for history queries
import { MessageStore } from 'agent-relay';
const store = new MessageStore({ projectPath: '/path/to/repo' });
const messages = await store.query({ from: 'Dev1', limit: 100 });
```

---

## Open Questions

1. **Agent naming**: Should Conductor control agent names, or let Agent Relay auto-generate?

2. **Message persistence**: Should messages persist across Conductor sessions?

3. **UI integration**: Should Conductor show Agent Relay messages in its UI, or link to Agent Relay dashboard?

4. **Multi-repo**: How should communication work when Conductor manages multiple repos?

5. **Authentication**: Should agents authenticate to each other, or trust all local agents?

---

## Next Steps

1. **Share this proposal** with Conductor team for feedback
2. **Execute PoC** following the implementation plan above
3. **Record demo** showing successful agent coordination
4. **Iterate** based on feedback and findings
5. **Plan production integration** if PoC validates the approach

---

## Appendix: Agent Relay Resources

- **Repository**: [github.com/khaliqgant/agent-relay](https://github.com/khaliqgant/agent-relay)
- **Protocol Spec**: `docs/PROTOCOL.md`
- **Integration Guide**: `docs/INTEGRATION-GUIDE.md`
- **Architecture**: `docs/ARCHITECTURE_DECISIONS.md`

---

## Contact

For questions about this proposal or Agent Relay integration:
- Open an issue on the Agent Relay repository
- Reach out via the channels listed in CONTRIBUTING.md
