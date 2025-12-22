# Agent-Relay v2 Design Document

## Overview

This document outlines improvements to agent-relay while preserving its core philosophy: **simple, transparent agent-to-agent communication via terminal output patterns**.

The `->relay:` pattern is the killer feature. Agents communicate naturally by just printing text. No APIs, no SDKs, no special integrations. This must remain the foundation.

---

## Current Pain Points

### 1. Ephemeral Storage (`/tmp`)
- Data lives in `/tmp/agent-relay/<hash>/`
- Cleared on reboot (macOS/Linux)
- Message history lost unexpectedly

### 2. Dead Code
- ACK/NACK protocol defined but not implemented
- Session resume tokens always return `RESUME_TOO_OLD`
- PostgreSQL adapter throws "not implemented"

### 3. Memory Leaks
- `sentMessageHashes` Set grows unbounded
- Long-running sessions will OOM

### 4. Polling Overhead
- `capture-pane` every 200ms consumes CPU
- Latency up to 200ms for message detection

### 5. Fragile Injection Timing
- 1.5s idle detection is a heuristic
- Race conditions if agent outputs during injection

---

## Design Principles

1. **Keep it simple** - Every feature must justify its complexity
2. **Terminal-native** - Users stay in tmux, not a browser
3. **Pattern-based** - `->relay:` is the API
4. **Zero config** - Works out of the box
5. **Debuggable** - Easy to understand what's happening

---

## Proposed Changes

### Phase 1: Foundation Fixes

#### 1.1 Persistent Storage Location

Move from `/tmp` to XDG-compliant location:

```
~/.local/share/agent-relay/          # XDG_DATA_HOME fallback
├── projects/
│   └── <project-hash>/
│       ├── relay.sock               # Unix socket
│       ├── messages.db              # SQLite
│       └── agents.json              # Connected agents
└── config.json                      # Global settings (optional)
```

**Migration path:**
- Check for existing `/tmp/agent-relay/` data on startup
- Offer one-time migration prompt
- Fall back to new location for fresh installs

#### 1.2 Remove Dead Code

Delete these unimplemented features:

| Feature | Location | Action |
|---------|----------|--------|
| ACK handling | `connection.ts:114-116` | Remove |
| Resume tokens | `connection.ts:140-143` | Remove |
| PostgreSQL adapter | `storage/adapter.ts:152-162` | Remove |
| Topic subscriptions | `router.ts` | Keep but mark experimental |

**Protocol simplification:**
```typescript
// Before: 10 message types
type MessageType = 'HELLO' | 'WELCOME' | 'SEND' | 'DELIVER' | 'ACK' |
                   'PING' | 'PONG' | 'SUBSCRIBE' | 'UNSUBSCRIBE' | 'ERROR' | 'BYE';

// After: 6 message types
type MessageType = 'HELLO' | 'WELCOME' | 'SEND' | 'DELIVER' |
                   'PING' | 'PONG' | 'ERROR';
```

#### 1.3 Fix Memory Leak

Replace unbounded Set with LRU cache:

```typescript
// Before
private sentMessageHashes: Set<string> = new Set();

// After
import { LRUCache } from 'lru-cache';

private sentMessageHashes = new LRUCache<string, boolean>({
  max: 10000,           // Max 10k unique messages tracked
  ttl: 1000 * 60 * 60,  // Expire after 1 hour
});
```

#### 1.4 Simplify Binary Protocol

Replace 4-byte length prefix with newline-delimited JSON:

```typescript
// Before: Binary framing
[4-byte length][JSON payload]

// After: NDJSON (newline-delimited JSON)
{"v":1,"type":"SEND","to":"Bob","payload":{"body":"Hello"}}\n
{"v":1,"type":"DELIVER","from":"Alice","payload":{"body":"Hello"}}\n
```

**Benefits:**
- Human-readable when debugging (`nc -U relay.sock`)
- Simpler parser (~20 lines vs ~50 lines)
- Standard format (NDJSON)

