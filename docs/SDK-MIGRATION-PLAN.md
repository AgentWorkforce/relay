# SDK Extraction: Safe TDD Migration Plan

## Guiding Principles

1. **Never break existing users** - `npm install agent-relay` must keep working
2. **Test-first** - Write/verify tests before moving any code
3. **Incremental** - Small commits, each one deployable
4. **Reversible** - Every step can be rolled back
5. **CI gates** - All tests must pass before proceeding

---

## Phase 0: Preparation (Current State Audit)

### Step 0.1: Verify Existing Test Coverage

**Status**: Tests exist for:
- [x] `src/protocol/framing.test.ts` - Frame encoding/decoding
- [x] `src/wrapper/client.test.ts` - RelayClient
- [x] `src/protocol/channels.test.ts` - Channel types
- [ ] Protocol types (need to add)
- [ ] Client spawn/release (need to add)

**Action**: Run all tests, establish baseline

```bash
npm test
# Record: X tests passing, Y coverage %
```

### Step 0.2: Document Current Public API

Files that will be extracted to SDK:
- `src/protocol/types.ts` - Protocol types
- `src/protocol/framing.ts` - Frame encoding
- `src/wrapper/client.ts` - RelayClient

Current exports from `src/index.ts`:
```typescript
// Audit what's currently exported
```

---

## Phase 1: Add Missing Tests (RED)

Before extracting anything, ensure we have comprehensive tests.

### Step 1.1: Add Protocol Types Tests

**File**: `src/protocol/types.test.ts` (new)

```typescript
import { describe, it, expect } from 'vitest';
import { PROTOCOL_VERSION, type Envelope, type MessageType } from './types.js';

describe('Protocol Types', () => {
  it('exports PROTOCOL_VERSION as 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('Envelope structure is valid', () => {
    const envelope: Envelope = {
      v: 1,
      type: 'SEND',
      id: 'test-id',
      ts: Date.now(),
      payload: { kind: 'message', body: 'hello' },
    };

    expect(envelope.v).toBe(1);
    expect(envelope.type).toBe('SEND');
  });

  it('all MessageTypes are strings', () => {
    const types: MessageType[] = [
      'HELLO', 'WELCOME', 'SEND', 'DELIVER', 'ACK', 'PING', 'PONG',
      'SPAWN', 'SPAWN_RESULT', 'RELEASE', 'RELEASE_RESULT',
    ];
    types.forEach(t => expect(typeof t).toBe('string'));
  });
});
```

### Step 1.2: Add Client Spawn/Release Tests

**File**: Update `src/wrapper/client.test.ts`

```typescript
describe('RelayClient spawn/release', () => {
  it('spawn returns promise', () => {
    const client = new RelayClient({ reconnect: false });
    // spawn() should exist and return a Promise
    expect(typeof client.spawn).toBe('function');
  });

  it('release returns promise', () => {
    const client = new RelayClient({ reconnect: false });
    expect(typeof client.release).toBe('function');
  });

  it('spawn fails when not connected', async () => {
    const client = new RelayClient({ reconnect: false });
    await expect(client.spawn({ name: 'test', cli: 'echo' }))
      .rejects.toThrow('Client not ready');
  });
});
```

### Step 1.3: Add Integration Test for SDK Contract

**File**: `src/sdk/contract.test.ts` (new)

This test verifies the public API contract that SDK consumers depend on:

```typescript
import { describe, it, expect } from 'vitest';

describe('SDK Public API Contract', () => {
  it('exports RelayClient', async () => {
    const mod = await import('../wrapper/client.js');
    expect(mod.RelayClient).toBeDefined();
    expect(typeof mod.RelayClient).toBe('function');
  });

  it('exports PROTOCOL_VERSION', async () => {
    const mod = await import('../protocol/types.js');
    expect(mod.PROTOCOL_VERSION).toBe(1);
  });

  it('exports framing functions', async () => {
    const mod = await import('../protocol/framing.js');
    expect(typeof mod.encodeFrame).toBe('function');
    expect(typeof mod.encodeFrameLegacy).toBe('function');
    expect(typeof mod.FrameParser).toBe('function');
  });

  it('RelayClient has expected methods', () => {
    const { RelayClient } = require('../wrapper/client.js');
    const client = new RelayClient({});

    // Core messaging
    expect(typeof client.connect).toBe('function');
    expect(typeof client.disconnect).toBe('function');
    expect(typeof client.sendMessage).toBe('function');
    expect(typeof client.broadcast).toBe('function');

    // Channels
    expect(typeof client.joinChannel).toBe('function');
    expect(typeof client.leaveChannel).toBe('function');
    expect(typeof client.sendChannelMessage).toBe('function');

    // Spawn/release
    expect(typeof client.spawn).toBe('function');
    expect(typeof client.release).toBe('function');
  });

  it('RelayClient has expected properties', () => {
    const { RelayClient } = require('../wrapper/client.js');
    const client = new RelayClient({ agentName: 'Test' });

    expect(client.state).toBe('DISCONNECTED');
    expect(client.agentName).toBe('Test');
  });
});
```

**Checkpoint**: All tests pass. This is our baseline.

---

## Phase 2: Setup Workspace Structure (No Code Movement Yet)

### Step 2.1: Create Workspace Root Config

**File**: `package.json` (update root)

```json
{
  "name": "agent-relay-monorepo",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "test:all": "vitest run"
  }
}
```

**WAIT**: Don't apply yet. First create the package directory.

### Step 2.2: Create SDK Package Skeleton

```bash
mkdir -p packages/sdk/src
mkdir -p packages/sdk/test
```

**File**: `packages/sdk/package.json`

```json
{
  "name": "@agent-relay/sdk",
  "version": "1.0.0",
  "description": "Lightweight SDK for Agent Relay",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {},
  "devDependencies": {
    "typescript": "^5.0.0",
    "vitest": "^2.0.0"
  }
}
```

**File**: `packages/sdk/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

**Checkpoint**: Workspace structure exists, no code moved yet.

---

## Phase 3: Copy (Not Move) SDK Code

### Step 3.1: Copy Protocol Types

```bash
cp src/protocol/types.ts packages/sdk/src/protocol.ts
cp src/protocol/framing.ts packages/sdk/src/framing.ts
```

**Edit** `packages/sdk/src/protocol.ts`:
- Remove imports not needed by SDK
- Keep only types needed for messaging

### Step 3.2: Copy RelayClient (Minimal Version)

Create `packages/sdk/src/client.ts` with ONLY:
- Connection handling
- Message send/receive
- Channels (optional)
- Spawn/release (optional)

**Remove**:
- Dashboard-specific code
- Heavy dependencies

### Step 3.3: Create SDK Entry Point

**File**: `packages/sdk/src/index.ts`

```typescript
// Core client
export { RelayClient } from './client.js';
export type { ClientConfig, ClientState } from './client.js';

// Protocol
export { PROTOCOL_VERSION } from './protocol.js';
export type {
  Envelope,
  MessageType,
  PayloadKind,
  SendPayload,
  DeliverEnvelope,
} from './protocol.js';

// Framing (for advanced users)
export { encodeFrame, encodeFrameLegacy, FrameParser } from './framing.js';
```

### Step 3.4: Copy and Adapt Tests

```bash
cp src/protocol/framing.test.ts packages/sdk/test/framing.test.ts
cp src/wrapper/client.test.ts packages/sdk/test/client.test.ts
```

Update imports in test files to use relative paths.

**Checkpoint**: SDK package has its own code and tests. Original code unchanged.

---

## Phase 4: Verify SDK Works Independently

### Step 4.1: Build SDK Package

```bash
cd packages/sdk
npm install
npm run build
npm test
```

**Gate**: All SDK tests must pass independently.

### Step 4.2: Test SDK in Isolation

Create a test script outside the monorepo:

```bash
mkdir /tmp/sdk-test
cd /tmp/sdk-test
npm init -y
npm install /path/to/agent-relay/packages/sdk
```

```typescript
// test.ts
import { RelayClient, PROTOCOL_VERSION } from '@agent-relay/sdk';

