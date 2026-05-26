---
paths:
  - 'packages/hooks/src/**/*.ts'
---

# Hooks Conventions

## Purpose

Hooks integrate with Claude Code's hook system for trajectory tracking and other lifecycle events.

## Directory Structure

```
packages/hooks/src/
├── trajectory-hooks.ts  # Trajectory event hooks
├── registry.ts          # Hook registration
├── emitter.ts           # Hook emitter
├── types.ts             # Shared hook types
└── index.ts             # Module exports
```

## Hook Implementation

- Hooks are invoked by Claude Code at specific lifecycle events
- Read hook input from stdin as JSON
- Write hook output to stdout as JSON
- Exit with appropriate code (0 = success, non-zero = error)

## Testing

- Test utility functions in isolation
- Mock external dependencies (file system, network)
- Test hook output format compliance
