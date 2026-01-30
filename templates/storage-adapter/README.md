# Storage Adapter Template for Agent Relay

Create custom persistence backends for Agent Relay messages and sessions.

## Use Cases

- **PostgreSQL** - Production-grade relational storage
- **Redis** - Fast in-memory with TTL
- **S3/R2** - Archive to object storage
- **MongoDB** - Document-based storage
- **Custom** - Any backend you need

## Quick Start

```bash
cp .env.example .env
# Edit DATABASE_URL

npm install
npm run dev
```

## Storage Interface

Your adapter must implement the `StorageAdapter` interface:

```typescript
interface StorageAdapter {
  // Required
  init(): Promise<void>;
  saveMessage(message: StoredMessage): Promise<void>;
  getMessages(query?: MessageQuery): Promise<StoredMessage[]>;

  // Optional
  close?(): Promise<void>;
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

## Message Structure

```typescript
interface StoredMessage {
  id: string;           // Unique message ID
  ts: number;           // Unix timestamp (ms)
  from: string;         // Sender agent name
  to: string;           // Recipient (* for broadcast)
  body: string;         // Message content
  kind?: 'text' | 'json' | 'binary';
  data?: Record<string, unknown>;  // Structured metadata
  thread?: string;      // Thread ID
  topic?: string;       // Topic/channel
  status?: 'pending' | 'delivered' | 'failed';
}
```

## Query Interface

```typescript
interface MessageQuery {
  limit?: number;       // Max results (default: 100)
  sinceTs?: number;     // Messages after this timestamp
  from?: string;        // Filter by sender
  to?: string;          // Filter by recipient
  topic?: string;       // Filter by topic
  thread?: string;      // Filter by thread
  order?: 'asc' | 'desc';  // Sort order (default: desc)
  unreadOnly?: boolean;
  urgentOnly?: boolean;
}
```

## Usage with Daemon

```typescript
import { Daemon } from 'agent-relay';
import { PostgresStorageAdapter } from './postgres-adapter.js';

const storage = new PostgresStorageAdapter(process.env.DATABASE_URL!);

const daemon = new Daemon({
  socketPath: '/tmp/agent-relay.sock',
  storage,  // Use your custom adapter
});

await daemon.start();
```

## Implementation Tips

### 1. Batch Writes

For high throughput, batch writes:

```typescript
class BatchedAdapter implements StorageAdapter {
  private batch: StoredMessage[] = [];
  private flushTimeout?: NodeJS.Timeout;

  async saveMessage(message: StoredMessage): Promise<void> {
    this.batch.push(message);

    if (this.batch.length >= 100) {
      await this.flush();
    } else if (!this.flushTimeout) {
      this.flushTimeout = setTimeout(() => this.flush(), 100);
    }
  }

  private async flush(): Promise<void> {
    const messages = this.batch;
    this.batch = [];
    clearTimeout(this.flushTimeout);
    this.flushTimeout = undefined;

    await this.db.insertMany(messages);
  }
}
```

### 2. Connection Pooling

Always use connection pools:

```typescript
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  min: 2,
  max: 10,
  idleTimeoutMillis: 30000,
});
```

### 3. Indexes

Create appropriate indexes:

```sql
CREATE INDEX idx_messages_ts ON messages(ts DESC);
CREATE INDEX idx_messages_from ON messages(from_agent);
CREATE INDEX idx_messages_to ON messages(to_agent);
CREATE INDEX idx_messages_thread ON messages(thread) WHERE thread IS NOT NULL;
CREATE INDEX idx_messages_topic ON messages(topic) WHERE topic IS NOT NULL;
```

### 4. TTL/Cleanup

Implement message cleanup:

```typescript
async cleanup(olderThanDays: number): Promise<number> {
  const cutoff = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
  const result = await this.db.query(
    'DELETE FROM messages WHERE ts < $1',
    [cutoff]
  );
  return result.rowCount;
}
```

## Testing

Run the test suite:

```bash
npm test
```

Tests verify:
- Message save/retrieve
- Query filtering
- Session management
- Error handling
