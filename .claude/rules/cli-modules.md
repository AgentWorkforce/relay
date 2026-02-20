---
paths:
  - 'src/cli/**/*.ts'
---

# CLI Module Conventions

## Binary

- `agent-relay` = TypeScript CLI (user-facing, 35+ commands)
- `agent-relay-broker` = Rust binary (internal broker engine)
- NEVER confuse the two in code or docs

## Entry Point

- `src/cli/bootstrap.ts` is the CLI entry point (NOT `src/cli/index.ts`)
- `bootstrap.ts` registers all command modules and wires up the Commander program

## Command Module Pattern

Every command module follows the DI (dependency injection) pattern:

```typescript
// src/cli/commands/foo.ts
export interface FooDependencies {
  createClient: (cwd: string) => FooClient;
  exit: (code: number) => never;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export function registerFooCommands(program: Command, overrides: Partial<FooDependencies> = {}): void {
  const deps = withDefaults(overrides);
  // register commands using deps...
}
```

## Command Modules

Located in `src/cli/commands/`:

- `agent-management.ts` — spawn, release, agents, who, shadow
- `messaging.ts` — send, inbox, channels, DMs
- `cloud.ts` — link, unlink, cloud status
- `monitoring.ts` — status, metrics, health
- `auth.ts` — login, logout, token management
- `setup.ts` — init, config, install hooks
- `core.ts` — run, workflows, version, completions

## Shared Helpers

Located in `src/cli/lib/`:

- `client-factory.ts` — creates AgentRelayClient instances
- `broker-lifecycle.ts` — broker start/stop helpers
- `formatting.ts` — output formatting utilities
- `paths.ts` — path resolution helpers

## Key Rules

- Always accept `overrides: Partial<Dependencies> = {}` for testability
- Use `ExitFn` type for `process.exit` wrapper: `type ExitFn = (code: number) => never`
- Default deps use real implementations; tests override with mocks
- Import helpers from `../lib/` not from other command modules
