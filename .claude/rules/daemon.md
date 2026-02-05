---
paths:
  - "packages/daemon/src/**/*.ts"
---

# Daemon Conventions

## Architecture

The daemon manages agent connections using a state machine pattern:
- `CONNECTING` -> `HANDSHAKING` -> `ACTIVE` -> `CLOSING` -> `CLOSED`
- State transitions should be explicit and logged

## Connection Handling

- Each connection has a unique `id` (UUID)
- Agent identification happens during handshake via `HELLO` message
- Use the protocol types from `../protocol/types.js`

## Protocol

- Import from `../protocol/types.js` for envelope types
- Use `encodeFrame`/`FrameParser` from `../protocol/framing.js`
- Always include protocol version in envelopes: `v: PROTOCOL_VERSION`
- Message IDs should use UUID v4

## Error Handling

- Send ERROR envelope before closing on protocol violations
- Use error codes from the protocol: `BAD_REQUEST`, `RESUME_TOO_OLD`, etc.
- Log errors with connection context (agent name, connection ID)

## Heartbeat

- Default heartbeat interval: 5000ms
- Timeout multiplier: 6x (30s total)
- Exempt agents that are actively processing from timeout

## Event Callbacks

- Use optional callback properties: `onMessage`, `onClose`, `onError`, `onActive`
- Callbacks should be invoked after state transitions complete

## Configuration

- Use `DEFAULT_CONFIG` as base, merge with provided config
- Config interface should document all options with JSDoc

## Agent Spawning

- Enable protocol-based spawning with `spawnManager: true` in config
- `SPAWN` and `RELEASE` messages are delegated to `SpawnManager`
- `SEND_INPUT` messages send input data to a spawned agent's PTY (via SpawnManager)
- `LIST_WORKERS` messages return the list of active spawned workers (via SpawnManager)
- SpawnManager wraps `AgentSpawner` from `@agent-relay/bridge`
- Sends `SPAWN_RESULT`, `RELEASE_RESULT`, `SEND_INPUT_RESULT`, and `LIST_WORKERS_RESULT` envelopes back to requestor
- If SpawnManager not enabled, sends ERROR envelope for spawn/worker management requests
- `daemon.getSpawnManager()` exposes the SpawnManager instance for co-located services (e.g., dashboard-server) to access read operations (logs, worker listing) without going through the socket protocol

## Example Pattern

```typescript
// State machine handling
private async processFrame(envelope: Envelope): Promise<void> {
  switch (envelope.type) {
    case 'HELLO':
      await this.handleHello(envelope as Envelope<HelloPayload>);
      break;
    case 'SEND':
      this.handleSend(envelope as Envelope<SendPayload>);
      break;
    case 'SPAWN':
      this.spawnManager?.handleSpawn(connection, envelope as Envelope<SpawnPayload>);
      break;
    case 'RELEASE':
      this.spawnManager?.handleRelease(connection, envelope as Envelope<ReleasePayload>);
      break;
    case 'SEND_INPUT':
      this.spawnManager?.handleSendInput(connection, envelope as Envelope<SendInputPayload>);
      break;
    case 'LIST_WORKERS':
      this.spawnManager?.handleListWorkers(connection, envelope as Envelope<ListWorkersPayload>);
      break;
    // ... other cases
  }
}
```
