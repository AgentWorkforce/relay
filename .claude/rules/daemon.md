---
paths:
  - "src/daemon/**/*.ts"
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
    // ... other cases
  }
}
```
