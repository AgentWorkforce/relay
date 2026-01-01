# TypeScript Conventions

This rule applies globally to all TypeScript files.

## Module System

- Use ES modules exclusively
- Import Node.js built-ins with `node:` prefix: `import net from 'node:net'`
- Use `.js` extension in imports (TypeScript compiles to JS): `import { foo } from './bar.js'`

## Type Imports

- Use `type` keyword for type-only imports: `import type { Envelope } from './types.js'`
- Combine type and value imports when needed:
  ```typescript
  import { encodeFrame, type Envelope } from './protocol.js';
  ```

## Interface vs Type

- Use `interface` for object shapes that may be extended
- Use `type` for unions, intersections, and function types
- Export interfaces/types that are used across modules

## Naming

- Interfaces: PascalCase, no `I` prefix
- Types: PascalCase
- Enums: PascalCase with UPPER_CASE values
- Constants: UPPER_CASE for module-level, camelCase for local

## Error Handling

- Type errors as `Error` in catch blocks: `catch (err: Error)`
- Use optional chaining for error message access: `err?.message`
- Prefer explicit error types over `any`

## Async/Await

- Prefer `async/await` over raw promises
- Use `promisify` from `node:util` for callback-based APIs
- Handle rejections with try/catch

## Configuration

- Strict mode is enabled
- Use `Record<string, T>` for object maps
- Avoid `any`, prefer `unknown` for truly unknown types

## Documentation

- Use JSDoc for exported functions and classes
- Include `@param` and `@returns` for public APIs
- Document complex types with examples

## Example

```typescript
import type { Config } from './types.js';
import { readFile } from 'node:fs/promises';

export interface ServiceOptions {
  name: string;
  timeout?: number;
}

/**
 * Create a new service instance.
 * @param options - Service configuration
 * @returns Configured service
 */
export function createService(options: ServiceOptions): Service {
  // Implementation
}
```
