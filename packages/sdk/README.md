# @agent-relay/sdk

**Primitives for building powerful multi-agent swarms.**

Unlike frameworks that impose specific orchestration patterns, Agent Relay provides flexible communication primitives that let you build any swarm architecture. Whether you want hierarchical coordination, parallel fan-out, consensus-based decisions, or self-organizing agents—the SDK gives you the building blocks.

## Why Agent Relay for Swarms?

| Framework | Approach | Limitation |
|-----------|----------|------------|
| OpenAI Agents | Handoff-based routing | Prescriptive flow control |
| Swarms.ai | Pre-built swarm types | Configuration-heavy |
| Strands | Self-organizing swarms | AWS ecosystem lock-in |
| **Agent Relay** | **Communication primitives** | **You design the orchestration** |

### What You Can Build

- **Hierarchical swarms** - Lead + specialist workers with task delegation
- **Parallel execution** - Fan-out to workers, fan-in results
- **Pipeline workflows** - Sequential processing across agents
- **Consensus decisions** - Group voting on critical choices
- **Self-organizing teams** - Dynamic task claiming via channels
- **Supervised agents** - Shadow monitoring for QA and oversight

See [examples/SWARM_PATTERNS.md](./examples/SWARM_PATTERNS.md) for detailed patterns and [examples/SWARM_CAPABILITIES.md](./examples/SWARM_CAPABILITIES.md) for how primitives map to swarm capabilities.

## Install

```bash
npm install @agent-relay/sdk
```

For standalone mode (in-process daemon), also install:

```bash
npm install @agent-relay/daemon
```

## Quick Start

### Standalone Mode (Zero Config)

```typescript
import { createRelay } from '@agent-relay/sdk';

// Start a relay (in-process daemon - no setup required)
const relay = await createRelay();

// Create agents
const alice = await relay.client('Alice');
const bob = await relay.client('Bob');

// Bob listens for messages
bob.onMessage = (from, { body }) => {
  console.log(`${from}: ${body}`);
};

// Alice sends a message
alice.sendMessage('Bob', 'Hello!');

// When done
await relay.stop();
```

### Even Simpler: Two Agents

```typescript
import { createPair } from '@agent-relay/sdk';

const { alice, bob, stop } = await createPair('alice', 'bob');

bob.onMessage = (from, { body }) => console.log(`${from}: ${body}`);
alice.sendMessage('bob', 'Hey!');

await stop();
```

### External Daemon Mode

If you're running `agent-relay up` separately:

```typescript
import { RelayClient } from '@agent-relay/sdk';

const client = new RelayClient({
  agentName: 'MyAgent',
  socketPath: '/tmp/agent-relay.sock', // optional, this is the default
});

await client.connect();
client.sendMessage('OtherAgent', 'Hello!');
```

## Features

| Feature | Description |
|---------|-------------|
| **Zero config** | Just import and go with standalone mode |
| **Auto-reconnect** | Handles disconnections automatically |
| **Message deduplication** | No duplicate deliveries |
| **Sync messaging** | Wait for acknowledgment with `sendAndWait()` |
| **Broadcast** | Send to all agents with `*` |
| **Channels** | Group messaging with `#channel` |
| **Pub/Sub** | Topic-based subscriptions |
| **Agent spawning** | Spawn and release worker agents |
| **Shadow agents** | Monitor another agent's communication |
| **Consensus** | Distributed decision-making (external daemon only) |
| **Monitoring** | Health, metrics, agent discovery |

## API Reference

### Connection

#### connect()

Connect to the relay daemon. Returns a Promise that resolves when the connection is ready.

```typescript
const client = new RelayClient({ agentName: 'MyAgent' });
await client.connect();
// Client is now ready to send/receive messages
```

#### disconnect()

Gracefully disconnect from the daemon. The client can reconnect later.

```typescript
client.disconnect();
```

#### destroy()

Permanently destroy the client. Prevents automatic reconnection.

```typescript
client.destroy();
```

#### Properties

```typescript
client.state;           // 'DISCONNECTED' | 'CONNECTING' | 'HANDSHAKING' | 'READY' | 'BACKOFF'
client.agentName;       // The agent's name
client.currentSessionId; // Current session ID (undefined if not connected)
```

### Core Messaging

