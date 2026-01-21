# Implementation Plan: Conductor Integration - Daemon/Dashboard Decoupling

**Branch**: `feature/daemon-spawning-dashboard-default` (PR #182)
**Epic**: agent-relay-479
**Status**: In Progress

---

## Overview

This plan completes the work started in PR #182 to enable integrators like Conductor to use Agent Relay's messaging protocol without requiring the dashboard.

### Current State (PR #182 Progress)

| Component | Status | Notes |
|-----------|--------|-------|
| Protocol types (SPAWN/RELEASE) | Done | `src/protocol/types.ts` |
| SpawnManager in daemon | Done | `src/daemon/spawn-manager.ts` |
| RelayClient.spawn()/release() | Done | `src/wrapper/client.ts` |
| Dashboard disabled by default | Done | `--dashboard` flag in CLI |
| Wrappers use daemon socket | **TODO** | Still uses HTTP fallback |
| AgentSpawner task delivery | **TODO** | Requires dashboardPort |
| SDK exports | **TODO** | Need clean entry point |
| Tests | **TODO** | Integration tests needed |
| Documentation | **TODO** | Update proposal doc |

---

## Implementation Tasks

### Task 1: Wrappers Use Daemon Socket (agent-relay-480)

**File**: `src/wrapper/base-wrapper.ts`

**Current behavior**:
```typescript
// Lines 381-400 - uses HTTP API
if (this.config.dashboardPort) {
  await fetch(`http://localhost:${this.config.dashboardPort}/api/agents/spawn`, ...)
}
```

**Target behavior**:
```typescript
// Prefer daemon socket, fall back to HTTP only if socket unavailable
protected async spawnWorker(name: string, cli: string, task: string): Promise<void> {
  // Option 1: Use daemon socket (preferred - no dashboard needed)
  if (this.relayClient?.state === 'READY') {
    const result = await this.relayClient.spawn({ name, cli, task });
    if (result.success) return;
    console.warn(`[wrapper] Daemon spawn failed: ${result.error}, trying HTTP fallback`);
  }

  // Option 2: HTTP API fallback (requires dashboard)
  if (this.config.dashboardPort) {
    await fetch(`http://localhost:${this.config.dashboardPort}/api/agents/spawn`, ...);
    return;
  }

  throw new Error('No spawn method available (daemon not connected, no dashboardPort)');
}
```

**Changes needed**:
1. Add `relayClient` property to BaseWrapper (currently only in subclasses)
2. Update `spawnWorker()` to try daemon socket first
3. Update `releaseWorker()` similarly
4. Remove requirement for dashboardPort when daemon socket is available

---

### Task 2: AgentSpawner Task Delivery (agent-relay-481)

**File**: `src/bridge/spawner.ts`

**Current behavior** (lines 719-757):
```typescript
// Send task to spawned agent via HTTP
if (task && this.dashboardPort) {
  const sendResponse = await fetch(
    `http://localhost:${this.dashboardPort}/api/send`,
    { body: JSON.stringify({ to: name, message: task, from: spawnerName }) }
  );
}
```

**Problem**: If no dashboardPort, task is never sent to spawned agent.

**Target behavior**:
```typescript
// Send task via daemon message routing (no HTTP needed)
if (task && task.trim()) {
  // Use daemon's message routing directly
  // The spawner is already connected to daemon via its own socket
  await this.sendTaskMessage(name, task, spawnerName);
}

