---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
---

# Testing Conventions

## Framework

- Use Vitest for all tests
- Import from `vitest`: `describe`, `it`, `expect`, `beforeEach`, `vi`

## Test Structure

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('ClassName', () => {
  let instance: ClassName;

  beforeEach(() => {
    instance = new ClassName();
    vi.clearAllMocks();
  });

  describe('methodName', () => {
    it('should handle expected case', () => {
      // Arrange
      // Act
      // Assert
    });

    it('should handle edge case', () => {
      // ...
    });
  });
});
```

## Mocking

- Use `vi.fn()` for function mocks
- Use `vi.spyOn()` for spying on existing methods
- Create mock classes that implement required interface methods
- Name mock classes with `Mock` prefix: `MockConnection`, `MockStorage`

## Mock Pattern

```typescript
class MockConnection implements Pick<Connection, 'id' | 'send'> {
  id: string;
  sentEnvelopes: Envelope[] = [];
  sendMock = vi.fn();

  constructor(id: string) {
    this.id = id;
  }

  send(envelope: Envelope): boolean {
    this.sentEnvelopes.push(envelope);
    this.sendMock(envelope);
    return true;
  }
}
```

## Assertions

- Use specific matchers: `toEqual`, `toBe`, `toHaveBeenCalledWith`
- Prefer `toEqual` for object comparisons
- Use `toHaveLength` for array length checks
- Use `toContain` for array membership

## Async Tests

- Use `async/await` pattern
- Return promises from `it` callbacks when testing async code
- Use `vi.waitFor()` for polling assertions

## File Naming

- Test files are co-located with source: `foo.ts` -> `foo.test.ts`
- Integration tests use `.integration.test.ts` suffix
