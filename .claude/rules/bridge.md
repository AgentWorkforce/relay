---
paths:
  - "src/bridge/**/*.ts"
---

# Bridge Conventions

## Purpose

The bridge module enables multi-project agent coordination, connecting agents across different workspaces.

## Key Components

- `multi-project-client.ts` - Client for cross-project communication
- `config.ts` - Bridge configuration management
- `teams-config.ts` - Team-based agent grouping
- `utils.ts` - Shared utilities

## Configuration

```typescript
interface BridgeConfig {
  enabled: boolean;
  servers: ServerConfig[];
  teams?: TeamConfig[];
}

interface ServerConfig {
  id: string;
  url: string;
  name?: string;
}
```

## Testing Levels

- Unit tests: `*.test.ts` - Test individual functions
- Integration tests: `*.integration.test.ts` - Test cross-component behavior

## Client Pattern

- Use reconnecting WebSocket pattern
- Handle connection state transitions
- Queue messages during disconnection
- Deduplicate message delivery

## Error Handling

- Log connection errors without throwing
- Graceful degradation when bridge unavailable
- Retry with exponential backoff

## Config Files

- Bridge config: `.relay/bridge.json`
- Teams config: `.relay/teams.json`
- Use project-relative paths via `getProjectPaths()`