**Trade-off:** Messages cannot contain literal newlines in body. Since we already sanitize newlines for injection (`replace(/[\r\n]+/g, ' ')`), this is acceptable.

---

### Phase 2: Reliability Improvements

#### 2.1 Improved Injection Strategy

Replace time-based idle detection with input buffer detection:

```typescript
// Current: Wait 1.5s after last output (fragile)
if (Date.now() - lastOutputTime > 1500) {
  inject();
}

// Proposed: Check if input line is empty
async function isInputClear(): Promise<boolean> {
  // Capture current pane content
  const { stdout } = await execAsync(
    `tmux capture-pane -t ${session} -p -J`
  );
  const lines = stdout.split('\n');
  const lastLine = lines[lines.length - 1] || '';

  // Check if last line is just a prompt (no partial input)
  return /^[>$%#➜]\s*$/.test(lastLine);
}
```

#### 2.2 Bracketed Paste Mode

Use bracketed paste for safer injection:

```typescript
// Wrap injection in bracketed paste markers
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

async function injectSafe(text: string): Promise<void> {
  await sendKeysLiteral(PASTE_START + text + PASTE_END);
  await sendKeys('Enter');
}
```

**Benefits:**
- Prevents shell interpretation of special characters
- Atomic paste (no interleaving)
- Supported by most modern terminals/shells

#### 2.3 Message Queue for Offline Agents

Queue messages when target agent is disconnected:

```typescript
interface QueuedMessage {
  id: string;
  from: string;
  to: string;
  payload: SendPayload;
  queuedAt: number;
  attempts: number;
}

// In router.ts
if (!targetConnection || targetConnection.state !== 'ACTIVE') {
  this.messageQueue.enqueue({
    id: envelope.id,
    from: connection.agentName,
    to: envelope.to,
    payload: envelope.payload,
    queuedAt: Date.now(),
    attempts: 0,
  });

  // Notify sender
  connection.send({
    type: 'QUEUED',
    id: envelope.id,
    reason: 'recipient_offline',
  });
}

// On agent connect, flush queued messages
onAgentConnect(agentName: string) {
  const queued = this.messageQueue.getForRecipient(agentName);
  for (const msg of queued) {
    this.deliverMessage(msg);
    this.messageQueue.remove(msg.id);
  }
}
```

---

### Phase 3: Developer Experience

#### 3.1 Structured Logging

Replace scattered `console.log` with leveled logging:

```typescript
import { createLogger } from './logger.js';

const log = createLogger('daemon');

log.info('Agent registered', { name: 'Alice', cli: 'claude' });
log.debug('Message routed', { from: 'Alice', to: 'Bob', id: '...' });
log.error('Connection failed', { error: err.message });
```

Output format (when `DEBUG=agent-relay`):
```
[14:23:01.234] INFO  daemon: Agent registered name=Alice cli=claude
[14:23:01.456] DEBUG router: Message routed from=Alice to=Bob id=abc123
```

#### 3.2 Health Check Endpoint

Add simple HTTP health check (optional, disabled by default):

```typescript
// Enable with: agent-relay up --health-port 3889
// Or: AGENT_RELAY_HEALTH_PORT=3889

GET http://localhost:3889/health
{
  "status": "ok",
  "uptime": 3600,
  "agents": ["Alice", "Bob"],
  "messages": {
    "sent": 42,
    "delivered": 41,
    "queued": 1
  }
}
```

#### 3.3 CLI Improvements

```bash
# Current
agent-relay up
agent-relay -n Alice claude
agent-relay status
agent-relay read <id>

# Add
agent-relay agents              # List connected agents
agent-relay send Alice "Hello"  # Send from CLI (for testing)
agent-relay logs                # Tail daemon logs
agent-relay logs Alice          # Tail agent's relay activity
```

---

