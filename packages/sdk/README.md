# @agent-relay/sdk

Dead simple agent-to-agent communication.

## Install

```bash
npm install @agent-relay/sdk @agent-relay/daemon
```

## Quick Start

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

That's it. No daemon to start, no config files, no setup.

## Even Simpler: Two Agents

```typescript
import { createPair } from '@agent-relay/sdk';

const { alice, bob, stop } = await createPair('alice', 'bob');

bob.onMessage = (from, { body }) => console.log(`${from}: ${body}`);
alice.sendMessage('bob', 'Hey!');

await stop();
```

## Features

| Feature | Description |
|---------|-------------|
| **Zero config** | Just import and go |
| **Auto-reconnect** | Handles disconnections automatically |
| **Message deduplication** | No duplicate deliveries |
| **Sync messaging** | Wait for acknowledgment |
| **Broadcast** | Send to all agents with `*` |
| **Channels** | Group messaging with `#channel` |

## API Reference

### createRelay(config?)

Creates a standalone relay with an in-process daemon.

```typescript
const relay = await createRelay({
  socketPath: '/tmp/my-relay.sock',  // Optional custom socket
  quiet: true,                        // Suppress logs (default: true)
});

// Create clients
const agent = await relay.client('MyAgent');

// Stop everything
await relay.stop();
```

### createPair(name1, name2, config?)

Shortcut to create two connected agents.

```typescript
const { alice, bob, stop } = await createPair('alice', 'bob');
```

### RelayClient

The client for agent communication.

```typescript
// Send messages
client.sendMessage('OtherAgent', 'Hello!');
client.sendMessage('#general', 'Channel message');
client.sendMessage('*', 'Broadcast to everyone');

// Wait for acknowledgment
const ack = await client.sendAndWait('OtherAgent', 'Important message');

// Receive messages
client.onMessage = (from, payload, messageId, meta, originalTo) => {
  console.log(`${from}: ${payload.body}`);

  // Check if broadcast
  if (originalTo === '*') {
    console.log('This was a broadcast');
  }
};

// Connection state changes
client.onStateChange = (state) => {
  // 'DISCONNECTED' | 'CONNECTING' | 'HANDSHAKING' | 'READY' | 'BACKOFF'
};

// Disconnect
client.disconnect();
```

## Using with External Daemon

If you're running `agent-relay up` separately (e.g., for the dashboard), use the client directly:

```typescript
import { RelayClient } from '@agent-relay/sdk';

const client = new RelayClient({
  agentName: 'MyAgent',
  socketPath: '/tmp/agent-relay.sock',
});

await client.connect();
client.sendMessage('OtherAgent', 'Hello!');
```

## Advanced: Channels

```typescript
// Join a channel
client.joinChannel('#general');

// Send to channel
client.sendChannelMessage('#general', 'Hello team!');

// Receive channel messages
client.onChannelMessage = (from, channel, body, envelope) => {
  console.log(`[${channel}] ${from}: ${body}`);
};

// Leave channel
client.leaveChannel('#general');
```

## Advanced: Shadow Agents

Monitor another agent's communication:

```typescript
// Bind as shadow to see all messages to/from PrimaryAgent
client.bindAsShadow('PrimaryAgent', {
  receiveIncoming: true,
  receiveOutgoing: true,
});

// Unbind
client.unbindAsShadow('PrimaryAgent');
```

## License

MIT
