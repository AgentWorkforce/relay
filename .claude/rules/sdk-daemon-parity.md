---
paths:
  - "packages/sdk/src/**/*.ts"
  - "packages/daemon/src/**/*.ts"
  - "packages/protocol/src/types.ts"
  - "src/cli/index.ts"
---

# SDK-Daemon Parity

## Principle

The SDK (`RelayClient`) is the canonical interface for daemon communication. All spawn/release fields supported by the spawner and bridge must be threaded through:

1. **Protocol types** (`SpawnPayload` in `packages/protocol/src/types.ts`)
2. **SDK client** (`client.spawn()` options and envelope payload in `packages/sdk/src/client.ts`)
3. **Daemon SpawnManager** (`handleSpawn` pass-through in `packages/daemon/src/spawn-manager.ts`)
4. **CLI** (the `client.spawn()` call in `src/cli/index.ts`)

## Adding New Spawn Fields

When adding a field to `SpawnRequest` in `packages/spawner/src/types.ts` or `packages/bridge/src/types.ts`:

- Add to `SpawnPayload` in `packages/protocol/src/types.ts`
- Add to `client.spawn()` options type in `packages/sdk/src/client.ts`
- Include in the envelope payload construction in `client.spawn()`
- Pass through in `SpawnManager.handleSpawn()` to `this.spawner.spawn()`
- Include in the CLI `client.spawn()` call in `src/cli/index.ts`
- Add a test verifying the field appears in the sent envelope

## Daemon vs HTTP API Parity

The daemon socket path and HTTP API fallback must produce identical behavior. The HTTP fallback passes the entire `spawnRequest` via `JSON.stringify()`, so it gets all fields automatically. The daemon path uses explicit field listing, which requires manual updates when new fields are added.

## SDK Over Direct Protocol

Always use `RelayClient` methods (`spawn`, `release`, `sendMessage`) rather than constructing raw protocol envelopes in CLI commands. The SDK handles:

- Connection lifecycle and reconnection
- Envelope construction with correct protocol version
- Timeout management and cleanup
- Correlation ID tracking for responses
