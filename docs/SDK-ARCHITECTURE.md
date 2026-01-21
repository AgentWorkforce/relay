# Agent Relay SDK Architecture

## Overview

This document outlines the architecture for Agent Relay SDKs that enable integrators like Conductor to easily add agent-to-agent communication to their platforms.

## The Protocol (Key Insight)

The Agent Relay protocol is deliberately simple:
- **Transport**: Unix socket (or TCP)
- **Framing**: 4-byte big-endian length prefix + JSON payload
- **Messages**: Typed JSON envelopes with `type`, `id`, `ts`, `payload`

This simplicity means **any language that can do socket I/O and JSON can be an SDK**.

```
┌────────────────────────────────────────────────────┐
│ Frame Format (Legacy Mode - Recommended)           │
├────────────────────────────────────────────────────┤
│ [4 bytes: payload length (big-endian)] [N bytes: JSON payload] │
└────────────────────────────────────────────────────┘
```

---

## Recommended Architecture: npm Workspaces + Multi-language SDKs

```
agent-relay/
├── packages/                      # npm workspace packages
│   ├── sdk/                       # @agent-relay/sdk (TypeScript)
│   ├── daemon/                    # @agent-relay/daemon
│   ├── cli/                       # @agent-relay/cli
│   └── dashboard/                 # @agent-relay/dashboard
│
├── sdks/                          # Multi-language SDKs
│   ├── python/                    # agent-relay-python
│   ├── go/                        # agent-relay-go
│   └── rust/                      # agent-relay-rs (relay-pty)
│
├── relay-pty/                     # Existing Rust binary
├── package.json                   # Workspace root
└── turbo.json                     # Optional: turborepo for builds
```

---

## Package 1: @agent-relay/sdk (TypeScript)

**Purpose**: Lightweight SDK for Node.js/TypeScript integrators

**Target size**: ~20KB minified (no heavy dependencies)

**Dependencies**: Zero external dependencies (uses Node.js `net` module)

### Exports

```typescript
// Core client
export { RelayClient, type ClientConfig, type ClientState } from './client';

// Protocol types
export { PROTOCOL_VERSION } from './protocol';
export type {
  Envelope,
  MessageType,
  PayloadKind,
  SendPayload,
  HelloPayload,
  WelcomePayload,
} from './protocol';

// Spawn types (optional - for full integration)
export type {
  SpawnRequest,
  SpawnResult,
  ReleaseResult,
} from './spawn';
```

### Usage Example (Conductor)

```typescript
import { RelayClient } from '@agent-relay/sdk';

// Connect to daemon (Conductor starts daemon separately)
const client = new RelayClient({
  agentName: 'ConductorAgent1',
  socketPath: '/tmp/agent-relay.sock',
});

// Handle incoming messages
client.onMessage = (from, payload, messageId) => {
  console.log(`Message from ${from}: ${payload.body}`);
};

// Connect and send messages
await client.connect();
client.sendMessage('OtherAgent', 'Hello from Conductor!');
```

### File Structure

```
packages/sdk/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts           # Public exports
│   ├── client.ts          # RelayClient implementation
│   ├── protocol.ts        # Protocol types and constants
│   ├── framing.ts         # Frame encoding/decoding
│   └── types.ts           # Shared types
└── test/
    ├── client.test.ts
    └── framing.test.ts
```

### package.json

```json
{
  "name": "@agent-relay/sdk",
  "version": "1.0.0",
  "description": "Lightweight SDK for Agent Relay agent-to-agent communication",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "dependencies": {},
  "devDependencies": {
    "typescript": "^5.0.0"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "keywords": ["agent", "relay", "communication", "sdk", "ai"]
}
```

---

## Package 2: @agent-relay/daemon

**Purpose**: Standalone daemon server (for those who need to run it programmatically)

**Depends on**: @agent-relay/sdk (for protocol types)

```typescript
import { Daemon } from '@agent-relay/daemon';

const daemon = new Daemon({
  socketPath: '/tmp/my-relay.sock',
  enableSpawner: false,  // Optional: disable agent lifecycle
});

await daemon.start();
```

---

## Package 3: @agent-relay/cli

**Purpose**: Command-line interface

**Depends on**: @agent-relay/daemon, @agent-relay/sdk

```bash
npx @agent-relay/cli daemon        # Start daemon only
npx @agent-relay/cli up            # Start daemon + spawner
npx @agent-relay/cli up --dashboard # Start everything
```

---

## Multi-language SDKs

### Python SDK: `agent-relay-python`

```python
from agent_relay import RelayClient

client = RelayClient(
    agent_name="PythonAgent",
    socket_path="/tmp/agent-relay.sock"
)

@client.on_message
def handle_message(from_agent: str, body: str):
    print(f"Message from {from_agent}: {body}")

await client.connect()
await client.send_message("OtherAgent", "Hello from Python!")
```

**Implementation Notes**:
- Use `asyncio` for async socket handling
- Simple JSON + struct for framing
- ~200 lines of code total

