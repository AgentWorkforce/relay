---
paths:
  - '**/*.test.ts'
  - '**/*.test.tsx'
---

# Testing Conventions

## Framework

- Use Vitest for all TypeScript tests
- Import from `vitest`: `describe`, `it`, `expect`, `beforeEach`, `vi`

## CLI Command Testing — DI Pattern

All CLI commands use dependency injection for testability. Each command module exports:

- A `Dependencies` interface (e.g., `AgentManagementDependencies`, `CloudDependencies`)
- A `register*Commands(program, overrides?)` function that accepts partial dependency overrides

### ExitSignal Pattern

Use `ExitSignal` to test `process.exit` calls without actually exiting:

```typescript
class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

const exit = vi.fn((code: number) => {
  throw new ExitSignal(code);
}) as unknown as Dependencies['exit'];
```

### Test Harness Pattern

Create a `createHarness()` helper that wires up all mocked dependencies:

```typescript
function createHarness(overrides?: Partial<Dependencies>) {
  const exit = vi.fn((code) => {
    throw new ExitSignal(code);
  });
  const deps: Dependencies = {
    createClient: vi.fn(() => clientMock),
    exit,
    log: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
  const program = new Command();
  registerFooCommands(program, deps);
  return { program, deps, exit };
}
```

## Mocking

- Use `vi.fn()` for function mocks
- Use `vi.spyOn()` for spying on existing methods
- Mock the `Dependencies` interface, not internal modules
- Create typed client mocks implementing the command's client interface

## File Organization

- Test files are co-located with source: `foo.ts` -> `foo.test.ts`
- Integration tests in `tests/integration/`
- Run all tests: `npx vitest`

## Assertions

- Use specific matchers: `toEqual`, `toBe`, `toHaveBeenCalledWith`
- Prefer `toEqual` for object comparisons
- Use `toHaveLength` for array length checks