#### sendMessage(to, body, kind?, data?, thread?)

Send a message to another agent.

```typescript
// Simple message
client.sendMessage('Bob', 'Hello!');

// With message kind and data
client.sendMessage('Bob', 'Task complete', 'action', { taskId: 123 });

// In a thread
client.sendMessage('Bob', 'Follow-up', 'message', undefined, 'thread-123');
```

#### sendAndWait(to, body, options?)

Send and wait for acknowledgment. Useful for ensuring delivery.

```typescript
const ack = await client.sendAndWait('Bob', 'Important message', {
  timeoutMs: 5000,  // default: 30000
});
console.log('Acknowledged:', ack);
```

#### broadcast(body, kind?, data?)

Send to all connected agents.

```typescript
client.broadcast('System notice to everyone');
```

#### request(to, body, options?)

Send a request and wait for a response from the target agent. This implements a request/response pattern where the target agent can respond with `respond()`.

```typescript
// Simple request
const response = await client.request('Worker', 'Process this task');
console.log(response.body); // Worker's response
console.log(response.from); // 'Worker'

// With options
const response = await client.request('Worker', 'Process task', {
  timeout: 60000,   // default: 30000ms
  data: { taskId: '123', priority: 'high' },
  thread: 'task-thread-1',
  kind: 'action',   // default: 'message'
});
```

**RequestResponse type:**
```typescript
interface RequestResponse {
  from: string;           // sender of the response
  body: string;           // response text
  data?: Record<string, unknown>;
  correlationId: string;
  thread?: string;
  payload: SendPayload;   // full payload for advanced use
}
```

#### respond(correlationId, to, body, data?)

Respond to a request from another agent. Use when you receive a message with a correlation ID.

```typescript
client.onMessage = (from, payload, messageId, meta) => {
  const correlationId = meta?.replyTo || payload.data?._correlationId;
  if (correlationId) {
    // This is a request - send a response
    client.respond(correlationId, from, 'Task completed!', { result: 42 });
  }
};
```

#### sendAck(payload)

Send an ACK for a delivered message. Used internally, but available for custom acknowledgment flows.

```typescript
client.sendAck({
  ack_id: messageId,
  seq: 123,
  correlationId: 'optional-correlation-id',
});
```

#### onMessage

Callback for incoming messages.

```typescript
client.onMessage = (from, payload, messageId, meta, originalTo) => {
  console.log(`${from}: ${payload.body}`);

  // payload.kind: 'message' | 'action' | 'state' | 'thinking'
  // payload.data: optional structured data
  // payload.thread: optional thread ID

  // Check if it was a broadcast
  if (originalTo === '*') {
    console.log('This was a broadcast');
  }
};
```

### Channels

#### joinChannel(channel, displayName?)

```typescript
client.joinChannel('#general');
client.joinChannel('#team', 'Alice (Lead)'); // with display name
```

#### leaveChannel(channel, reason?)

```typescript
client.leaveChannel('#general');
client.leaveChannel('#team', 'Signing off');
```

#### sendChannelMessage(channel, body, options?)

```typescript
// Simple message
client.sendChannelMessage('#general', 'Hello team!');

// With mentions and thread
client.sendChannelMessage('#general', 'Check this out', {
  thread: 'discussion-123',
  mentions: ['Bob', 'Charlie'],
  attachments: [{ type: 'file', name: 'report.pdf', url: '...' }],
});
```

#### onChannelMessage

```typescript
client.onChannelMessage = (from, channel, body, envelope) => {
  console.log(`[${channel}] ${from}: ${body}`);
  // envelope contains full message details (thread, mentions, etc.)
};
```

#### Admin Channel Operations

```typescript
// Add a member to a channel (they don't need to be connected)
client.adminJoinChannel('#team', 'NewMember');

// Remove a member from a channel
client.adminRemoveMember('#team', 'FormerMember');
```

### Pub/Sub

Subscribe to topics for filtered message delivery.

```typescript
// Subscribe to a topic
client.subscribe('builds');
client.subscribe('deployments');

// Messages to that topic will be delivered via onMessage
client.onMessage = (from, payload) => {
  if (payload.data?.topic === 'builds') {
    console.log('Build notification:', payload.body);
  }
};

// Unsubscribe
client.unsubscribe('builds');
```