### Phase 4: Optional Enhancements

#### 4.1 WebSocket Streaming (Optional)

Replace polling with WebSocket-based output streaming:

```typescript
// Instead of polling capture-pane, attach via PTY
import { spawn } from 'node-pty';

const pty = spawn('tmux', ['attach-session', '-t', session, '-r'], {
  // Read-only attach
});

pty.onData((data) => {
  // Real-time output, no polling
  const { commands } = parser.parse(data);
  for (const cmd of commands) {
    sendRelayCommand(cmd);
  }
});
```

**Trade-offs:**
| Aspect | Polling | WebSocket/PTY |
|--------|---------|---------------|
| Latency | 0-200ms | ~1-10ms |
| CPU | Higher | Lower |
| Complexity | Simple | More complex |
| Dependencies | None | node-pty |

**Recommendation:** Keep polling as default, offer streaming as `--experimental-streaming` flag.

#### 4.2 Message Encryption (Optional)

For sensitive inter-agent communication:

```typescript
// Generate per-project key on first run
const projectKey = await generateKey();
fs.writeFileSync(keyPath, projectKey, { mode: 0o600 });

// Encrypt message bodies
const encrypted = await encrypt(payload.body, projectKey);
```

**Scope:** Only encrypt message body, not metadata (to/from/timestamp).

---

## Migration Plan

### v1.x → v2.0

1. **Storage migration**
   - Detect existing `/tmp/agent-relay/` data
   - Copy to `~/.local/share/agent-relay/`
   - Remove old location after successful migration

2. **Protocol compatibility**
   - v2 daemon accepts both binary and NDJSON
   - v2 clients send NDJSON only
   - Deprecation warning for binary clients

3. **Breaking changes**
   - Remove ACK/resume/PostgreSQL (unused)
   - Change default storage location

---

## File Structure (Post-Refactor)

```
src/
├── cli/
│   └── index.ts              # CLI entry point
├── daemon/
│   ├── server.ts             # Main daemon
│   ├── connection.ts         # Connection handling (simplified)
│   └── router.ts             # Message routing + queue
├── wrapper/
│   ├── tmux-wrapper.ts       # Agent wrapper
│   ├── parser.ts             # ->relay: pattern parser
│   └── client.ts             # Relay client
├── protocol/
│   └── types.ts              # Message types (reduced)
├── storage/
│   └── sqlite-adapter.ts     # SQLite only (removed abstraction)
└── utils/
    ├── logger.ts             # Structured logging
    ├── paths.ts              # XDG-compliant paths
    └── lru-cache.ts          # For deduplication
```

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Lines of code | ~2500 | ~2800 (with TUI) |
| Message types | 10 | 8 (added GROUP, TOPIC) |
| Max agents | ~3 practical | 10+ comfortable |
| Dependencies | 12 | 14 (adds blessed for TUI) |
| Memory (1hr session) | Unbounded | <100MB (10 agents) |
| Message detection latency | 0-200ms | 0-200ms |
| Data persistence | Lost on reboot | Permanent |
| Visibility | None | TUI dashboard |

---

## Phase 5: Multi-Agent Coordination (5-10 Agents)

Scaling from 2-3 agents to 5-10 requires better visibility, organization, and coordination patterns.

### 5.1 Agent Groups

Group agents for targeted messaging:

```bash
# Define groups in teams.json
{
  "groups": {
    "backend": ["ApiDev", "DbAdmin", "AuthService"],
    "frontend": ["UiDev", "Stylist"],
    "review": ["Reviewer", "QA"]
  }
}

# Send to group
->relay:@backend We need to refactor the user service
# → Message delivered to ApiDev, DbAdmin, AuthService

# Broadcast to all
->relay:* Starting deployment in 5 minutes
```

