# Trajectory: Fix PR #334 build errors: doctor.test.ts and Vitest workspace package resolution

> **Status:** ✅ Completed
> **Task:** PR-334
> **Confidence:** 90%
> **Started:** January 28, 2026 at 02:42 PM
> **Completed:** January 28, 2026 at 02:43 PM

---

## Summary

Fixed PR #334 build errors through multiple iterations: 1) Fixed doctor.test.ts mock closure using shared object, 2) Added Vitest resolve config for workspace packages with regex subpath support, 3) Final solution using env variable override for deterministic behavior. All tests now pass.

**Approach:** Standard approach

---

## Key Decisions

### Used shared mockAvailability object instead of direct variables for mocks
- **Chose:** Used shared mockAvailability object instead of direct variables for mocks
- **Reasoning:** vi.resetModules() clears module cache but mock factory closures weren't capturing updated variable values. Using an object ensures closures reference the same object, so property updates are immediately visible to mocks.

### Added resolve.alias configuration to vitest.config.ts for workspace packages
- **Chose:** Added resolve.alias configuration to vitest.config.ts for workspace packages
- **Reasoning:** Vitest couldn't resolve @agent-relay/* workspace packages. Added explicit aliases mapping packages to their dist/index.js files. Initially tried simple object format, then switched to array format with regex patterns for subpath support.

### Used regex-based alias patterns for workspace package subpaths
- **Chose:** Used regex-based alias patterns for workspace package subpaths
- **Reasoning:** Tests importing subpaths like @agent-relay/protocol/types, @agent-relay/config/project-namespace were failing. Added regex patterns with capture groups to dynamically map subpaths to their dist files. Pattern: /^@agent-relay\/package\/(.+)$/ -> packages/package/dist/cd /Users/khaliqgant/Projects/agent-workforce/relay && npx trail decision "Used regex-based alias patterns for workspace package subpaths" --reasoning "Tests importing subpaths like @agent-relay/protocol/types, @agent-relay/config/project-namespace were failing. Added regex patterns with capture groups to dynamically map subpaths to their dist files. Pattern: /^@agent-relay\/package\/(.+)$/ -> packages/package/dist/$1.js".js

### Switched from vi.mock() to vi.doMock() for dynamic mock application
- **Chose:** Switched from vi.mock() to vi.doMock() for dynamic mock application
- **Reasoning:** Top-level vi.mock() calls are hoisted and evaluated once, so they might not capture updated mockAvailability state after vi.resetModules(). Tried using vi.doMock() in test function to apply mocks dynamically, but this still had timing issues in CI.

### Final solution: Environment variable override instead of mocks
- **Chose:** Final solution: Environment variable override instead of mocks
- **Reasoning:** StorageDoctor identified that vi.doMock() wasn't reliably intercepting require('node:sqlite') in CI. Solution: Added AGENT_RELAY_DOCTOR_NODE_SQLITE_AVAILABLE=0 env check in checkNodeSqlite() that returns Not available before requiring the module. This bypasses mock timing issues entirely and is deterministic. Much simpler and more reliable.

---

## Chapters

### 1. Work
*Agent: default*

- Used shared mockAvailability object instead of direct variables for mocks: Used shared mockAvailability object instead of direct variables for mocks
- Added resolve.alias configuration to vitest.config.ts for workspace packages: Added resolve.alias configuration to vitest.config.ts for workspace packages
- Used regex-based alias patterns for workspace package subpaths: Used regex-based alias patterns for workspace package subpaths
- Switched from vi.mock() to vi.doMock() for dynamic mock application: Switched from vi.mock() to vi.doMock() for dynamic mock application
- Final solution: Environment variable override instead of mocks: Final solution: Environment variable override instead of mocks