### Agent Spawning

Spawn and manage worker agents programmatically.

```typescript
// Spawn a new agent
const result = await client.spawn({
  name: 'Worker1',
  cli: 'claude',           // claude, codex, gemini, etc.
  task: 'Process the data files',
  cwd: '/path/to/workdir', // optional
});

if (result.success) {
  console.log('Worker spawned!');
}

// Spawn and wait for the agent to be ready
const result = await client.spawn({
  name: 'Worker2',
  cli: 'claude',
  task: 'Process data',
  waitForReady: true,        // wait for agent to connect
  readyTimeoutMs: 60000,     // timeout for ready (default: 60000)
});

if (result.ready) {
  console.log('Worker is ready:', result.readyInfo);
}

// Release (terminate) an agent
const releaseResult = await client.release('Worker1');
const releaseWithReason = await client.release('Worker2', 'Task complete');
```

#### waitForAgentReady(name, timeoutMs?)

Wait for an agent to become ready (complete HELLO/WELCOME handshake). Useful when waiting for an agent spawned through another mechanism.

```typescript
try {
  const readyInfo = await client.waitForAgentReady('Worker', 30000);
  console.log(`Worker is ready, using ${readyInfo.cli}`);
} catch (err) {
  console.error('Worker did not become ready in time');
}
```

#### onAgentReady

Callback when any agent becomes ready (completes connection handshake).

```typescript
client.onAgentReady = (info) => {
  console.log(`Agent ${info.name} is now ready (cli: ${info.cli})`);
};
```

#### Spawn as Shadow

```typescript
// Spawn an agent that shadows another
await client.spawn({
  name: 'Reviewer',
  cli: 'claude',
  task: 'Review code changes',
  shadowOf: 'Developer',
  shadowSpeakOn: ['error', 'complete'],
});
```

### Shadow Agents

Monitor another agent's communication without them knowing.

```typescript
// Bind as shadow to see all messages to/from PrimaryAgent
client.bindAsShadow('PrimaryAgent', {
  receiveIncoming: true,  // see messages sent TO the primary
  receiveOutgoing: true,  // see messages sent BY the primary
  speakOn: ['error'],     // triggers that allow shadow to speak
});

// Unbind
client.unbindAsShadow('PrimaryAgent');
```

### Logging

Stream logs to the daemon (for dashboard display).

```typescript
// Send log output
client.sendLog('Starting task...');
client.sendLog('Processing file 1 of 10');
client.sendLog('Error: File not found');
```

### Consensus (External Daemon Only)

Distributed decision-making across agents. **Note:** Consensus requires an external daemon - it's disabled in standalone mode.

#### Consensus Types

| Type | Description |
|------|-------------|
| `majority` | >50% agreement (default) |
| `supermajority` | >=2/3 agreement (configurable) |
| `unanimous` | 100% agreement required |
| `weighted` | Votes weighted by role/expertise |
| `quorum` | Minimum participation + majority |

#### Create a Proposal

```typescript
client.createProposal({
  title: 'Approve API design',
  description: 'Should we proceed with the REST API design?',
  participants: ['Developer', 'Reviewer', 'Lead'],
  consensusType: 'majority',
  timeoutMs: 300000, // 5 minutes, optional
  threshold: 0.67,   // for supermajority, optional
  quorum: 2,         // minimum votes, optional
});
```

#### Vote on a Proposal

```typescript
client.vote({
  proposalId: 'prop_123_abc',
  value: 'approve', // or 'reject', 'abstain'
  reason: 'Looks good to me', // optional
});
```

#### Receiving Proposals and Results

```typescript
client.onMessage = (from, payload) => {
  if (payload.data?._isConsensusMessage) {
    console.log('Consensus message:', payload.body);
  }
};
```

### Monitoring & Discovery

#### List Online Agents

```typescript
const agents = await client.listAgents();
for (const agent of agents) {
  console.log(`${agent.name} (${agent.cli}) - ${agent.idle ? 'idle' : 'active'}`);
}

// Filter options
const activeOnly = await client.listAgents({ includeIdle: false });
const projectAgents = await client.listAgents({ project: 'myproject' });
```

#### Get System Health

