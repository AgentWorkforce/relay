---
paths:
  - 'packages/cli/src/cli/**/*.ts'
---

# CLI Module Conventions

## Binary

- `agent-relay` (alias `relay`) = TypeScript CLI (user-facing)
- `agent-relay-node` = the Agent Relay core (Rust, `crates/relay-node`); `relay init` installs it when needed and starts it, or reuses the one the desktop app or a service already runs (one core per machine)
- The Rust broker (`agent-relay-broker`) was retired; do not add code that launches or talks to it

## Entry Point

- `packages/cli/src/cli/bootstrap.ts` is the CLI entry point (NOT `packages/cli/src/cli/index.ts`)
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

Located in `packages/cli/src/cli/commands/` (a representative list; `bootstrap.ts` registers them all):

- `init.ts` — `relay init`: local or hosted server, agent tools, and the core
- `agent.ts`, `channel.ts`, `message.ts` — workspace agents and messaging
- `cloud.ts`, `workspace.ts` — Cloud login, runs, and workspace selection
- `fleet.ts` — fleet nodes, placement spawn, release
- `integration.ts` — relayfile integration subscriptions and webhooks
- `node.ts`, `local-workflow.ts` — `relay node workflow …` and removal notices for the retired broker verbs
- `core.ts` — version, update, uninstall

## Shared Helpers

Located in `packages/cli/src/cli/lib/`:

- `sdk-client.ts`, `sdk-command.ts` — workspace selection and SDK-backed command plumbing
- `relay-node.ts`, `install-paths.ts` — the core binary and the canonical install directory
- `formatting.ts` — output formatting utilities

## Key Rules

- Always accept `overrides: Partial<Dependencies> = {}` for testability
- Use `ExitFn` type for `process.exit` wrapper: `type ExitFn = (code: number) => never`
- Default deps use real implementations; tests override with mocks
- Import helpers from `../lib/` not from other command modules