**Implementation:**
```typescript
// In router.ts
route(from: Connection, envelope: Envelope<SendPayload>) {
  const to = envelope.to;

  if (to === '*') {
    this.broadcast(from, envelope);
  } else if (to.startsWith('@')) {
    // Group message
    const groupName = to.slice(1);
    const members = this.groups.get(groupName) || [];
    for (const member of members) {
      if (member !== from.agentName) {
        this.sendTo(member, envelope);
      }
    }
  } else {
    this.sendTo(to, envelope);
  }
}
```

### 5.2 Terminal-Based Dashboard (TUI)

A simple terminal UI for monitoring all agents without leaving the terminal:

```bash
agent-relay watch
```

```
┌─ Agent Relay ──────────────────────────────────────────────┐
│ Agents (8 connected)                                        │
├─────────────────────────────────────────────────────────────┤
│ ● Coordinator    idle 2m     msgs: 12↑ 8↓                  │
│ ● ApiDev         active      msgs: 5↑ 14↓    typing...     │
│ ● DbAdmin        active      msgs: 3↑ 6↓                   │
│ ● AuthService    idle 45s    msgs: 2↑ 4↓                   │
│ ● UiDev          active      msgs: 8↑ 10↓   typing...      │
│ ● Stylist        idle 5m     msgs: 1↑ 2↓                   │
│ ● Reviewer       active      msgs: 0↑ 15↓                  │
│ ○ QA             offline     queued: 3                      │
├─────────────────────────────────────────────────────────────┤
│ Recent Messages                                             │
│ 14:23:01 ApiDev → DbAdmin: Can you check the user table?   │
│ 14:23:15 DbAdmin → ApiDev: Schema looks correct            │
│ 14:23:30 Coordinator → @backend: Stand up in 5 mins        │
│ 14:24:01 UiDev → Reviewer: PR ready for auth flow          │
├─────────────────────────────────────────────────────────────┤
│ [a]ttach  [s]end  [g]roups  [q]uit                         │
└─────────────────────────────────────────────────────────────┘
```

**Features:**
- Real-time agent status (active/idle/offline)
- Message counts and queue depth
- Recent message feed
- Quick attach to any agent's tmux session
- Send messages from dashboard

**Implementation:** Use `blessed` or `ink` for terminal UI:
```typescript
// src/cli/watch.ts
import blessed from 'blessed';

const screen = blessed.screen({ smartCSR: true });
const agentList = blessed.list({
  parent: screen,
  label: 'Agents',
  // ...
});

// Subscribe to daemon events via WebSocket
const ws = new WebSocket(`ws+unix://${socketPath}`);
ws.on('message', (data) => {
  const event = JSON.parse(data);
  updateDisplay(event);
});
```

### 5.3 Coordination Patterns

#### Pattern 1: Coordinator Agent

One agent orchestrates the others:

```
Coordinator
    ├── ->relay:ApiDev Implement /api/users endpoint
    ├── ->relay:DbAdmin Create users table
    └── ->relay:UiDev Build user profile page

ApiDev → Coordinator: Done, endpoint at /api/users
DbAdmin → Coordinator: Table created with schema...
UiDev → Coordinator: Need API spec first

Coordinator → UiDev: Here's the spec: GET /api/users...
```

#### Pattern 2: Pipeline

Agents pass work sequentially:

```
Developer → Reviewer → QA → Deployer

->relay:Reviewer PR #123 ready for review
          ↓
->relay:QA Review passed, ready for testing
          ↓
->relay:Deployer Tests passed, deploy when ready
```

#### Pattern 3: Pub/Sub Topics

Agents subscribe to topics of interest:

```bash
# Agent subscribes to topic
->relay:subscribe security-alerts

# Any agent can publish
->relay:topic:security-alerts Found SQL injection in auth.ts

# All subscribers receive the message
```

**Implementation:**
```typescript
// Subscribe syntax
->relay:+topic-name      # Subscribe
->relay:-topic-name      # Unsubscribe
->relay:#topic-name msg  # Publish to topic

