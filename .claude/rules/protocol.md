---
paths:
  - "src/protocol/**/*.ts"
---

# Protocol Conventions

## Overview

The protocol module defines the wire format for agent-daemon communication.

## Envelope Structure

All messages use the `Envelope<T>` wrapper:

```typescript
interface Envelope<T = unknown> {
  v: number;           // Protocol version
  type: MessageType;   // HELLO, WELCOME, SEND, DELIVER, etc.
  id: string;          // UUID for message identification
  ts: number;          // Unix timestamp (ms)
  payload: T;          // Type-specific payload
}
```

## Message Types

- `HELLO` / `WELCOME` - Handshake
- `SEND` / `DELIVER` - Message routing
- `ACK` / `NACK` - Acknowledgments
- `PING` / `PONG` - Heartbeat
- `ERROR` - Protocol errors
- `LOG` - Agent log streaming
- `SHADOW_BIND` / `SHADOW_UNBIND` - Shadow agent management

## Type Naming

- Payload interfaces: `{MessageType}Payload` (e.g., `SendPayload`)
- Envelope aliases: `{MessageType}Envelope` (e.g., `DeliverEnvelope`)
- Use union types for constrained values: `MessageType`, `ErrorCode`, `PayloadKind`

## Framing

- Messages are length-prefixed JSON frames
- Use `encodeFrame()` to serialize
- Use `FrameParser` class to deserialize (handles partial reads)
- Max frame size: configurable via `maxFrameBytes`

## Version Compatibility

- Export `PROTOCOL_VERSION` constant
- Always include version in envelopes
- Handle version mismatches gracefully

## Export Pattern

```typescript
// types.ts - all types
export type MessageType = 'HELLO' | 'WELCOME' | ...;
export interface Envelope<T> { ... }
export interface SendPayload { ... }

// index.ts - re-exports
export * from './types.js';
export { encodeFrame, FrameParser } from './framing.js';
```