### Go SDK: `agent-relay-go`

```go
package main

import (
    relay "github.com/AgentWorkforce/agent-relay-go"
)

func main() {
    client := relay.NewClient(relay.Config{
        AgentName:  "GoAgent",
        SocketPath: "/tmp/agent-relay.sock",
    })

    client.OnMessage(func(from string, payload relay.Payload) {
        fmt.Printf("Message from %s: %s\n", from, payload.Body)
    })

    client.Connect()
    client.SendMessage("OtherAgent", "Hello from Go!")
}
```

**Implementation Notes**:
- Use `net.Dial("unix", socketPath)`
- `encoding/json` for serialization
- Single file, ~300 lines

### Rust SDK: Already exists as `relay-pty`

The Rust implementation already exists. Could be extracted as a library:

```rust
use agent_relay::RelayClient;

let client = RelayClient::new("RustAgent", "/tmp/agent-relay.sock");
client.on_message(|from, payload| {
    println!("Message from {}: {}", from, payload.body);
});
client.connect().await?;
client.send_message("OtherAgent", "Hello from Rust!").await?;
```

---

## Workspace Setup

### Root package.json

```json
{
  "name": "agent-relay-monorepo",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build": "npm run build --workspaces",
    "test": "npm run test --workspaces",
    "publish:sdk": "npm publish --workspace=@agent-relay/sdk",
    "publish:all": "npm publish --workspaces"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "turbo": "^2.0.0"
  }
}
```

### turbo.json (optional, for faster builds)

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["build"]
    }
  }
}
```

---

## Migration Path

### Phase 1: Extract SDK (Low Risk)

1. Create `packages/sdk/` with minimal client code
2. Keep existing package working (backwards compatible)
3. Publish `@agent-relay/sdk` as separate package
4. Conductor can start using SDK immediately

### Phase 2: Split Daemon (Medium Risk)

1. Create `packages/daemon/` with server code
2. Daemon imports SDK for protocol types
3. Update existing package to re-export from workspace packages

### Phase 3: Full Workspace Migration (Higher Risk)

1. Move CLI to `packages/cli/`
2. Move dashboard to `packages/dashboard/`
3. Update all imports and build scripts
4. Main `agent-relay` package becomes a meta-package

---

## Decision: Do We Need Workspaces?

### Option A: Workspaces (Recommended for SDK focus)

**Pros**:
- Clean separation of SDK from dashboard/daemon
- Smaller install size for SDK users (~20KB vs ~50MB)
- Independent versioning
- Clear API boundaries
- Easier multi-language SDK maintenance

**Cons**:
- More complex build setup
- Migration effort
- Multiple npm packages to maintain

### Option B: Subpath Exports (Simpler)

Keep single package but expose SDK via subpath:

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./sdk": "./dist/sdk/index.js"
  }
}
```

**Pros**:
- Minimal migration
- Single package to maintain

**Cons**:
- SDK users still install full package (50MB)
- Mixed dependencies
- Less clear separation

### Recommendation

**For Conductor integration**: Start with **Option B** (subpath exports) for quick wins, then migrate to **Option A** (workspaces) when SDK becomes the primary use case.

---

## Protocol Specification (For Multi-language SDKs)

### Connection Flow

```
Client                          Daemon
  |                               |
  |-------- TCP/Unix connect ---->|
  |                               |
  |-------- HELLO envelope ------>|
  |                               |
  |<------- WELCOME envelope -----|
  |                               |
  |-------- SEND envelope ------->|
  |                               |
  |<------- DELIVER envelope -----|
  |                               |
  |-------- ACK envelope -------->|
  |                               |
```

### Frame Format

```
┌─────────────────────────────────────────────┐
│ 4 bytes: payload length (big-endian uint32) │
├─────────────────────────────────────────────┤
│ N bytes: JSON-encoded envelope              │
└─────────────────────────────────────────────┘
```

### Envelope Structure

```json
{
  "v": 1,
  "type": "SEND",
  "id": "uuid-here",
  "ts": 1705849200000,
  "to": "AgentB",
  "payload": {
    "kind": "message",
    "body": "Hello!"
  }
}
```

### Message Types

| Type | Direction | Purpose |
|------|-----------|---------|
| HELLO | Client→Server | Register agent |
| WELCOME | Server→Client | Confirm registration |
| SEND | Client→Server | Send message |
| DELIVER | Server→Client | Receive message |
| ACK | Client→Server | Acknowledge delivery |
| PING/PONG | Both | Heartbeat |
| SPAWN | Client→Server | Spawn agent |
| SPAWN_RESULT | Server→Client | Spawn result |

---

## Next Steps

1. **Create beads for SDK work**
2. **Extract SDK to `packages/sdk/`**
3. **Publish `@agent-relay/sdk` to npm**
4. **Write Python SDK** (highest demand after TypeScript)
5. **Document protocol** for community SDK implementations
