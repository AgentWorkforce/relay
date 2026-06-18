```markdown
# relay Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill teaches you the core development patterns, coding conventions, and workflows used in the `relay` TypeScript codebase. You'll learn how to structure code, write and organize tests, update dependencies, and maintain documentation, following the established practices of the project.

## Coding Conventions

- **File Naming:**  
  Use camelCase for file names.  
  _Example:_  
  ```
  myCommand.ts
  myHelperFunction.ts
  ```

- **Import Style:**  
  Use relative imports for internal modules.  
  _Example:_  
  ```typescript
  import { myHelper } from './myHelperFunction';
  ```

- **Export Style:**  
  Use named exports.  
  _Example:_  
  ```typescript
  export function myFeature() { ... }
  export const MY_CONST = 42;
  ```

- **Commit Messages:**  
  - Mixed types, often with prefixes like `style`
  - Keep messages concise (average ~32 characters)
  - _Example:_  
    ```
    style: fix spacing in cli output
    ```

## Workflows

### Feature Development or Change with Documentation and Tests
**Trigger:** When adding or modifying a feature, ensuring tests and documentation are updated  
**Command:** `/feature-change`

1. Update implementation files in `packages/cli` and/or `packages/sdk`
   - _Example:_  
     `packages/cli/src/cli/commands/myCommand.ts`
2. Update or add corresponding test files in `__tests__` directories
   - _Example:_  
     `packages/sdk/src/__tests__/myFeature.test.ts`
3. Update documentation files  
   - _Example:_  
     `web/content/docs/my-feature.mdx`
4. Update `package.json` and `package-lock.json` if dependencies or versions change
5. Update `CHANGELOG.md` to reflect the change
6. Record agentworkforce trajectory metadata  
   - _Example:_  
     `.agentworkforce/trajectories/completed/1234/summary.md`

### Code Auto-Formatting with Prettier
**Trigger:** When enforcing code style consistency across the codebase  
**Command:** `/format`

1. Run Prettier on relevant source files  
   - _Example:_  
     ```
     npx prettier --write packages/sdk/src/**/*.ts
     ```
2. Commit the auto-formatted files

### Dependency or SDK Version Update
**Trigger:** When updating a dependency or SDK version  
**Command:** `/bump-sdk`

1. Update `package.json` and `package-lock.json` with the new version
   - _Example:_  
     ```
     npm install my-dependency@latest
     ```
2. Commit the updated files
3. Optionally update agentworkforce trajectory metadata

## Testing Patterns

- **Framework:** [vitest](https://vitest.dev/)
- **Test File Pattern:** Files end with `.test.ts`
  - _Example:_  
    `myFeature.test.ts`
- **Location:**  
  - For CLI: `packages/cli/src/cli/commands/*.test.ts`
  - For SDK: `packages/sdk/src/__tests__/*.test.ts`
- **Example Test:**
  ```typescript
  import { describe, it, expect } from 'vitest';
  import { myFeature } from '../myFeature';

  describe('myFeature', () => {
    it('should return true', () => {
      expect(myFeature()).toBe(true);
    });
  });
  ```

## Commands

| Command         | Purpose                                                      |
|-----------------|--------------------------------------------------------------|
| /feature-change | Start a feature addition or modification with docs and tests |
| /format         | Auto-format codebase with Prettier                           |
| /bump-sdk       | Update dependency or SDK version                             |
```