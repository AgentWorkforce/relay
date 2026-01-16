# Building on Agent Relay

This guide explains how to build applications, integrations, and extensions on top of the Agent Relay protocol.

---

## Overview

Agent Relay is designed as a **platform**, not just a tool. The dashboard is one implementation built on the AR protocol—you can build your own.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        AR Protocol (v1)                             │
│  • 18+ message types • Length-prefixed JSON • Session resume        │
└─────────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│   Dashboard   │    │  Slack Bot    │    │  Your App     │
│   (built-in)  │    │  (example)    │    │   (???)       │
└───────────────┘    └───────────────┘    └───────────────┘
```

---

## Quick Start

### Connect as a Client (5 minutes)

The fastest way to build on AR is to connect as a client:

```typescript
import { RelayClient, getProjectPaths } from 'agent-relay';

const paths = getProjectPaths();
const client = new RelayClient({
  name: 'MyBot',
  socketPath: paths.socketPath,
});

// Receive messages
client.on('message', (msg) => {
  console.log(`${msg.from}: ${msg.body}`);
});

await client.connect();

// Send messages
await client.send({ to: 'Alice', body: 'Hello!' });
await client.broadcast('Hello everyone!');
```

That's it. Your bot is now part of the agent network.

---

## Architecture

### Protocol Layers

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 5: Applications                                       │
│  Dashboard, Slack bots, custom UIs, workflow engines        │
├─────────────────────────────────────────────────────────────┤
│  Layer 4: Extensions                                         │
│  Storage adapters, memory adapters, policy engines          │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Client Library (RelayClient)                       │
│  Connection management, message handling, reconnection      │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Daemon (Router + Registry + Storage)               │
│  Message routing, agent discovery, persistence              │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: Protocol                                           │
│  Message types, wire format, framing, versioning            │
└─────────────────────────────────────────────────────────────┘
```

### Extension Points

| Extension Point | What You Can Build |
|-----------------|-------------------|
| **Client** | Bots, bridges, custom UIs |
| **Storage Adapter** | Custom persistence (Postgres, Redis, S3) |
| **Memory Adapter** | Vector search, knowledge graphs, RAG |
| **Policy Engine** | Access control, rate limiting, compliance |
| **Bridge** | External system integration (Slack, Discord, etc.) |

---

## Building Clients

### Client Configuration

```typescript
interface ClientConfig {
  // Required
  name: string;              // Agent name (must be unique)
  socketPath: string;        // Path to daemon socket

  // Optional identity
  entityType?: 'agent' | 'user';  // AI agent or human user
  cli?: string;              // 'claude', 'codex', 'gemini', 'custom-bot'
  program?: string;          // Model identifier
  model?: string;            // Specific model version
  task?: string;             // Current task description
  workingDirectory?: string; // For context

  // Optional for human users
  displayName?: string;      // Human-readable name
  avatarUrl?: string;        // Avatar URL

  // Connection options
  reconnect?: boolean;       // Auto-reconnect (default: true)
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
}
```

### Message Types

```typescript
// Send to specific agent
await client.send({
  to: 'Alice',
  body: 'Hello Alice!',
  data: { custom: 'metadata' },  // Optional structured data
  thread: 'thread-123',          // Optional thread ID
});

// Broadcast to all agents
await client.broadcast('Announcement!');

// Subscribe to topics
await client.subscribe('deployments');
await client.subscribe('code-reviews');

// Message with kind (for structured data)
await client.send({
  to: 'DataProcessor',
  body: JSON.stringify({ action: 'process', file: 'data.csv' }),
  kind: 'json',  // 'text' | 'json' | 'binary'
});
```

### Event Handling

```typescript
// Message received
client.on('message', (msg) => {
  console.log(`From: ${msg.from}`);
  console.log(`Body: ${msg.body}`);
  console.log(`Data: ${JSON.stringify(msg.data)}`);
  console.log(`Thread: ${msg.thread}`);
});

// Connection state changes
client.on('connected', () => console.log('Connected!'));
client.on('disconnected', () => console.log('Disconnected'));
client.on('reconnecting', (attempt) => console.log(`Reconnecting... ${attempt}`));
client.on('error', (err) => console.error('Error:', err));

// Topic messages (after subscribing)
client.on('topic:deployments', (msg) => {
  console.log(`Deployment update: ${msg.body}`);
});
```

### Client State