private async sendTaskMessage(to: string, task: string, from?: string): Promise<void> {
  // Option 1: If we have a RelayClient, use it
  if (this.relayClient) {
    this.relayClient.sendMessage(to, task);
    return;
  }

  // Option 2: Use daemon's internal routing
  // SpawnManager has access to daemon, can route messages directly
  if (this.daemonRouter) {
    this.daemonRouter.sendSystemMessage(from ?? '__spawner__', to, task);
    return;
  }

  // Option 3: HTTP fallback (for backwards compatibility)
  if (this.dashboardPort) {
    await fetch(`http://localhost:${this.dashboardPort}/api/send`, ...);
  }
}
```

**Architecture decision**:
- SpawnManager should create a RelayClient for task delivery
- OR SpawnManager should accept a reference to the Router for internal routing
- Prefer RelayClient approach for consistency with SDK usage

---

### Task 3: Daemon-Only CLI Mode (agent-relay-482)

**File**: `src/cli/index.ts`

**Add new subcommand**:
```typescript
program
  .command('daemon')
  .description('Start minimal daemon (messaging only, no spawner/dashboard)')
  .option('--socket <path>', 'Socket path', DEFAULT_SOCKET_PATH)
  .action(async (options) => {
    const daemon = new Daemon({
      socketPath: options.socket,
      enableSpawner: false,  // No agent lifecycle management
    });

    await daemon.start();
    console.log(`Daemon listening on ${options.socket}`);
    console.log('Mode: messaging only (no spawner, no dashboard)');

    // Wait for shutdown signal
    await new Promise(() => {}); // Block forever
  });
```

**Daemon config changes** (`src/daemon/server.ts`):
```typescript
export interface DaemonConfig {
  // ... existing ...

  /** Enable spawn manager for agent lifecycle (default: true) */
  enableSpawner?: boolean;
}
```

---

### Task 4: SDK Exports (agent-relay-483)

**File**: `src/index.ts` (package entry point)

**Current exports** (check what's exported):
```typescript
// Ensure these are exported for SDK consumers:
export { RelayClient, type ClientConfig, type ClientState } from './wrapper/client.js';
export type { SpawnRequest, SpawnResult, ReleaseResult } from './bridge/types.js';
export { Daemon, type DaemonConfig } from './daemon/server.js';
export { PROTOCOL_VERSION } from './protocol/types.js';
```

**Add SDK-friendly re-exports**:
```typescript
// src/sdk.ts - Clean SDK entry point
export { RelayClient } from './wrapper/client.js';
export type {
  ClientConfig,
  ClientState,
  SyncOptions,
} from './wrapper/client.js';

export type {
  SpawnRequest,
  SpawnResult,
  WorkerInfo,
} from './bridge/types.js';

// Protocol types for advanced usage
export { PROTOCOL_VERSION } from './protocol/types.js';
export type {
  Envelope,
  SendPayload,
  DeliverEnvelope,
  PayloadKind,
} from './protocol/types.js';
```

**Package.json exports**:
```json
{
  "exports": {
    ".": "./dist/index.js",
    "./sdk": "./dist/sdk.js",
    "./client": "./dist/wrapper/client.js"
  }
}
```

---

### Task 5: Tests (agent-relay-484)

**File**: `src/daemon/spawn-manager.test.ts` (new)

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Daemon } from './server.js';
import { RelayClient } from '../wrapper/client.js';

describe('Daemon-based spawning', () => {
  let daemon: Daemon;
  let client: RelayClient;

  beforeAll(async () => {
    daemon = new Daemon({
      socketPath: '/tmp/test-relay.sock',
      enableSpawner: true,
    });
    await daemon.start();

    client = new RelayClient({
      socketPath: '/tmp/test-relay.sock',
      agentName: 'TestSpawner',
    });
    await client.connect();
  });

  afterAll(async () => {
    client.disconnect();
    await daemon.stop();
  });

  it('should spawn agent via daemon socket', async () => {
    const result = await client.spawn({
      name: 'TestWorker',
      cli: 'echo',  // Simple command for testing
      task: 'Hello',
    });

    expect(result.success).toBe(true);
    expect(result.name).toBe('TestWorker');
  });

  it('should release agent via daemon socket', async () => {
    const released = await client.release('TestWorker');
    expect(released).toBe(true);
  });

  it('should work without dashboard running', async () => {
    // Verify no HTTP server is listening
    const dashboardCheck = await fetch('http://localhost:3888/health')
      .catch(() => null);
    expect(dashboardCheck).toBeNull();

    // Spawn should still work via daemon
    const result = await client.spawn({
      name: 'NoDashboardWorker',
      cli: 'echo',
      task: 'Works without dashboard',
    });
    expect(result.success).toBe(true);
  });
});
```

---

### Task 6: Documentation (agent-relay-485)

**File**: `docs/PROPOSAL-conductor-integration.md`

**Add SDK usage section**:

