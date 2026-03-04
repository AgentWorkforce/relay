# Spec: OpenClawGatewayClient WebSocket Testing

## Problem

The `OpenClawGatewayClient` class in `gateway.ts` handles WebSocket connection, Ed25519 challenge-response auth, RPC message delivery, and automatic reconnection. It currently has 0% test coverage because it opens real WebSocket connections that are hard to mock.

## Approach: In-process Mock WebSocket Server

Use the `ws` package (already a dependency) to spin up a lightweight `WebSocketServer` on a random port within the test process. The mock server implements just enough of the OpenClaw gateway protocol to exercise all client code paths.

## Test Infrastructure

### MockOpenClawServer

```typescript
import WebSocket, { WebSocketServer } from 'ws';
import { AddressInfo } from 'node:net';

class MockOpenClawServer {
  private wss: WebSocketServer;
  port: number;
  connections: WebSocket[] = [];
  receivedMessages: Record<string, unknown>[] = [];

  /** Control flags — tests toggle these to simulate server behavior. */
  rejectAuth = false;
  skipChallenge = false;
  rpcDelay = 0;      // ms delay before responding to RPCs
  rpcError = false;   // respond to chat.send with an error

  constructor() {
    this.wss = new WebSocketServer({ port: 0 }); // random port
    this.port = (this.wss.address() as AddressInfo).port;
    this.wss.on('connection', (ws) => this.handleConnection(ws));
  }

  private handleConnection(ws: WebSocket): void {
    this.connections.push(ws);

    // Step 1: Send connect.challenge
    if (!this.skipChallenge) {
      ws.send(JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'test-nonce-123', ts: Date.now() },
      }));
    }

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      this.receivedMessages.push(msg);

      // Step 2: Handle connect request
      if (msg.method === 'connect') {
        ws.send(JSON.stringify({
          type: 'res',
          id: msg.id,
          ok: !this.rejectAuth,
          ...(this.rejectAuth ? { error: 'auth rejected' } : {}),
        }));
        return;
      }

      // Step 3: Handle chat.send RPC
      if (msg.method === 'chat.send') {
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'res',
            id: msg.id,
            ok: !this.rpcError,
            ...(this.rpcError
              ? { error: 'delivery failed' }
              : { payload: { runId: 'run_1', status: 'ok' } }),
          }));
        }, this.rpcDelay);
        return;
      }
    });
  }

  /** Forcibly close all connections (simulates server crash). */
  disconnectAll(): void {
    for (const ws of this.connections) ws.close(1006);
    this.connections = [];
  }

  async close(): Promise<void> {
    this.disconnectAll();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}
```

## Test Cases

### 1. Connection & Authentication

| Test | What it validates |
|---|---|
| `should connect and authenticate via challenge-response` | Full happy path: challenge → sign → connect response |
| `should reject when server denies auth` | `connect()` rejects when server returns `ok: false` |
| `should timeout if no challenge arrives` | `connect()` rejects after `CONNECT_TIMEOUT_MS` when `skipChallenge=true` |
| `should resolve immediately if already connected` | Second `connect()` call is a no-op |

### 2. Message Delivery (chat.send RPC)

| Test | What it validates |
|---|---|
| `should send chat.send and resolve true on success` | `sendChatMessage()` returns `true` |
| `should send idempotencyKey when provided` | Verify `params.idempotencyKey` in received message |
| `should resolve false when RPC returns error` | `rpcError=true` → returns `false` |
| `should resolve false on RPC timeout` | `rpcDelay=20000` → hits 15s timeout, returns `false` |
| `should reconnect and retry if not connected` | Disconnect, call `sendChatMessage`, verify reconnection |

### 3. Reconnection

| Test | What it validates |
|---|---|
| `should reconnect after server disconnects` | `disconnectAll()` → client reconnects within ~3s |
| `should not reconnect after stop()` | `disconnect()` then `disconnectAll()` → no reconnection |
| `should reject pending RPCs on disconnect` | In-flight `sendChatMessage` resolves `false` on disconnect |

### 4. Ed25519 Signature Verification

| Test | What it validates |
|---|---|
| `should produce valid Ed25519 signature` | Mock server verifies the signature using the client's public key from the connect payload |
| `should include correct v3 payload fields` | Verify clientId, clientMode, platform, role, scopes, nonce |

## Implementation Notes

- Each test creates its own `MockOpenClawServer` and `OpenClawGatewayClient` for full isolation.
- The `OpenClawGatewayClient` class is currently not exported. Either:
  - (a) Export it (simplest), or
  - (b) Test indirectly through `InboundGateway` with a real mock WS server (heavier but no API changes).
- Recommended: export the class with a `@internal` JSDoc tag.
- Tests should use `afterEach` to close both the mock server and client to prevent port leaks.

## E2E Integration Tests

Separate from the WS unit tests, create integration tests following the broker harness pattern in `tests/integration/broker/`:

### Test: Full gateway message flow with real Relaycast

```
1. Create ephemeral Relaycast workspace (RelayCast.createWorkspace)
2. Register two agents: "sender" and "viewer-test-claw"
3. Start InboundGateway with the workspace key
4. Post a message to #general via sender agent
5. Assert the gateway's relaySender.sendMessage was called with correct format
6. Post a DM from sender to viewer-test-claw
7. Assert DM delivery with [relaycast:dm] format
8. Add a reaction via sender
9. Assert reaction soft notification delivery
10. Cleanup: stop gateway, workspace is ephemeral
```

### Test: Gateway reconnection resilience

```
1. Start gateway with real Relaycast connection
2. Force-disconnect the SDK WebSocket (call relayAgentClient.disconnect())
3. Wait for reconnection
4. Post a message
5. Assert message is still delivered
```

### Prerequisites

These tests require network access to `api.relaycast.dev` and should:
- Use `checkPrerequisites()` pattern from broker harness
- Be skippable via `skipIfMissing()`
- Have generous timeouts (120s)
- Use unique channel/agent names with timestamp suffixes

## File Locations

```
packages/openclaw/src/__tests__/
  gateway-threads.test.ts         # Existing unit tests (vitest)
  ws-client.test.ts               # NEW: WebSocket client unit tests (vitest)

tests/integration/openclaw/
  gateway-e2e.test.ts             # NEW: Full integration tests (node:test)
  utils/gateway-harness.ts        # NEW: Gateway test harness
```

## Estimated Effort

- WS client unit tests: ~2-3 hours
- E2E integration tests: ~3-4 hours
- Total: ~1 day