```typescript
const health = await client.getHealth();
console.log(`Health score: ${health.healthScore}/100`);
console.log(`Issues: ${health.issues.length}`);
console.log(`Recommendations:`, health.recommendations);

// Options
const health = await client.getHealth({
  includeCrashes: true,  // include crash history
  includeAlerts: true,   // include alerts
});
```

#### Get Resource Metrics

```typescript
const metrics = await client.getMetrics();

// System overview
console.log(`Heap used: ${metrics.system.heapUsed}`);
console.log(`Free memory: ${metrics.system.freeMemory}`);

// Per-agent metrics
for (const agent of metrics.agents) {
  console.log(`${agent.name}: ${agent.rssBytes} bytes, ${agent.cpuPercent}% CPU`);
}

// Filter to specific agent
const workerMetrics = await client.getMetrics({ agent: 'Worker1' });
```

#### Get Daemon Status

```typescript
const status = await client.getStatus();
console.log(`Version: ${status.version}`);
console.log(`Uptime: ${status.uptime}ms`);
console.log(`Agents: ${status.agentCount}`);
```

#### Get Inbox Messages

```typescript
const messages = await client.getInbox({ limit: 10 });
for (const msg of messages) {
  console.log(`From ${msg.from}: ${msg.body}`);
}

// Filter options
const unread = await client.getInbox({ unreadOnly: true });
const fromAlice = await client.getInbox({ from: 'Alice' });
const channelMsgs = await client.getInbox({ channel: '#general' });
```

#### Query All Messages

Query all messages (not filtered by recipient). Useful for dashboards or analytics.

```typescript
const messages = await client.queryMessages({
  limit: 100,           // default: 100
  sinceTs: Date.now() - 3600000, // last hour
  from: 'Alice',        // filter by sender
  to: 'Bob',            // filter by recipient
  thread: 'thread-123', // filter by thread
  order: 'desc',        // 'asc' or 'desc' (default: 'desc')
});

for (const msg of messages) {
  console.log(`${msg.from} -> ${msg.to}: ${msg.body}`);
}
```

#### List Connected Agents Only

Unlike `listAgents()` which includes historical/registered agents, this only returns agents currently connected.

```typescript
const connected = await client.listConnectedAgents();
for (const agent of connected) {
  console.log(`${agent.name} is connected right now`);
}

// Filter by project
const projectAgents = await client.listConnectedAgents({ project: 'myproject' });
```

#### Remove Agent

Remove a stale agent from the registry (sessions, agents.json). Use to clean up agents no longer needed.

```typescript
const result = await client.removeAgent('OldWorker');
if (result.success) {
  console.log('Agent removed');
}

// Also remove all messages from/to this agent
await client.removeAgent('OldWorker', { removeMessages: true });
```

#### Read Agent Logs (File-based)

Logs are stored locally and can be read without a connection:

```typescript
import { getLogs, listLoggedAgents } from '@agent-relay/sdk';

// List agents with logs
const agents = await listLoggedAgents();

// Get last 100 lines of a specific agent's logs
const result = await getLogs('Worker1', { lines: 100 });
if (result.found) {
  console.log(result.content);
}
```

### Connection Management

#### State Changes

```typescript
client.onStateChange = (state) => {
  // 'DISCONNECTED' | 'CONNECTING' | 'HANDSHAKING' | 'READY' | 'BACKOFF'
  console.log('State:', state);
};
```

#### Error Handling

```typescript
client.onError = (error) => {
  console.error('Client error:', error.message);
};
```

#### Manual Connection Control

```typescript
// Disconnect gracefully
client.disconnect();

// Permanently destroy (prevents reconnection)
client.destroy();

// Check current state
console.log(client.state); // 'READY', 'DISCONNECTED', etc.
console.log(client.agentName);
console.log(client.currentSessionId);
```

## Standalone vs External Daemon

| Feature | Standalone | External Daemon |
|---------|------------|-----------------|
| Setup required | None | Run `agent-relay up` |
| Consensus | No | Yes |
| Cloud sync | No | Yes |
| Dashboard | No | Yes |
| Best for | Testing, simple scripts | Production, multi-machine |

## Configuration Reference

### RelayClient Options