```markdown
## SDK Integration (Recommended)

### Minimal Setup for Conductor

```typescript
import { RelayClient } from 'agent-relay/sdk';

// Start daemon separately: agent-relay daemon
// OR start it programmatically:
// import { Daemon } from 'agent-relay';
// const daemon = new Daemon({ enableSpawner: false });
// await daemon.start();

class ConductorAgentBridge {
  private clients: Map<string, RelayClient> = new Map();

  async registerAgent(agentName: string, socketPath: string) {
    const client = new RelayClient({
      agentName,
      socketPath,
      reconnect: true,
    });

    client.onMessage = (from, payload) => {
      this.handleAgentMessage(agentName, from, payload);
    };

    await client.connect();
    this.clients.set(agentName, client);
  }

  async sendMessage(from: string, to: string, message: string) {
    const client = this.clients.get(from);
    if (!client) throw new Error(`Agent ${from} not registered`);
    return client.sendMessage(to, message);
  }

  private handleAgentMessage(agent: string, from: string, payload: SendPayload) {
    // Route to Conductor's agent process
    console.log(`[${agent}] Message from ${from}: ${payload.body}`);
  }
}
```

### Starting Daemon Programmatically

```typescript
import { Daemon } from 'agent-relay';

// Minimal daemon for messaging only
const daemon = new Daemon({
  socketPath: '/tmp/conductor-relay.sock',
  enableSpawner: false,  // Conductor manages agent lifecycle
});

await daemon.start();
console.log('Relay daemon ready for messaging');
```

### CLI Integration (Alternative)

```bash
# Conductor starts daemon in background
agent-relay daemon --socket /tmp/conductor-relay.sock &

# Each agent connects via wrapper
agent-relay -n AgentA --socket /tmp/conductor-relay.sock -- claude
agent-relay -n AgentB --socket /tmp/conductor-relay.sock -- claude
```
```

---

## Execution Order

```
┌─────────────────────────────────────────────────────────────────┐
│ agent-relay-479 (Epic: Conductor Integration)                    │
│   Status: in_progress                                            │
└─────────────────────────────────────────────────────────────────┘
         │
         ├──────────────────┬────────────────────┬─────────────────┐
         ▼                  ▼                    ▼                 ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ agent-relay-480 │ │ agent-relay-481 │ │ agent-relay-482 │ │ agent-relay-483 │
│ Wrappers socket │ │ Spawner task    │ │ Daemon CLI      │ │ SDK exports     │
│ Priority: P2    │ │ Priority: P2    │ │ Priority: P3    │ │ Priority: P2    │
└────────┬────────┘ └────────┬────────┘ └─────────────────┘ └────────┬────────┘
         │                   │                                       │
         └─────────┬─────────┘                                       │
                   ▼                                                 ▼
         ┌─────────────────┐                               ┌─────────────────┐
         │ agent-relay-484 │                               │ agent-relay-485 │
         │ Tests           │                               │ Documentation   │
         │ Priority: P2    │                               │ Priority: P3    │
         └─────────────────┘                               └─────────────────┘
```

**Recommended execution order**:
1. `agent-relay-480` (Wrappers) - Core functionality
2. `agent-relay-481` (Spawner) - Core functionality
3. `agent-relay-483` (SDK exports) - API surface
4. `agent-relay-484` (Tests) - Verify implementation
5. `agent-relay-482` (CLI) - Nice-to-have
6. `agent-relay-485` (Docs) - Final polish

---

## Success Criteria

- [ ] `agent-relay daemon` starts minimal messaging-only daemon
- [ ] `RelayClient.spawn()` works without dashboard running
- [ ] Wrappers can spawn sub-agents via daemon socket
- [ ] AgentSpawner delivers tasks without dashboardPort
- [ ] Integration tests pass
- [ ] Example code in docs works end-to-end

---

## Migration Notes for Existing Users

**No breaking changes**. All existing behavior preserved:
- `agent-relay up` still works (dashboard now opt-in with `--dashboard`)
- HTTP API still available when dashboard is enabled
- Wrappers fall back to HTTP when daemon socket unavailable

**New capabilities**:
- SDK users can embed RelayClient without dashboard
- CLI users can run `agent-relay daemon` for minimal setup
- Conductor can integrate with messaging protocol only