```typescript
type ClientState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'HANDSHAKING'
  | 'READY'
  | 'BACKOFF';

// Check current state
console.log(client.state);  // 'READY'

// Wait for ready state
await client.waitForReady();
```

---

## Building Bridges

Bridges connect AR to external systems (Slack, Discord, webhooks, etc.).

### Bridge Pattern

```typescript
import { RelayClient, getProjectPaths } from 'agent-relay';
import { WebClient } from '@slack/web-api';

class SlackBridge {
  private relay: RelayClient;
  private slack: WebClient;

  constructor(slackToken: string) {
    const paths = getProjectPaths();

    this.relay = new RelayClient({
      name: 'SlackBridge',
      socketPath: paths.socketPath,
      entityType: 'agent',
      cli: 'slack-bridge',
    });

    this.slack = new WebClient(slackToken);
  }

  async start() {
    // Relay → Slack
    this.relay.on('message', async (msg) => {
      // Skip our own messages
      if (msg.from === 'SlackBridge') return;

      // Check if message should go to Slack
      const channel = msg.data?.slackChannel || '#agents';

      await this.slack.chat.postMessage({
        channel,
        text: `*${msg.from}*: ${msg.body}`,
      });
    });

    await this.relay.connect();
  }

  // Called by Slack event handler
  async onSlackMessage(channel: string, text: string, user: string) {
    await this.relay.broadcast(text, {
      source: 'slack',
      channel,
      user,
    });
  }
}
```

### Webhook Bridge

```typescript
import express from 'express';
import { RelayClient, getProjectPaths } from 'agent-relay';

const app = express();
app.use(express.json());

const paths = getProjectPaths();
const relay = new RelayClient({
  name: 'WebhookBridge',
  socketPath: paths.socketPath,
});

// Receive webhooks → broadcast to agents
app.post('/webhook', async (req, res) => {
  await relay.broadcast(JSON.stringify(req.body), {
    source: 'webhook',
    headers: req.headers,
  });
  res.json({ ok: true });
});

// Forward agent messages → outgoing webhooks
relay.on('message', async (msg) => {
  if (msg.data?.webhookUrl) {
    await fetch(msg.data.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: msg.from,
        body: msg.body,
        data: msg.data,
      }),
    });
  }
});

await relay.connect();
app.listen(3000);
```

---

## Building Storage Adapters

Implement custom persistence for messages and sessions.

### Storage Interface

```typescript
import type { StorageAdapter, StoredMessage, MessageQuery } from 'agent-relay';

export interface StorageAdapter {
  // Lifecycle
  init(): Promise<void>;
  close?(): Promise<void>;

  // Messages
  saveMessage(message: StoredMessage): Promise<void>;
  getMessages(query?: MessageQuery): Promise<StoredMessage[]>;
  getMessageById?(id: string): Promise<StoredMessage | null>;
  updateMessageStatus?(id: string, status: MessageStatus): Promise<void>;

  // Sessions (optional)
  startSession?(session: StoredSession): Promise<void>;
  endSession?(sessionId: string, options?: EndSessionOptions): Promise<void>;
  getSessions?(query?: SessionQuery): Promise<StoredSession[]>;
  getSessionByResumeToken?(token: string): Promise<StoredSession | null>;

  // Agent summaries (optional)
  saveAgentSummary?(summary: AgentSummary): Promise<void>;
  getAgentSummary?(agentName: string): Promise<AgentSummary | null>;
}
```

### Example: Postgres Adapter

