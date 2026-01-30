# Agent Relay SDK - Consolidated Friction Report

**Date:** 2026-01-30
**SDK Version:** 2.1.5
**Projects Integrated:** Auto-Claude, vibe-kanban, code (Every Code), Maestro

---

## Executive Summary

Four parallel integration agents tested the `@agent-relay/sdk` against diverse multi-agent orchestration tools. The SDK demonstrated solid core functionality with clean TypeScript APIs, but several friction points emerged that would improve the developer experience.

**Overall SDK Rating:** 6.5/10 (Good foundation, room for improvement)

---

## Critical Friction Points

### 1. Browser Incompatibility (vibe-kanban)

| Severity | Critical |
|----------|----------|
| Impact | SDK cannot be used in browser-based frontends |

**Problem:** The SDK uses `node:net` for Unix socket communication, making it incompatible with browser environments.

```typescript
// In @agent-relay/sdk
import net from 'node:net';  // Not available in browsers!
```

**Workaround:** Run relay client in Node.js backend, Tauri sidecar, or separate Node process.

**Recommendation:** Add WebSocket transport option or create `@agent-relay/sdk-browser` package.

---

### 2. No Python SDK (Auto-Claude)

| Severity | High |
|----------|------|
| Impact | Python-based agent systems cannot integrate directly |

**Problem:** Auto-Claude's backend is Python. The SDK only provides TypeScript/Node.js client.

**Workaround:** Use Electron main process as proxy coordinator.

**Recommendation:** Provide Python SDK (`pip install agent-relay`) with equivalent API.

---

### 3. No Request/Response (RPC) Pattern (code)

| Severity | High |
|----------|------|
| Impact | Developers must manually implement task correlation |

**Problem:** No built-in way to correlate delegated tasks with their responses.

**Workaround:** Implemented manual task ID tracking:
```typescript
const taskId = 'task-' + Date.now() + '-' + Math.random().toString(36).slice(2);
client.sendMessage(target, task, 'action', { taskId });
// ...later check payload.data?.taskId in onMessage
```

**Recommendation:** Add native request/response pattern:
```typescript
const response = await client.request('Worker', 'Do task', { timeout: 30000 });
```

---

### 4. No Electron-Specific Guidance (Maestro)

| Severity | High |
|----------|------|
| Impact | Electron app developers must figure out architecture themselves |

**Problem:** Electron apps have unique requirements:
- Main process vs renderer process communication
- Preload script security model
- IPC for exposing relay functionality to UI

**Recommendation:** Add Electron integration guide showing:
- Main process setup
- Preload script exposure patterns
- Renderer-safe API wrapper

---

## Medium Friction Points

### 5. Spawn Readiness Detection (code, vibe-kanban)

**Problem:** `spawn()` returns `{ success: true }` immediately, but the agent may not be ready to receive messages yet.

**Workaround:** Added arbitrary delay after spawning:
```typescript
await client.spawn({ name: 'Worker', cli: 'claude', task: '...' });
await sleep(2000); // Hope it's ready
```

**Recommendation:** Either:
- Return Promise that resolves when agent connects
- Provide `onAgentReady(name)` callback
- Include estimated startup time in spawn result

---

### 6. Channel vs Direct Message Distinction (code, vibe-kanban)

**Problem:** In `onMessage`, must check `originalTo` parameter to detect channel messages. This is non-obvious.

```typescript
client.onMessage = (from, payload, id, meta, originalTo) => {
  const isChannel = originalTo?.startsWith('#');  // Not intuitive
};
```

**Recommendation:** Add explicit `onChannelMessage` callback or include `messageType: 'channel' | 'direct'` in payload.

---

### 7. Socket Path Configuration (All Projects)

**Problem:** Default socket path `/tmp/agent-relay.sock` is Unix-specific. Windows needs different handling.

**Recommendation:**
- Auto-detect platform and use appropriate default
- Support `AGENT_RELAY_SOCKET` environment variable
- Document multi-instance socket configuration

---

### 8. No Message Type System (vibe-kanban)

**Problem:** Messages are free-form strings requiring manual JSON parsing.