// In parser.ts
const TOPIC_SUBSCRIBE = /^->relay:\+(\S+)$/;
const TOPIC_UNSUBSCRIBE = /^->relay:-(\S+)$/;
const TOPIC_PUBLISH = /^->relay:#(\S+)\s+(.+)$/;
```

### 5.4 Tmux Layout Helper

Quickly set up multi-agent tmux layouts:

```bash
# Create tiled layout with all agents
agent-relay layout tile

# Create layout from teams.json
agent-relay layout teams

# Custom layout
agent-relay layout grid 3x3
```

**Generated tmux layout:**
```
┌─────────────┬─────────────┬─────────────┐
│ Coordinator │   ApiDev    │   DbAdmin   │
├─────────────┼─────────────┼─────────────┤
│ AuthService │    UiDev    │   Stylist   │
├─────────────┼─────────────┼─────────────┤
│  Reviewer   │     QA      │  (empty)    │
└─────────────┴─────────────┴─────────────┘
```

**Implementation:**
```bash
#!/bin/bash
# agent-relay layout tile
AGENTS=$(agent-relay agents --json | jq -r '.[].name')
COUNT=$(echo "$AGENTS" | wc -l)

tmux new-session -d -s relay-overview
for agent in $AGENTS; do
  tmux split-window -t relay-overview
  tmux send-keys -t relay-overview "tmux attach -t relay-$agent-*" Enter
done
tmux select-layout -t relay-overview tiled
tmux attach -t relay-overview
```

### 5.5 Agent Roles & Capabilities

Define what each agent can do:

```json
// teams.json
{
  "agents": {
    "Coordinator": {
      "role": "coordinator",
      "canMessage": ["*"],
      "canReceiveFrom": ["*"]
    },
    "ApiDev": {
      "role": "developer",
      "groups": ["backend"],
      "canMessage": ["Coordinator", "@backend", "Reviewer"],
      "canReceiveFrom": ["Coordinator", "@backend"]
    },
    "Reviewer": {
      "role": "reviewer",
      "canMessage": ["Coordinator", "QA"],
      "canReceiveFrom": ["*"]
    }
  }
}
```

**Use cases:**
- Prevent junior agents from messaging senior ones directly
- Ensure QA only receives from Reviewer (enforced pipeline)
- Coordinator can message anyone

### 5.6 Message Priority & Filtering

With more agents, message prioritization becomes important:

```bash
# Urgent message (interrupts immediately)
->relay:!ApiDev Production is down, check auth service

# Normal message (waits for idle)
->relay:ApiDev When you have time, review this PR