console.log('Protocol version:', PROTOCOL_VERSION);
const client = new RelayClient({ agentName: 'Test' });
console.log('Client state:', client.state);
console.log('✓ SDK works independently');
```

**Gate**: SDK works when installed as a package.

---

## Phase 5: Wire Up Main Package to Use SDK

### Step 5.1: Add SDK as Workspace Dependency

**File**: `package.json` (main package)

```json
{
  "dependencies": {
    "@agent-relay/sdk": "workspace:*"
  }
}
```

### Step 5.2: Re-export SDK from Main Package

**File**: `src/sdk.ts` (new)

```typescript
// Re-export everything from SDK for backwards compatibility
export * from '@agent-relay/sdk';
```

**File**: `src/index.ts` (update)

```typescript
// Backwards compatible: re-export SDK types
export {
  RelayClient,
  PROTOCOL_VERSION,
  type Envelope,
  type ClientConfig,
} from '@agent-relay/sdk';

// Plus all existing exports...
```

### Step 5.3: Run ALL Tests

```bash
npm test  # Root level - runs all workspace tests
```

**Gate**: ALL existing tests must still pass.

---

## Phase 6: Remove Duplicated Code

### Step 6.1: Update Original Files to Import from SDK

**File**: `src/wrapper/client.ts`

```typescript
// Before:
// Full implementation here

// After:
export { RelayClient, type ClientConfig, type ClientState } from '@agent-relay/sdk';
```

**Incremental**: Do one file at a time, run tests after each.

### Step 6.2: Deprecation Notices

Add JSDoc deprecation notices to old import paths:

```typescript
/**
 * @deprecated Import from '@agent-relay/sdk' instead
 */
export { RelayClient } from '@agent-relay/sdk';
```

---

## Phase 7: Publish SDK

### Step 7.1: Version and Publish

```bash
cd packages/sdk
npm version 1.0.0
npm publish --access public
```

### Step 7.2: Update Documentation

- README: Add SDK installation instructions
- MIGRATION.md: Guide for existing users

---

## Safety Gates Summary

| Gate | Criteria | Blocking |
|------|----------|----------|
| G1 | All existing tests pass | Yes |
| G2 | SDK tests pass independently | Yes |
| G3 | SDK installs cleanly in isolation | Yes |
| G4 | Main package tests pass with SDK dependency | Yes |
| G5 | Integration tests pass | Yes |
| G6 | Backwards compatibility verified | Yes |

## Rollback Plan

At any point, if tests fail:

1. `git stash` or `git checkout .`
2. Remove `packages/sdk/` directory
3. Revert `package.json` workspace changes
4. Original code remains untouched

---

## Timeline Estimate

| Phase | Effort | Risk |
|-------|--------|------|
| Phase 0: Audit | Low | None |
| Phase 1: Add tests | Medium | None |
| Phase 2: Workspace setup | Low | None |
| Phase 3: Copy code | Medium | Low |
| Phase 4: Verify SDK | Medium | Low |
| Phase 5: Wire up | Medium | Medium |
| Phase 6: Remove duplication | Low | Low |
| Phase 7: Publish | Low | None |

**Total**: ~4-6 focused work sessions

---

## Checklist Before Each Commit

- [ ] All tests pass locally
- [ ] No breaking changes to public API
- [ ] TypeScript compiles without errors
- [ ] Lint passes
- [ ] Can rollback to previous commit

## Checklist Before Publishing SDK

- [ ] All tests pass
- [ ] Package installs cleanly
- [ ] Works in isolation test
- [ ] README is accurate
- [ ] CHANGELOG updated
- [ ] Version number is correct