**Recommendation:** Add typed message helpers:
```typescript
client.onTypedMessage<TaskUpdate>('task:*', (update) => {
  console.log(update.taskId); // Typed!
});
```

---

### 9. Missing Integration Patterns (code)

**Problem:** SDK README covers basic messaging but lacks guidance for:
- Coordinator/worker patterns
- Task delegation with correlation
- Fan-out/fan-in patterns
- Error propagation strategies

**Recommendation:** Add "Integration Patterns" guide with common multi-agent scenarios.

---

### 10. Graceful Degradation Not Documented (Maestro, Auto-Claude)

**Problem:** No examples for handling SDK being unavailable.

**Recommendation:** Document optional integration pattern:
```typescript
let RelayClient: typeof import('@agent-relay/sdk').RelayClient | null = null;
try {
  const sdk = await import('@agent-relay/sdk');
  RelayClient = sdk.RelayClient;
} catch {
  // SDK not installed, relay features disabled
}
```

---

## Low Friction Points

### 11. Error Types Not Exported (Maestro)

```typescript
// Cannot do type-safe error handling
import { RelayConnectionError } from '@agent-relay/sdk'; // Does not exist
```

### 12. No Batch Operations (Maestro, code)

Must call `sendMessage()` individually for each target.

### 13. No React/Framework Adapter (vibe-kanban)

Had to create ~300 LOC of custom React context and hooks.

### 14. Lifecycle Documentation (Maestro)

When to call `disconnect()` vs `destroy()` isn't immediately clear.

### 15. State Change Granularity (code)

`onStateChange` doesn't distinguish clean disconnect vs error vs reconnecting.

---

## Recommended Improvements by Priority

### Priority 1 (High Impact, Should Fix)

| # | Improvement | Affected Projects |
|---|-------------|-------------------|
| 1 | Add WebSocket/browser transport | vibe-kanban |
| 2 | Python SDK | Auto-Claude |
| 3 | Native RPC pattern | code |
| 4 | Electron integration guide | Maestro |
| 5 | Spawn readiness detection | code, vibe-kanban |

### Priority 2 (Medium Impact)

| # | Improvement | Affected Projects |
|---|-------------|-------------------|
| 6 | Separate `onChannelMessage` callback | code, vibe-kanban |
| 7 | Platform-aware socket paths | All |
| 8 | Typed message system | vibe-kanban |
| 9 | Integration patterns guide | code |
| 10 | Graceful degradation docs | Maestro, Auto-Claude |

### Priority 3 (Low Impact, Nice to Have)

| # | Improvement | Affected Projects |
|---|-------------|-------------------|
| 11 | Export error types | Maestro |
| 12 | Batch message operations | Maestro, code |
| 13 | React adapter package | vibe-kanban |
| 14 | Lifecycle documentation | Maestro |
| 15 | Granular state changes | code |

---

## What Worked Well

1. **Clean TypeScript API** - Well-typed interfaces, excellent IntelliSense
2. **Dynamic Import Support** - Enables optional integrations
3. **Comprehensive Feature Set** - Messaging, spawning, channels, health monitoring
4. **Event-Driven Architecture** - Callback system integrates well with Node.js
5. **Auto-Reconnection** - Built-in reconnection with configurable backoff
6. **Agent Discovery** - `listAgents()` provides useful presence information

---

## Integration Metrics

| Project | LOC Written | Files Created | Integration Time | Rating |
|---------|-------------|---------------|------------------|--------|
| Auto-Claude | ~800 | 7 | ~3 hours | 6/10 |
| vibe-kanban | ~850 | 7 | ~3 hours | 6/10 |
| code | ~600 | 5 | ~2 hours | 5/10 |
| Maestro | ~800 | 6 | ~2.5 hours | 7/10 |

---

## Conclusion

The `@agent-relay/sdk` provides a solid foundation for agent-to-agent communication. The core messaging API is clean and intuitive. The main friction points are:

1. **Platform limitations** (browser, Python)
2. **Higher-level patterns** (RPC, typed messages)
3. **Documentation gaps** (Electron, patterns, graceful degradation)

Addressing the Priority 1 items would significantly improve the integration experience and enable the SDK to be "best in class" for multi-agent orchestration.

---

*Report generated from 4 parallel integration agents*