```typescript
import { Pool } from 'pg';
import type { StorageAdapter, StoredMessage, MessageQuery } from 'agent-relay';

export class PostgresStorageAdapter implements StorageAdapter {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        ts BIGINT NOT NULL,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        body TEXT NOT NULL,
        kind TEXT DEFAULT 'text',
        data JSONB,
        thread TEXT,
        topic TEXT,
        status TEXT DEFAULT 'delivered',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
      CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_agent);
      CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent);
    `);
  }

  async saveMessage(message: StoredMessage): Promise<void> {
    await this.pool.query(
      `INSERT INTO messages (id, ts, from_agent, to_agent, body, kind, data, thread, topic, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        message.id,
        message.ts,
        message.from,
        message.to,
        message.body,
        message.kind || 'text',
        JSON.stringify(message.data || {}),
        message.thread,
        message.topic,
        message.status || 'delivered',
      ]
    );
  }

  async getMessages(query?: MessageQuery): Promise<StoredMessage[]> {
    let sql = 'SELECT * FROM messages WHERE 1=1';
    const params: unknown[] = [];
    let paramIndex = 1;

    if (query?.from) {
      sql += ` AND from_agent = $${paramIndex++}`;
      params.push(query.from);
    }
    if (query?.to) {
      sql += ` AND to_agent = $${paramIndex++}`;
      params.push(query.to);
    }
    if (query?.sinceTs) {
      sql += ` AND ts >= $${paramIndex++}`;
      params.push(query.sinceTs);
    }
    if (query?.topic) {
      sql += ` AND topic = $${paramIndex++}`;
      params.push(query.topic);
    }
    if (query?.thread) {
      sql += ` AND thread = $${paramIndex++}`;
      params.push(query.thread);
    }

    sql += ` ORDER BY ts ${query?.order === 'asc' ? 'ASC' : 'DESC'}`;

    if (query?.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(query.limit);
    }

    const result = await this.pool.query(sql, params);
    return result.rows.map(row => ({
      id: row.id,
      ts: Number(row.ts),
      from: row.from_agent,
      to: row.to_agent,
      body: row.body,
      kind: row.kind,
      data: row.data,
      thread: row.thread,
      topic: row.topic,
      status: row.status,
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// Usage with daemon
import { Daemon } from 'agent-relay';

const daemon = new Daemon({
  socketPath: '/tmp/agent-relay.sock',
  storage: new PostgresStorageAdapter(process.env.DATABASE_URL!),
});

await daemon.start();
```

### Example: Redis Adapter (Recent Messages Only)

```typescript
import Redis from 'ioredis';
import type { StorageAdapter, StoredMessage, MessageQuery } from 'agent-relay';

export class RedisStorageAdapter implements StorageAdapter {
  private redis: Redis;
  private maxMessages = 10000;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
  }

  async init(): Promise<void> {
    // Redis is ready
  }

  async saveMessage(message: StoredMessage): Promise<void> {
    const key = `messages:${message.id}`;
    const listKey = 'messages:list';

    await this.redis.pipeline()
      .hset(key, message)
      .zadd(listKey, message.ts, message.id)
      .zremrangebyrank(listKey, 0, -this.maxMessages - 1)
      .expire(key, 86400 * 7)  // 7 days TTL
      .exec();
  }

  async getMessages(query?: MessageQuery): Promise<StoredMessage[]> {
    const listKey = 'messages:list';
    const limit = query?.limit || 100;

    // Get message IDs by timestamp
    const ids = query?.order === 'asc'
      ? await this.redis.zrange(listKey, 0, limit - 1)
      : await this.redis.zrevrange(listKey, 0, limit - 1);

    // Fetch messages
    const messages: StoredMessage[] = [];
    for (const id of ids) {
      const msg = await this.redis.hgetall(`messages:${id}`);
      if (msg.id) messages.push(msg as unknown as StoredMessage);
    }

    return messages;
  }
}
```

---

## Building Memory Adapters

Provide custom memory/context for agents.

### Memory Interface

```typescript
import type { MemoryAdapter, MemoryEntry, MemorySearchQuery, MemoryResult } from 'agent-relay';

export interface MemoryAdapter {
  add(entry: MemoryEntry): Promise<void>;
  search(query: MemorySearchQuery): Promise<MemoryResult[]>;
  delete(id: string): Promise<void>;
  list(): Promise<MemoryEntry[]>;
}

interface MemoryEntry {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  embedding?: number[];
  createdAt?: number;
}

interface MemorySearchQuery {
  text: string;
  limit?: number;
  filter?: Record<string, unknown>;
}
```

### Example: Pinecone Adapter

```typescript
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import type { MemoryAdapter, MemoryEntry, MemorySearchQuery, MemoryResult } from 'agent-relay';

export class PineconeMemoryAdapter implements MemoryAdapter {
  private pinecone: Pinecone;
  private openai: OpenAI;
  private indexName: string;

  constructor(apiKey: string, indexName: string, openaiKey: string) {
    this.pinecone = new Pinecone({ apiKey });
    this.openai = new OpenAI({ apiKey: openaiKey });
    this.indexName = indexName;
  }

  private async embed(text: string): Promise<number[]> {
    const response = await this.openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });
    return response.data[0].embedding;
  }

  async add(entry: MemoryEntry): Promise<void> {
    const index = this.pinecone.index(this.indexName);
    const embedding = entry.embedding || await this.embed(entry.content);

    await index.upsert([{
      id: entry.id,
      values: embedding,
      metadata: {
        content: entry.content,
        ...entry.metadata,
      },
    }]);
  }

  async search(query: MemorySearchQuery): Promise<MemoryResult[]> {
    const index = this.pinecone.index(this.indexName);
    const embedding = await this.embed(query.text);

    const results = await index.query({
      vector: embedding,
      topK: query.limit || 10,
      includeMetadata: true,
      filter: query.filter,
    });

    return results.matches.map(match => ({
      id: match.id,
      content: match.metadata?.content as string,
      score: match.score || 0,
      metadata: match.metadata,
    }));
  }

  async delete(id: string): Promise<void> {
    const index = this.pinecone.index(this.indexName);
    await index.deleteOne(id);
  }

  async list(): Promise<MemoryEntry[]> {
    // Pinecone doesn't support listing all vectors easily
    // Return empty or implement pagination
    return [];
  }
}
```

---

## Building Policy Engines

Control who can send messages to whom.

### Policy Interface

```typescript
interface AgentPolicy {
  version: 1;
  agents: {
    [agentName: string]: {
      canSendTo?: string[];       // Allowed recipients (* = all)
      canReceiveFrom?: string[];  // Allowed senders (* = all)
      maxMessagesPerMin?: number; // Rate limit
      allowBroadcast?: boolean;   // Can send to *
      topics?: string[];          // Allowed topics
    };
  };
  defaults?: {
    canSendTo?: string[];
    canReceiveFrom?: string[];
    maxMessagesPerMin?: number;
    allowBroadcast?: boolean;
  };
}
```

### Example: Policy Enforcement

```typescript
import type { AgentPolicy } from 'agent-relay';

class PolicyEnforcer {
  private policy: AgentPolicy;
  private messageCounts: Map<string, { count: number; resetAt: number }> = new Map();

  constructor(policy: AgentPolicy) {
    this.policy = policy;
  }

  canSend(from: string, to: string): { allowed: boolean; reason?: string } {
    const agentPolicy = this.policy.agents[from] || this.policy.defaults;

    if (!agentPolicy) {
      return { allowed: true };  // No policy = allow
    }

    // Check rate limit
    if (agentPolicy.maxMessagesPerMin) {
      const now = Date.now();
      const counter = this.messageCounts.get(from);

      if (counter && counter.resetAt > now && counter.count >= agentPolicy.maxMessagesPerMin) {
        return { allowed: false, reason: 'Rate limit exceeded' };
      }
    }

    // Check broadcast permission
    if (to === '*' && agentPolicy.allowBroadcast === false) {
      return { allowed: false, reason: 'Broadcast not allowed' };
    }

    // Check canSendTo
    if (agentPolicy.canSendTo && !agentPolicy.canSendTo.includes('*')) {
      if (!agentPolicy.canSendTo.includes(to)) {
        return { allowed: false, reason: `Cannot send to ${to}` };
      }
    }

    return { allowed: true };
  }

  recordMessage(from: string): void {
    const now = Date.now();
    const counter = this.messageCounts.get(from);

    if (!counter || counter.resetAt <= now) {
      this.messageCounts.set(from, { count: 1, resetAt: now + 60000 });
    } else {
      counter.count++;
    }
  }
}

// Usage
const policy: AgentPolicy = {
  version: 1,
  agents: {
    'PublicBot': {
      canSendTo: ['*'],
      canReceiveFrom: ['Lead', 'Admin'],
      maxMessagesPerMin: 30,
      allowBroadcast: true,
    },
    'SecretAgent': {
      canSendTo: ['SecretAgent2', 'Lead'],
      canReceiveFrom: ['SecretAgent2', 'Lead'],
      allowBroadcast: false,
    },
  },
  defaults: {
    maxMessagesPerMin: 100,
    allowBroadcast: true,
  },
};

const enforcer = new PolicyEnforcer(policy);

// In your message handler
if (!enforcer.canSend(from, to).allowed) {
  throw new Error('Policy violation');
}
```

---

## REST API Integration

For non-Node.js environments or serverless functions.

### Endpoints

```
# Query messages
GET /api/messages?from=Alice&to=Bob&sinceTs=1234567890&limit=50

# Send message
POST /api/messages/send
{
  "to": "Bob",
  "body": "Hello!",
  "from": "ExternalService"
}

# List agents
GET /api/agents

# Agent details
GET /api/agents/:name

# Health check
GET /api/health
```

### Example: Python Client

```python
import requests

class AgentRelayClient:
    def __init__(self, base_url: str, api_key: str = None):
        self.base_url = base_url
        self.headers = {'Authorization': f'Bearer {api_key}'} if api_key else {}

    def send(self, to: str, body: str, data: dict = None):
        response = requests.post(
            f'{self.base_url}/api/messages/send',
            json={'to': to, 'body': body, 'data': data or {}},
            headers=self.headers
        )
        return response.json()

    def get_messages(self, **query):
        response = requests.get(
            f'{self.base_url}/api/messages',
            params=query,
            headers=self.headers
        )
        return response.json()

    def list_agents(self):
        response = requests.get(
            f'{self.base_url}/api/agents',
            headers=self.headers
        )
        return response.json()

# Usage
client = AgentRelayClient('http://localhost:4000')
client.send('Alice', 'Hello from Python!')
messages = client.get_messages(from_agent='Alice', limit=10)
```

---

## WebSocket Integration

For real-time updates in web applications.

### WebSocket API

```javascript
const ws = new WebSocket('ws://localhost:4000/api/ws');

ws.onopen = () => {
  // Subscribe to updates
  ws.send(JSON.stringify({
    type: 'subscribe',
    topics: ['messages', 'agents', 'sessions'],
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);

  switch (data.type) {
    case 'message':
      console.log(`${data.from}: ${data.body}`);
      break;
    case 'agent:connected':
      console.log(`${data.agent} came online`);
      break;
    case 'agent:disconnected':
      console.log(`${data.agent} went offline`);
      break;
  }
};

// Send a message
ws.send(JSON.stringify({
  type: 'send',
  to: 'Alice',
  body: 'Hello from browser!',
}));
```

---

## Running Your Own Daemon

For custom deployments or embedded use.

```typescript
import { Daemon, createStorageAdapter } from 'agent-relay';

const daemon = new Daemon({
  // Socket configuration
  socketPath: '/tmp/my-relay.sock',

  // Storage
  storage: createStorageAdapter({
    type: 'sqlite',
    path: './data/messages.db',
  }),

  // Optional: custom storage adapter
  // storage: new MyPostgresAdapter(process.env.DATABASE_URL),

  // Dashboard
  dashboard: {
    enabled: true,
    port: 4000,
  },

  // Logging
  logLevel: 'info',
});

await daemon.start();

// Access internal APIs
const registry = daemon.getRegistry();
const router = daemon.getRouter();
const storage = daemon.getStorage();

// List connected agents
const agents = registry.list();
console.log('Connected agents:', agents.map(a => a.name));

// Query messages directly
const messages = await storage.getMessages({ limit: 10 });

// Graceful shutdown
process.on('SIGINT', async () => {
  await daemon.stop();
  process.exit(0);
});
```

---

## Best Practices

### 1. Use Unique Agent Names

Agent names must be unique within a daemon. Use prefixes for different types:

```typescript
// Good
{ name: 'slack-bridge-prod' }
{ name: 'github-webhook-handler' }
{ name: 'monitoring-bot-1' }

// Bad - too generic
{ name: 'bot' }
{ name: 'handler' }
```

### 2. Handle Reconnection

Always handle disconnection gracefully:

```typescript
client.on('disconnected', () => {
  console.log('Disconnected, reconnecting...');
});

client.on('reconnecting', (attempt) => {
  if (attempt > 5) {
    console.error('Too many reconnection attempts');
    process.exit(1);
  }
});
```

### 3. Use Threads for Context

Group related messages with threads:

```typescript
const threadId = `issue-${issueNumber}`;

await client.send({
  to: 'Reviewer',
  body: 'Please review this change',
  thread: threadId,
});
```

### 4. Include Metadata

Use the `data` field for structured information:

```typescript
await client.send({
  to: 'DeployBot',
  body: 'Deploy to staging',
  data: {
    environment: 'staging',
    commit: 'abc123',
    triggeredBy: 'github-webhook',
  },
});
```

### 5. Respect Rate Limits

If you receive a `BUSY` signal, back off:

```typescript
client.on('busy', async () => {
  console.log('Server busy, backing off...');
  await sleep(1000);
});
```

---

## Next Steps

- See [examples/](../examples/) for working code
- Read [PROTOCOL.md](./PROTOCOL.md) for wire format details
- Check [templates/](../templates/) for starter projects
- Explore the [Plugin Registry](./PLUGIN_REGISTRY.md) for extensions
