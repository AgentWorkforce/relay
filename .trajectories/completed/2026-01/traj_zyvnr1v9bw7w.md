# Trajectory: Fix socketPath not passed to spawned agents

> **Status:** ✅ Completed
> **Task:** sdk-consumer-issue
> **Confidence:** 90%
> **Started:** January 23, 2026 at 11:31 PM
> **Completed:** January 23, 2026 at 11:32 PM

---

## Summary

Fixed socketPath propagation from SpawnManager to AgentSpawner. SDK consumers spawn agents that now connect to the correct daemon socket. Cloud was unaffected due to container isolation with default paths.

**Approach:** Standard approach

---

## Key Decisions

### Confirmed consumer's root cause analysis: SpawnManager ignores socketPath config
- **Chose:** Confirmed consumer's root cause analysis: SpawnManager ignores socketPath config
- **Reasoning:** SpawnManager line 48 only passed projectRoot to AgentSpawner, ignoring the socketPath from config. This caused spawned agents to derive their own socket paths which could differ from the daemon's actual location.

### Cloud works due to container isolation with default socket path
- **Chose:** Cloud works due to container isolation with default socket path
- **Reasoning:** In cloud, each workspace runs in its own container with daemon at /tmp/agent-relay.sock (default). Even without explicit socketPath, the fallback matches the actual daemon location. SDK consumers use project-specific paths like {projectRoot}/.agent-relay/relay.sock, so the fallback fails.

### Fixed by adding socketPath to AgentSpawnerOptions and updating SpawnManager
- **Chose:** Fixed by adding socketPath to AgentSpawnerOptions and updating SpawnManager
- **Reasoning:** Two changes: 1) Added socketPath?: string to AgentSpawnerOptions interface in spawner.ts with fallback: this.socketPath = options.socketPath ?? paths.socketPath. 2) Updated SpawnManager constructor to pass socketPath: new AgentSpawner({ projectRoot: config.projectRoot, socketPath: config.socketPath })

### Clarified two socket types in relay-pty architecture
- **Chose:** Clarified two socket types in relay-pty architecture
- **Reasoning:** Consumer identified two sockets: 1) config.socketPath (BaseWrapperConfig) - daemon socket for RelayClient message routing. 2) this.socketPath (RelayPtyOrchestrator) - relay-pty injection socket at {workspace}/sockets/{agent}.sock for PTY message injection. The fix addresses the daemon socket path propagation.

---

## Chapters

### 1. Work
*Agent: default*

- Confirmed consumer's root cause analysis: SpawnManager ignores socketPath config: Confirmed consumer's root cause analysis: SpawnManager ignores socketPath config
- Cloud works due to container isolation with default socket path: Cloud works due to container isolation with default socket path
- Fixed by adding socketPath to AgentSpawnerOptions and updating SpawnManager: Fixed by adding socketPath to AgentSpawnerOptions and updating SpawnManager
- Clarified two socket types in relay-pty architecture: Clarified two socket types in relay-pty architecture