```typescript
const client = new RelayClient({
  // Required
  agentName: 'MyAgent',

  // Optional
  socketPath: '/tmp/agent-relay.sock',  // default
  entityType: 'agent',    // 'agent' or 'user'
  cli: 'claude',          // CLI identifier
  program: 'my-app',      // program identifier
  model: 'claude-3',      // model identifier
  task: 'My task',        // task description
  workingDirectory: '/path/to/work',
  displayName: 'Alice',   // for human users
  avatarUrl: 'https://...',
  quiet: false,           // suppress console logs
  reconnect: true,        // auto-reconnect
  maxReconnectAttempts: 10,
  reconnectDelayMs: 1000,
  reconnectMaxDelayMs: 30000,
});
```

### createRelay Options

```typescript
const relay = await createRelay({
  socketPath: '/tmp/my-relay.sock',  // optional
  quiet: true,                        // suppress logs (default: true)
});
```

## TypeScript Types

All types are exported for TypeScript users:

```typescript
import type {
  // Client
  ClientState,
  ClientConfig,
  SyncOptions,
  RequestOptions,
  RequestResponse,

  // Messages
  SendPayload,
  SendMeta,
  PayloadKind,
  AckPayload,

  // Channels
  ChannelMessagePayload,
  MessageAttachment,

  // Spawning
  SpawnPayload,
  SpawnResult,
  SpawnResultPayload,
  ReleaseResultPayload,
  AgentReadyPayload,

  // Monitoring
  AgentInfo,
  AgentMetrics,
  HealthResponsePayload,
  MetricsResponsePayload,
  StatusResponsePayload,
  InboxMessage,
  MessagesResponsePayload,
  RemoveAgentResponsePayload,

  // Consensus
  ConsensusType,
  VoteValue,
  CreateProposalOptions,
  VoteOptions,
} from '@agent-relay/sdk';
```

## Building Swarms

The SDK provides primitives that map directly to swarm capabilities:

| SDK Primitive | Swarm Capability |
|---------------|------------------|
| `sendMessage()` | **Handoffs** - Transfer tasks between agents |
| `sendAndWait()` | **Synchronous handoffs** - Wait for task completion |
| `getInbox()` + session resume | **Continuity** - Recover state across disconnections |
| `createProposal()` / `vote()` | **Consensus** - Group decision-making |
| `channels` + state payloads | **Shared memory** - Distributed state |
| `listAgents()` | **Discovery** - Find available workers |
| `getMetrics()` / `getHealth()` | **Monitoring** - Auto-scaling decisions |
| `bindAsShadow()` | **Observation** - QA and oversight |
| `spawn()` / `release()` | **Dynamic teams** - Scale workers on demand |

### Example: Hierarchical Swarm

```typescript
const lead = new RelayClient({ agentName: 'Lead' });
await lead.connect();

// Spawn specialized workers
for (const role of ['Frontend', 'Backend', 'Tests']) {
  await lead.spawn({
    name: `${role}Worker`,
    cli: 'claude',
    task: `You are a ${role} specialist. Wait for tasks from Lead.`,
  });
}

// Delegate work
lead.sendMessage('FrontendWorker', 'Build the login page UI');
lead.sendMessage('BackendWorker', 'Create the /auth API endpoint');
lead.sendMessage('TestsWorker', 'Write integration tests for auth');

// Collect results
const results = new Map();
lead.onMessage = (from, { body }) => {
  results.set(from, body);
  if (results.size === 3) console.log('All workers complete!');
};
```

### Example: Consensus Decision

```typescript
// Create a proposal for group decision
client.createProposal({
  title: 'API Design Choice',
  description: 'Should we use GraphQL or REST?',
  participants: ['Architect', 'FrontendLead', 'BackendLead'],
  consensusType: 'majority',
  timeoutMs: 300000,
});

// Participants vote
client.vote({
  proposalId: 'prop_123',
  value: 'approve',
  reason: 'GraphQL fits our needs better',
});
```

### Learn More

- **[Swarm Patterns](./examples/SWARM_PATTERNS.md)** - 8 detailed patterns with code
- **[Swarm Capabilities](./examples/SWARM_CAPABILITIES.md)** - How primitives enable swarm features
- **[AgentSwarm](https://github.com/AgentWorkforce/agentswarm)** - Production orchestrator built on Agent Relay

## License

MIT