# Low priority (batched, delivered during quiet periods)
->relay:?ApiDev FYI: Updated the style guide
```

**Injection behavior:**
| Priority | Syntax | Behavior |
|----------|--------|----------|
| Urgent | `->relay:!Name` | Inject immediately, even if busy |
| Normal | `->relay:Name` | Wait for idle (current behavior) |
| Low | `->relay:?Name` | Batch and deliver during long idle |

### 5.7 Status Broadcasts

Agents automatically announce state changes:

```typescript
// Automatic status messages
->relay:* STATUS: ApiDev is now idle
->relay:* STATUS: Reviewer completed task (closed PR #123)
->relay:* STATUS: QA disconnected

// Agents can filter these
// In wrapper config:
{
  "hideStatusMessages": true,  // Don't inject STATUS broadcasts
  "showStatusInLogs": true     // But log them for visibility
}
```

---

## Why They Scale Better (And How We Can Too)

### The Scaling Problem

With 2-3 agents, our current approach works well:
- Open 2-3 terminal tabs
- Switch between them manually
- Remember who's doing what

With 5-10 agents, this breaks down:

| Problem | Impact at 5-10 Agents |
|---------|----------------------|
| **No visibility** | Can't see what all agents are doing at once |
| **No status** | Don't know if agent is busy, idle, or stuck |
| **Lost context** | Forget which agent is working on what |
| **Message chaos** | Too many messages to track manually |
| **Terminal sprawl** | 10 tabs is unmanageable |

### Why Their Approach Scales

```
┌─────────────────────────────────────────────────────────────────┐
│ THEIR ARCHITECTURE                                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              BROWSER DASHBOARD                           │    │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐       │    │
│  │  │ Agent 1 │ │ Agent 2 │ │ Agent 3 │ │ Agent 4 │ ...   │    │
│  │  │ ● active│ │ ○ idle  │ │ ● active│ │ ✗ error │       │    │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘       │    │
│  │                                                          │    │
│  │  [Live message feed]  [Inbox: 3 unread]  [Agent graph]  │    │
│  └─────────────────────────────────────────────────────────┘    │
│                           │                                      │
│                    Single pane of glass                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

Key insight: ONE place to see EVERYTHING
```

Their specific advantages at scale:

| Feature | Why It Helps at Scale |
|---------|----------------------|
| **Dashboard** | See all 10 agents at once without switching |
| **Activity state** | Know instantly who's busy vs idle |
| **Message inbox** | Messages don't disappear into terminal history |
| **Agent discovery** | Auto-finds agents, no manual tracking |
| **Persistent storage** | Query historical messages anytime |

### How We Keep Our Strengths AND Scale

The goal: **Single pane of glass, but in the terminal**

```
┌─────────────────────────────────────────────────────────────────┐
│ OUR IMPROVED ARCHITECTURE                                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              TUI DASHBOARD (agent-relay watch)           │    │
│  │                                                          │    │
│  │  Agents:        Status:      Messages:                   │    │
│  │  ● Coordinator  active       12↑ 8↓                     │    │
│  │  ● ApiDev       typing...    5↑ 14↓                     │    │
│  │  ● DbAdmin      idle 30s     3↑ 6↓                      │    │
│  │  ○ QA           offline      queued: 3                   │    │
│  │                                                          │    │
│  │  [Press 'a' to attach, 's' to send, 'q' to quit]        │    │
│  └─────────────────────────────────────────────────────────┘    │
│                           │                                      │
│                           │ 'a' to attach                        │
│                           ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              NATIVE TMUX SESSION                         │    │
│  │                                                          │    │
│  │  claude> Working on the API endpoint...                  │    │
│  │  ->relay:DbAdmin Need the users table schema              │    │
│  │                                                          │    │
│  └─────────────────────────────────────────────────────────┘    │
│                           │                                      │
│                           │ Ctrl+B d to detach                   │
│                           ▼                                      │
│                    Back to TUI dashboard                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

Key insight: TUI for overview, native tmux for work
```

### Specific Scaling Improvements

#### 1. Daemon Event Stream

The daemon must broadcast events, not just route messages:

```typescript
// NEW: Daemon broadcasts events to all listeners
interface DaemonEvent {
  type: 'agent_connected' | 'agent_disconnected' | 'agent_active' |
        'agent_idle' | 'message_sent' | 'message_delivered' | 'message_queued';
  timestamp: number;
  data: Record<string, unknown>;
}

// In daemon/server.ts
class Daemon {
  private eventSubscribers: Set<Connection> = new Set();

  broadcast(event: DaemonEvent): void {
    const envelope = { type: 'EVENT', event };
    for (const subscriber of this.eventSubscribers) {
      subscriber.send(envelope);
    }
  }

  // Called when agent output detected
  onAgentActivity(agentName: string): void {
    this.broadcast({
      type: 'agent_active',
      timestamp: Date.now(),
      data: { agent: agentName }
    });
  }
}
```

#### 2. Activity Reporting from Wrapper

Wrappers must report activity state to daemon:

```typescript
// In tmux-wrapper.ts
private reportActivity(): void {
  const now = Date.now();
  const timeSinceOutput = now - this.lastOutputTime;

  let state: 'active' | 'idle' | 'typing';
  if (timeSinceOutput < 1000) {
    state = 'active';
  } else if (this.detectTypingIndicator()) {
    state = 'typing';  // Agent is thinking/working
  } else if (timeSinceOutput < 30000) {
    state = 'idle';
  } else {
    state = 'idle';
  }

  // Only send if state changed
  if (state !== this.lastReportedState) {
    this.client.sendStatus(state);
    this.lastReportedState = state;
  }
}

private detectTypingIndicator(): boolean {
  // Claude Code shows "[1/418]" when thinking
  // Detect this pattern in recent output
  return /\[\d+\/\d+\]/.test(this.recentOutput);
}
```

#### 3. TUI Dashboard Implementation

```typescript
// src/cli/watch.ts
import blessed from 'blessed';

export async function watchCommand(socketPath: string): Promise<void> {
  const screen = blessed.screen({ smartCSR: true });

  // Agent list panel
  const agentList = blessed.list({
    parent: screen,
    label: ' Agents ',
    top: 0,
    left: 0,
    width: '50%',
    height: '60%',
    border: { type: 'line' },
    style: {
      selected: { bg: 'blue' }
    },
    keys: true,
    vi: true,
  });

  // Message feed panel
  const messageFeed = blessed.log({
    parent: screen,
    label: ' Messages ',
    top: 0,
    right: 0,
    width: '50%',
    height: '60%',
    border: { type: 'line' },
    scrollable: true,
  });

  // Status bar
  const statusBar = blessed.box({
    parent: screen,
    bottom: 0,
    height: 3,
    content: ' [a]ttach  [s]end  [r]efresh  [q]uit ',
  });

  // Connect to daemon event stream
  const client = new RelayClient({ socketPath, subscribe: true });

  client.onEvent = (event: DaemonEvent) => {
    switch (event.type) {
      case 'agent_connected':
        updateAgentList();
        break;
      case 'message_sent':
        messageFeed.log(`${event.data.from} → ${event.data.to}: ${event.data.preview}`);
        break;
      // ...
    }
    screen.render();
  };

  // Keyboard handlers
  screen.key(['a'], () => attachToSelected());
  screen.key(['s'], () => showSendDialog());
  screen.key(['q'], () => process.exit(0));

  screen.render();
}

function attachToSelected(): void {
  const agent = getSelectedAgent();
  // Detach from blessed, attach to tmux
  screen.destroy();
  execSync(`tmux attach-session -t relay-${agent}-*`, { stdio: 'inherit' });
  // When user detaches (Ctrl+B d), restart watch
  watchCommand(socketPath);
}
```

#### 4. Message History Query

```typescript
// src/cli/index.ts
program
  .command('history')
  .description('Show message history')
  .option('-n <count>', 'Number of messages', '20')
  .option('-f, --from <agent>', 'Filter by sender')
  .option('-t, --to <agent>', 'Filter by recipient')
  .option('--since <time>', 'Since time (e.g., "1h", "2024-01-01")')
  .action(async (options) => {
    const messages = await queryMessages({
      limit: parseInt(options.n),
      from: options.from,
      to: options.to,
      since: parseTime(options.since),
    });

    for (const msg of messages) {
      console.log(`${msg.timestamp} ${msg.from} → ${msg.to}: ${msg.body.slice(0, 80)}`);
    }
  });
```

#### 5. Agent Summary Command

```bash
$ agent-relay agents

NAME          STATUS    MESSAGES    LAST ACTIVE
───────────────────────────────────────────────
Coordinator   active    12↑ 8↓      now
ApiDev        typing    5↑ 14↓      now
DbAdmin       idle      3↑ 6↓       30s ago
AuthService   idle      2↑ 4↓       2m ago
QA            offline   queued: 3   5m ago

Total: 5 agents (3 active, 1 idle, 1 offline)
```

Implementation:
```typescript
program
  .command('agents')
  .description('List connected agents with status')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const agents = await getAgentStatus(socketPath);

    if (options.json) {
      console.log(JSON.stringify(agents, null, 2));
      return;
    }

    console.log('NAME          STATUS    MESSAGES    LAST ACTIVE');
    console.log('───────────────────────────────────────────────');

    for (const agent of agents) {
      const status = agent.status.padEnd(9);
      const msgs = `${agent.sent}↑ ${agent.received}↓`.padEnd(11);
      const lastActive = formatRelativeTime(agent.lastActive);
      console.log(`${agent.name.padEnd(13)} ${status} ${msgs} ${lastActive}`);
    }
  });
