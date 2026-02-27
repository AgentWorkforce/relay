# Codex WebSocket Integration Spec

## Overview

Replace CLI-based Codex spawning with direct WebSocket connection to Codex's app-server JSON-RPC 2.0 API. This eliminates stdin injection and provides richer event streaming.

## Current vs Proposed

### Current (CLI Spawning)
```
agent-relay → spawn CLI process → inject stdin → parse stdout
```
- Limited control over agent lifecycle
- Text-based message injection
- No structured events
- Process management overhead

### Proposed (WebSocket)
```
agent-relay → WebSocket connection → JSON-RPC 2.0 → structured events
```
- Direct bidirectional communication
- Full lifecycle control (start, steer, interrupt)
- Structured event streaming
- No process spawning

## Protocol Flow

### 1. Connection Setup

When spawning a Codex agent, agent-relay:

```javascript
// Start codex app-server (one per project or shared)
spawn('codex', ['app-server', '--listen', 'ws://127.0.0.1:4500']);

// Connect via WebSocket
const ws = new WebSocket('ws://127.0.0.1:4500');
```

### 2. Initialization Handshake

```javascript
// After connection opens
ws.send(JSON.stringify({
  method: 'initialize',
  id: 0,
  params: {
    clientInfo: {
      name: 'agent-relay',
      title: 'Agent Relay',
      version: '1.0.0'
    }
  }
}));

// Then send initialized notification
ws.send(JSON.stringify({
  method: 'initialized',
  params: {}
}));
```

### 3. Thread Creation (Per Agent)

Each spawned Codex agent gets its own thread:

```javascript
ws.send(JSON.stringify({
  method: 'thread/start',
  id: requestId++,
  params: {
    model: 'gpt-5.1-codex',
    cwd: projectRoot
  }
}));
// Response: { id: 1, result: { thread: { id: 'thr_xxx' } } }
```

### 4. Message Translation

**Agent Relay → Codex**

When agent-relay delivers a message to Codex agent:

```javascript
// Incoming relay message
{ to: 'CodexWorker', from: 'Lead', body: 'Implement auth module' }

// Translated to Codex turn
ws.send(JSON.stringify({
  method: 'turn/start',
  id: requestId++,
  params: {
    threadId: agentThreadId,
    input: [{
      type: 'text',
      text: `[Relay message from Lead]\n\n${body}`
    }]
  }
}));
```

**Codex → Agent Relay**

Monitor for `item/agentMessage/delta` and `turn/completed`:

```javascript
ws.on('message', (frame) => {
  const msg = JSON.parse(frame);

  if (msg.method === 'turn/completed') {
    // Extract final agent response
    const response = extractResponse(msg.params.turn);

    // Parse for relay triggers (->relay-file:xxx)
    const relayMessages = parseRelayTriggers(response);

    // Dispatch to agent-relay
    relayMessages.forEach(m => relay.dispatch(m));
  }
});
```

## Spawn Protocol Changes

### Current Format
```
KIND: spawn
NAME: CodexWorker
CLI: codex

Task description here.
```

### New Format (Backward Compatible)
```
KIND: spawn
NAME: CodexWorker
CLI: codex
TRANSPORT: websocket  # Optional, defaults to 'cli'

Task description here.
```

Or auto-detect:
```
KIND: spawn
NAME: CodexWorker
CLI: codex-ws  # New CLI identifier for WebSocket mode

Task description here.
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Agent Relay                          │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │   Claude    │  │   Codex     │  │   Gemini    │     │
│  │   Adapter   │  │   Adapter   │  │   Adapter   │     │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │
│         │                │                │             │
│    CLI spawn       WebSocket RPC      CLI spawn        │
│         │                │                │             │
│         ▼                ▼                ▼             │
│  ┌──────────┐     ┌───────────┐    ┌──────────┐        │
│  │  claude  │     │  codex    │    │  gemini  │        │
│  │  process │     │app-server │    │  process │        │
│  └──────────┘     └───────────┘    └──────────┘        │
└─────────────────────────────────────────────────────────┘
```

## CodexAdapter Implementation

```typescript
interface CodexAdapter {
  // Connection management
  connect(endpoint: string): Promise<void>;
  disconnect(): Promise<void>;

  // Agent lifecycle
  createAgent(name: string, task: string): Promise<CodexAgent>;
  destroyAgent(name: string): Promise<void>;

  // Message handling
  sendMessage(agentName: string, message: RelayMessage): Promise<void>;
  onResponse(handler: (agentName: string, response: string) => void): void;

  // Turn control
  interruptAgent(name: string): Promise<void>;
  steerAgent(name: string, additionalInput: string): Promise<void>;
}

class CodexAgent {
  threadId: string;
  name: string;
  status: 'idle' | 'processing' | 'completed';

  async sendTurn(input: string): Promise<void>;
  async interrupt(): Promise<void>;
  async steer(input: string): Promise<void>;
}
```

## Event Mapping

| Codex Event | Agent Relay Action |
|-------------|-------------------|
| `turn/started` | Log agent activity |
| `item/agentMessage/delta` | Stream to observers (optional) |
| `item/completed` (type: command) | Log command execution |
| `item/completed` (type: fileChange) | Log file modification |
| `turn/completed` | Parse response, dispatch relay messages |
| Error `-32001` (overloaded) | Retry with backoff |

## Benefits

1. **No stdin injection** - Clean JSON-RPC instead of text manipulation
2. **Structured events** - Know exactly when commands run, files change
3. **Interrupt support** - Can stop runaway agents mid-turn
4. **Steering** - Append guidance to in-flight turns
5. **Single server** - One app-server can handle multiple agent threads
6. **Better error handling** - Typed errors vs parsing stderr

## Considerations

1. **Experimental** - WebSocket transport marked experimental by OpenAI
2. **Server lifecycle** - Need to manage app-server process
3. **Connection pooling** - Shared server vs per-agent connections
4. **Fallback** - Keep CLI mode as backup

## Implementation Phases

### Phase 1: Proof of Concept
- [ ] Manual WebSocket connection to Codex app-server
- [ ] Send/receive JSON-RPC messages
- [ ] Parse relay triggers from responses

### Phase 2: Adapter Integration
- [ ] Create `CodexAdapter` class
- [ ] Integrate with agent-relay spawn flow
- [ ] Handle connection lifecycle

### Phase 3: Full Integration
- [ ] Auto-start app-server when needed
- [ ] Connection pooling for multiple agents
- [ ] Streaming event support
- [ ] Interrupt/steer commands via relay

## Open Questions

1. Should we expose Codex events (file changes, commands) as relay broadcasts?
2. One app-server per project or global singleton?
3. How to handle auth token refresh in long-running sessions?
4. Should steering be exposed as a relay protocol extension?
