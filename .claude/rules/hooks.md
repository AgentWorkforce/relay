---
paths:
  - 'packages/hooks/src/**/*.ts'
---

# Hooks Conventions

## Purpose

Hooks integrate with Claude Code's hook system to enable real-time agent communication (inbox checking, trajectory tracking).

## Directory Structure

```
packages/hooks/src/
├── inbox-check/     # Inbox polling hook
├── trajectory-hooks.ts  # Trajectory event hooks
├── registry.ts      # Hook registration
├── types.ts         # Shared hook types
└── index.ts         # Module exports
```

## Hook Implementation

- Hooks are invoked by Claude Code at specific lifecycle events
- Read hook input from stdin as JSON
- Write hook output to stdout as JSON
- Exit with appropriate code (0 = success, non-zero = error)

## Shell Wrapper

- `check-inbox.sh` wraps the TypeScript hook for Claude Code
- Must be executable: `chmod +x`
- Handles Node.js execution and error output

## Testing

- Test utility functions in isolation
- Mock external dependencies (file system, network)
- Test hook output format compliance
