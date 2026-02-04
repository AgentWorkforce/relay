# Changelog

All notable changes to `@agent-relay/mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking Changes

- **Client module restructure**: `src/client.ts` has been deleted and replaced by `src/client-adapter.ts`
  - Main package exports (`@agent-relay/mcp`) are unchanged
  - Direct file imports need to be updated:
    ```typescript
    // OLD (no longer works):
    import { createRelayClient } from '@agent-relay/mcp/src/client.js';

    // NEW (recommended):
    import { createRelayClient } from '@agent-relay/mcp';

    // NEW (alternative):
    import { createRelayClient } from '@agent-relay/mcp/src/client-adapter.js';
    ```

### Changed

- Refactored client implementation into `client-adapter.ts` for better maintainability