```

### Scaling Comparison: Before vs After

| Capability | Current | After Improvements |
|------------|---------|-------------------|
| **See all agents** | Switch tabs manually | `agent-relay watch` TUI |
| **Agent status** | None | active/idle/typing/offline |
| **Message history** | Lost in scrollback | `agent-relay history` |
| **Quick attach** | Remember session names | Press 'a' in TUI |
| **Send from CLI** | Must be in session | `agent-relay send Bob "msg"` |
| **Agent list** | `tmux ls \| grep relay` | `agent-relay agents` |

### Architecture Changes for Scale

```
CURRENT (doesn't scale):

  Wrapper 1 ──┐
  Wrapper 2 ──┼──► Daemon ──► SQLite
  Wrapper 3 ──┘
       │
       └──► User switches between terminal tabs


IMPROVED (scales to 10+):

  Wrapper 1 ──┐                    ┌──► TUI Dashboard
  Wrapper 2 ──┼──► Daemon ◄────────┼──► CLI queries
  Wrapper 3 ──┤    │               └──► Health checks
  ...         │    │
  Wrapper 10 ─┘    ▼
                SQLite
                   │
                   └──► Persistent history
                   └──► Agent registry
                   └──► Message queue
```

Key changes:
1. **Daemon becomes event hub** - broadcasts state changes
2. **Wrappers report status** - not just messages
3. **TUI provides overview** - single pane of glass
4. **CLI provides queries** - history, agents, send
5. **Storage is durable** - survives restarts

---

## Non-Goals

- **Browser Dashboard**: Out of scope. TUI (`agent-relay watch`) provides visibility.
- **Multi-host support**: Single machine focus. Use SSH for remote.
- **Agent memory/RAG**: Separate concern. Agents manage their own context.
- **Authentication**: Unix socket permissions are sufficient for local use.

---

## Timeline

| Phase | Scope | Effort |
|-------|-------|--------|
| Phase 1 | Foundation fixes | 2-3 days |
| Phase 2 | Reliability | 2-3 days |
| Phase 3 | DX improvements | 1-2 days |
| Phase 4 | Optional enhancements | As needed |
| Phase 5 | Multi-agent coordination | 3-5 days |

### Phase 5 Breakdown

| Feature | Effort | Priority |
|---------|--------|----------|
| Agent groups (`->relay:@groupname`) | 1 day | P1 |
| TUI dashboard (`agent-relay watch`) | 2 days | P1 |
| Tmux layout helper | 0.5 day | P2 |
| Message priority (`!`, `?`) | 0.5 day | P2 |
| Pub/sub topics | 1 day | P3 |
| Agent roles/permissions | 1 day | P3 |

---

## Open Questions

1. **NDJSON vs Binary**: Is the simplicity worth losing multi-line message support?
   - Mitigation: Encode newlines as `\n` in JSON strings (already done)

2. **Polling interval**: Should 200ms be configurable?
   - Proposal: Add `--poll-interval` flag, default 200ms

3. **Message TTL**: How long to queue messages for offline agents?
   - Proposal: 24 hours default, configurable

4. **Backward compatibility**: How long to support v1 binary protocol?
   - Proposal: One minor version (v2.1 removes it)
