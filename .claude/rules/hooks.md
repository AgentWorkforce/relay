---
paths:
  - "src/hooks/**/*.ts"
---

# Hooks Conventions

## Purpose

Hooks integrate with Claude Code's hook system to enable real-time agent communication.

## Directory Structure

```
src/hooks/
├── inbox-check/     # Main hook implementation
│   ├── hook.ts      # Hook entry point
│   ├── types.ts     # Hook-specific types
│   ├── utils.ts     # Helper functions
│   └── index.ts     # Exports
├── check-inbox.sh   # Shell wrapper for hook execution
├── types.ts         # Shared hook types
└── index.ts         # Module exports
```

## Hook Implementation

- Hooks are invoked by Claude Code at specific lifecycle events
- Read hook input from stdin as JSON
- Write hook output to stdout as JSON
- Exit with appropriate code (0 = success, non-zero = error)

## Types

```typescript
// Hook input from Claude Code
interface HookInput {
  event: string;
  data: unknown;
}

// Hook output to Claude Code
interface HookOutput {
  messages?: Message[];
  actions?: Action[];
}
```

## Utility Functions

- Keep utility functions pure and testable
- Co-locate tests with utilities: `utils.ts` -> `utils.test.ts`
- Export from `index.ts` for clean imports

## Shell Wrapper

- `check-inbox.sh` wraps the TypeScript hook for Claude Code
- Must be executable: `chmod +x`
- Handles Node.js execution and error output

## Testing

- Test utility functions in isolation
- Mock external dependencies (file system, network)
- Test hook output format compliance
