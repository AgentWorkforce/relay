# OpenCode Server Integration Specification

## Executive Summary

This spec defines how Agent Relay integrates with [OpenCode Server](https://opencode.ai/docs/server/) to provide an alternative agent backend that offers:

1. **HTTP API-based agent control** instead of PTY-based terminal emulation
2. **Session forking** for context inheritance between parent/child agents
3. **Structured event streaming** via SSE instead of terminal output parsing
4. **mDNS discovery** for multi-host coordination without cloud infrastructure

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Agent Relay Daemon                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────┐     ┌────────────────┐     ┌────────────────┐           │
│  │  AgentSpawner  │────▶│ WrapperFactory │────▶│ PtyWrapper     │           │
│  │                │     │                │     │ (existing)     │           │
│  │ spawn()        │     │ createWrapper()│     ├────────────────┤           │
│  │ release()      │     │                │────▶│ OpenCodeWrapper│ ◀── NEW   │
│  └────────────────┘     └────────────────┘     │ (new)          │           │
│         │                                       └───────┬────────┘           │
│         │                                               │                    │
│         ▼                                               ▼                    │
│  ┌────────────────┐                          ┌─────────────────────┐        │
│  │ RelayClient    │◀─────────────────────────│ OpenCode SDK        │        │
│  │ (Unix socket)  │                          │ @opencode-ai/sdk    │        │
│  └────────────────┘                          └──────────┬──────────┘        │
│                                                         │                    │
└─────────────────────────────────────────────────────────│────────────────────┘
                                                          │
                                                          ▼
                                              ┌─────────────────────┐
                                              │  OpenCode Server    │
                                              │  (localhost:4096)   │
                                              │                     │
                                              │  POST /session      │
                                              │  POST /session/:id/ │
                                              │       message       │
                                              │  GET /event (SSE)   │
                                              └─────────────────────┘
```

## Component Specifications

### 1. OpenCodeWrapper

**File:** `src/wrapper/opencode-wrapper.ts`

A new wrapper class that extends `BaseWrapper` and uses OpenCode's HTTP API instead of node-pty.

```typescript
import { BaseWrapper, BaseWrapperConfig } from './base-wrapper.js';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';

export interface OpenCodeWrapperConfig extends BaseWrapperConfig {
  /** OpenCode server base URL (default: http://localhost:4096) */
  serverUrl?: string;
  /** Session ID to fork from (for child agents) */
  forkFromSession?: string;
  /** Model override (if supported by OpenCode server) */
  model?: string;
  /** Project directory (required by OpenCode) */
  projectDir: string;
}

export interface OpenCodeWrapperEvents {
  output: (data: string) => void;
  exit: (code: number) => void;
  error: (error: Error) => void;
  'session-created': (sessionId: string) => void;
  'message-sent': (messageId: string) => void;
}

export class OpenCodeWrapper extends BaseWrapper {
  private client: OpencodeClient;
  private sessionId?: string;
  private eventSource?: EventSource;
  private outputBuffer: string[] = [];

  constructor(config: OpenCodeWrapperConfig) {
    super(config);
    this.client = createOpencodeClient({
      baseUrl: config.serverUrl ?? 'http://localhost:4096'
    });
  }

  // =========================================================================
  // Abstract method implementations (required by BaseWrapper)
  // =========================================================================

  async start(): Promise<void> {
    // 1. Create or fork session
    if (this.config.forkFromSession) {
      // Fork from parent session (inherits context)
      this.sessionId = await this.forkSession(this.config.forkFromSession);
    } else {
      // Create new session
      this.sessionId = await this.createSession();
    }

    this.emit('session-created', this.sessionId);
    this.running = true;

    // 2. Connect to relay daemon
    await this.client.connect();

    // 3. Start event streaming
    this.startEventStream();

    // 4. Send initial task if provided
    if (this.config.task) {
      await this.sendTask(this.config.task);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopEventStream();

    // Graceful session close (agent can save state)
    if (this.sessionId) {
      await this.client.session.abort(this.sessionId);
    }

    this.destroyClient();
  }

  protected async performInjection(content: string): Promise<void> {
    if (!this.sessionId) {
      throw new Error('No active session');
    }

    // Send message via OpenCode API
    await this.client.message.send(this.sessionId, {
      content,
      directory: this.config.projectDir,
    });
  }

  protected getCleanOutput(): string {
    return this.outputBuffer.join('\n');
  }

  // =========================================================================
  // OpenCode-specific methods
  // =========================================================================

  private async createSession(): Promise<string> {
    const session = await this.client.session.create({
      directory: this.config.projectDir,
    });
    return session.id;
  }

  private async forkSession(parentId: string): Promise<string> {
    // OpenCode's session sharing/fork API
    const forked = await this.client.session.fork(parentId);
    return forked.id;
  }

  private startEventStream(): void {
    const url = `${this.config.serverUrl ?? 'http://localhost:4096'}/event`;
    this.eventSource = new EventSource(url);

    this.eventSource.onmessage = (event) => {
      this.handleServerEvent(JSON.parse(event.data));
    };

    this.eventSource.onerror = (error) => {
      this.emit('error', new Error('Event stream error'));
    };
  }

  private stopEventStream(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = undefined;
    }
  }

  private handleServerEvent(event: OpenCodeEvent): void {
    switch (event.type) {
      case 'message':
        // Agent output - emit and buffer
        this.outputBuffer.push(event.content);
        this.emit('output', event.content);

        // Parse for relay commands (->relay: patterns)
        this.parseRelayCommands();
        break;

      case 'session.end':
        this.running = false;
        this.emit('exit', 0);
        break;

      case 'error':
        this.emit('error', new Error(event.message));
        break;
    }
  }

  private async sendTask(task: string): Promise<void> {
    if (!this.sessionId) return;

    await this.client.message.send(this.sessionId, {
      content: task,
      directory: this.config.projectDir,
    });
  }

  // =========================================================================
  // Public API extensions
  // =========================================================================

  /** Get the OpenCode session ID */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Fork this agent's session for a child agent */
  async forkForChild(): Promise<string> {
    if (!this.sessionId) {
      throw new Error('No active session to fork');
    }
    return this.forkSession(this.sessionId);
  }
}
```

### 2. WrapperFactory

**File:** `src/wrapper/factory.ts`

A factory that selects the appropriate wrapper based on CLI type and configuration.

```typescript
import { BaseWrapper, BaseWrapperConfig } from './base-wrapper.js';
import { PtyWrapper, PtyWrapperConfig } from './pty-wrapper.js';
import { OpenCodeWrapper, OpenCodeWrapperConfig } from './opencode-wrapper.js';

export type WrapperType = 'pty' | 'opencode' | 'auto';

export interface WrapperFactoryConfig {
  /** Preferred wrapper type (default: 'auto') */
  preferredType?: WrapperType;
  /** OpenCode server URL (for opencode wrapper) */
  opencodeServerUrl?: string;
  /** Whether to probe for OpenCode server availability */
  probeOpenCode?: boolean;
}

export class WrapperFactory {
  private config: WrapperFactoryConfig;
  private opencodeAvailable?: boolean;

  constructor(config: WrapperFactoryConfig = {}) {
    this.config = config;
  }

  /**
   * Create appropriate wrapper for the given agent configuration
   */
  async createWrapper(
    agentConfig: BaseWrapperConfig & Partial<OpenCodeWrapperConfig>
  ): Promise<BaseWrapper> {
    const wrapperType = await this.selectWrapperType(agentConfig);

    switch (wrapperType) {
      case 'opencode':
        return new OpenCodeWrapper({
          ...agentConfig,
          serverUrl: this.config.opencodeServerUrl,
          projectDir: agentConfig.cwd ?? process.cwd(),
        } as OpenCodeWrapperConfig);

      case 'pty':
      default:
        return new PtyWrapper(agentConfig as PtyWrapperConfig);
    }
  }

  /**
   * Select wrapper type based on config, CLI type, and server availability
   */
  private async selectWrapperType(
    agentConfig: BaseWrapperConfig
  ): Promise<WrapperType> {
    // Explicit preference
    if (this.config.preferredType === 'pty') return 'pty';
    if (this.config.preferredType === 'opencode') return 'opencode';

    // Auto-select based on CLI
    const cli = agentConfig.command.toLowerCase();

    // OpenCode native CLIs use OpenCode wrapper when server available
    if (cli === 'opencode') {
      if (await this.isOpenCodeAvailable()) {
        return 'opencode';
      }
    }

    // Default to PTY for all other cases
    return 'pty';
  }

  /**
   * Check if OpenCode server is available (cached)
   */
  private async isOpenCodeAvailable(): Promise<boolean> {
    if (this.opencodeAvailable !== undefined) {
      return this.opencodeAvailable;
    }

    if (!this.config.probeOpenCode) {
      this.opencodeAvailable = false;
      return false;
    }

    try {
      const url = this.config.opencodeServerUrl ?? 'http://localhost:4096';
      const response = await fetch(`${url}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      this.opencodeAvailable = response.ok;
    } catch {
      this.opencodeAvailable = false;
    }

    return this.opencodeAvailable;
  }
}
```

### 3. OpenCodeSpawner

**File:** `src/bridge/opencode-spawner.ts`

Extended spawner that supports OpenCode sessions with context inheritance.

```typescript
import { AgentSpawner, SpawnRequest, SpawnResult } from './spawner.js';
import { WrapperFactory, WrapperType } from '../wrapper/factory.js';
import { OpenCodeWrapper } from '../wrapper/opencode-wrapper.js';

export interface OpenCodeSpawnRequest extends SpawnRequest {
  /** Inherit context from parent session */
  inheritFromSession?: string;
  /** Wrapper type preference */
  wrapperType?: WrapperType;
}

export class OpenCodeSpawner extends AgentSpawner {
  private wrapperFactory: WrapperFactory;
  private sessionRegistry: Map<string, string> = new Map(); // agentName -> sessionId

  constructor(
    projectRoot: string,
    tmuxSession?: string,
    dashboardPort?: number,
    opencodeConfig?: { serverUrl?: string; probeOpenCode?: boolean }
  ) {
    super(projectRoot, tmuxSession, dashboardPort);

    this.wrapperFactory = new WrapperFactory({
      opencodeServerUrl: opencodeConfig?.serverUrl,
      probeOpenCode: opencodeConfig?.probeOpenCode ?? true,
    });
  }

  /**
   * Spawn agent with optional session inheritance
   */
  async spawnWithContext(request: OpenCodeSpawnRequest): Promise<SpawnResult> {
    // If inheriting from parent, get the parent's session ID
    let forkFromSession: string | undefined;

    if (request.inheritFromSession) {
      forkFromSession = this.sessionRegistry.get(request.inheritFromSession);
      if (!forkFromSession) {
        console.warn(
          `[opencode-spawner] Parent session not found for ${request.inheritFromSession}`
        );
      }
    }

    // Create wrapper via factory
    const wrapper = await this.wrapperFactory.createWrapper({
      name: request.name,
      command: request.cli,
      task: request.task,
      cwd: request.cwd ?? this.projectRoot,
      socketPath: this.socketPath,
      forkFromSession,
    });

    // Track OpenCode session IDs
    if (wrapper instanceof OpenCodeWrapper) {
      wrapper.on('session-created', (sessionId) => {
        this.sessionRegistry.set(request.name, sessionId);
        console.log(
          `[opencode-spawner] Registered session ${sessionId} for ${request.name}`
        );
      });
    }

    // Use base class spawn logic for lifecycle management
    return this.spawn(request);
  }

  /**
   * Get session ID for an agent (for forking)
   */
  getSessionId(agentName: string): string | undefined {
    return this.sessionRegistry.get(agentName);
  }

  /**
   * Release agent and clean up session registry
   */
  async release(name: string): Promise<boolean> {
    this.sessionRegistry.delete(name);
    return super.release(name);
  }
}
```

### 4. OpenCode Discovery Service

**File:** `src/discovery/opencode-discovery.ts`

mDNS-based discovery for OpenCode servers on the network.

```typescript
import { createMdnsBrowser, type MdnsService } from 'mdns-js'; // or similar

export interface DiscoveredServer {
  id: string;
  name: string;
  host: string;
  port: number;
  projectPath?: string;
  lastSeen: number;
}

export interface DiscoveryEvents {
  'server-found': (server: DiscoveredServer) => void;
  'server-lost': (serverId: string) => void;
}

export class OpenCodeDiscovery extends EventEmitter {
  private browser?: any;
  private servers: Map<string, DiscoveredServer> = new Map();
  private cleanupInterval?: NodeJS.Timer;

  /**
   * Start discovering OpenCode servers on the network
   */
  start(): void {
    // OpenCode advertises via mDNS when started with --mdns flag
    this.browser = createMdnsBrowser('_opencode._tcp');

    this.browser.on('serviceUp', (service: MdnsService) => {
      const server: DiscoveredServer = {
        id: service.fullname,
        name: service.name,
        host: service.addresses[0],
        port: service.port,
        projectPath: service.txt?.projectPath,
        lastSeen: Date.now(),
      };

      this.servers.set(server.id, server);
      this.emit('server-found', server);
    });

    this.browser.on('serviceDown', (service: MdnsService) => {
      this.servers.delete(service.fullname);
      this.emit('server-lost', service.fullname);
    });

    this.browser.start();

    // Cleanup stale servers every 30s
    this.cleanupInterval = setInterval(() => this.cleanupStale(), 30000);
  }

  /**
   * Stop discovery
   */
  stop(): void {
    if (this.browser) {
      this.browser.stop();
      this.browser = undefined;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  /**
   * Get all discovered servers
   */
  getServers(): DiscoveredServer[] {
    return Array.from(this.servers.values());
  }

  /**
   * Get server by project path
   */
  findByProject(projectPath: string): DiscoveredServer | undefined {
    for (const server of this.servers.values()) {
      if (server.projectPath === projectPath) {
        return server;
      }
    }
    return undefined;
  }

  private cleanupStale(): void {
    const staleThreshold = Date.now() - 60000; // 60s
    for (const [id, server] of this.servers) {
      if (server.lastSeen < staleThreshold) {
        this.servers.delete(id);
        this.emit('server-lost', id);
      }
    }
  }
}
```

### 5. Dashboard API Extensions

**File:** `src/dashboard-server/routes/opencode.ts`

New API routes for OpenCode-specific functionality.

```typescript
import { Router } from 'express';
import { OpenCodeSpawner } from '../../bridge/opencode-spawner.js';
import { OpenCodeDiscovery } from '../../discovery/opencode-discovery.js';

export function createOpenCodeRoutes(
  spawner: OpenCodeSpawner,
  discovery: OpenCodeDiscovery
): Router {
  const router = Router();

  /**
   * GET /api/opencode/servers
   * List discovered OpenCode servers on the network
   */
  router.get('/servers', (_req, res) => {
    const servers = discovery.getServers();
    res.json({ servers });
  });

  /**
   * POST /api/opencode/spawn
   * Spawn agent with OpenCode backend and optional context inheritance
   */
  router.post('/spawn', async (req, res) => {
    const { name, cli, task, inheritFrom, wrapperType } = req.body;

    try {
      const result = await spawner.spawnWithContext({
        name,
        cli: cli ?? 'opencode',
        task,
        inheritFromSession: inheritFrom,
        wrapperType,
      });

      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * GET /api/opencode/sessions/:name
   * Get OpenCode session info for an agent
   */
  router.get('/sessions/:name', (req, res) => {
    const sessionId = spawner.getSessionId(req.params.name);
    if (!sessionId) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json({ sessionId, agentName: req.params.name });
  });

  /**
   * POST /api/opencode/fork/:name
   * Fork an agent's session for a child agent
   */
  router.post('/fork/:name', async (req, res) => {
    const { childName, task } = req.body;
    const parentSession = spawner.getSessionId(req.params.name);

    if (!parentSession) {
      return res.status(404).json({ error: 'Parent session not found' });
    }

    try {
      const result = await spawner.spawnWithContext({
        name: childName,
        cli: 'opencode',
        task,
        inheritFromSession: req.params.name,
      });

      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  return router;
}
```

## Integration Points

### 1. Spawner Integration

Modify `AgentSpawner` to optionally use `WrapperFactory`:

```typescript
// src/bridge/spawner.ts

export class AgentSpawner {
  private wrapperFactory?: WrapperFactory;

  // Option to enable OpenCode integration
  enableOpenCode(config?: { serverUrl?: string }): void {
    this.wrapperFactory = new WrapperFactory({
      opencodeServerUrl: config?.serverUrl,
      probeOpenCode: true,
    });
  }

  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    // ... existing validation ...

    // Use factory if available, otherwise default to PtyWrapper
    let wrapper: BaseWrapper;
    if (this.wrapperFactory) {
      wrapper = await this.wrapperFactory.createWrapper({
        name: request.name,
        command: request.cli,
        // ... rest of config
      });
    } else {
      wrapper = new PtyWrapper(/* ... */);
    }

    // ... rest of spawn logic ...
  }
}
```

### 2. CLI Integration

Add `--opencode` flag to agent-relay CLI:

```typescript
// src/cli/index.ts

program
  .option('--opencode [url]', 'Enable OpenCode server integration')
  .option('--opencode-discover', 'Enable mDNS discovery for OpenCode servers');

// In daemon startup:
if (options.opencode) {
  const serverUrl = typeof options.opencode === 'string'
    ? options.opencode
    : 'http://localhost:4096';
  spawner.enableOpenCode({ serverUrl });
}

if (options.opencodeDiscover) {
  const discovery = new OpenCodeDiscovery();
  discovery.start();
  // Register routes...
}
```

### 3. Relay Protocol Extensions

Add new message types for OpenCode-specific features:

```typescript
// src/protocol/types.ts

// New payload types
export interface SessionForkPayload {
  parentSession: string;
  childAgent: string;
  task?: string;
}

export interface SessionInfoPayload {
  sessionId: string;
  agentName: string;
  wrapperType: 'pty' | 'opencode';
  serverUrl?: string;
}

// Extended HELLO payload
export interface HelloPayload {
  // ... existing fields ...

  /** OpenCode session ID (if using OpenCode wrapper) */
  opencodeSession?: string;
  /** Wrapper type being used */
  wrapperType?: 'pty' | 'opencode';
}
```

## Data Flow

### Session Creation Flow

```
1. User/Agent requests spawn with inheritFrom=ParentAgent
       │
       ▼
2. OpenCodeSpawner.spawnWithContext()
       │
       ├──▶ Look up parent's sessionId from registry
       │
       ▼
3. WrapperFactory.createWrapper()
       │
       ├──▶ Select wrapper type (opencode if server available)
       │
       ▼
4. OpenCodeWrapper.start()
       │
       ├──▶ POST /session/fork with parent sessionId
       │    (inherits conversation context)
       │
       ├──▶ Connect to relay daemon (RelayClient)
       │
       ├──▶ Start SSE event stream (/event)
       │
       ▼
5. Agent ready with inherited context
```

### Message Flow

```
Agent Output (via SSE)             Relay Message (via Unix socket)
        │                                    │
        ▼                                    ▼
  handleServerEvent()              handleIncomingMessage()
        │                                    │
        ├──▶ Buffer output                   ├──▶ Queue message
        │                                    │
        ├──▶ Parse relay commands            ├──▶ Wait for stability
        │    (->relay:Target message)        │
        │                                    ▼
        ▼                             performInjection()
  sendRelayCommand()                         │
        │                                    ▼
        ▼                           POST /session/:id/message
  RelayClient.sendMessage()
        │
        ▼
  Daemon routes to target
```

## Configuration

### Environment Variables

```bash
# OpenCode server URL (default: http://localhost:4096)
OPENCODE_SERVER_URL=http://localhost:4096

# Enable OpenCode integration by default
RELAY_OPENCODE_ENABLED=true

# Enable mDNS discovery
RELAY_OPENCODE_DISCOVER=true

# Prefer OpenCode wrapper when available
RELAY_WRAPPER_PREFERENCE=opencode  # or 'pty' or 'auto'
```

### Configuration File

```json
// .agent-relay/config.json
{
  "opencode": {
    "enabled": true,
    "serverUrl": "http://localhost:4096",
    "discover": true,
    "preferWrapper": "auto"
  }
}
```

## Implementation Phases

### Phase 1: Core Wrapper (Week 1)
- [ ] Create `OpenCodeWrapper` class extending `BaseWrapper`
- [ ] Implement session creation/management
- [ ] Implement SSE event streaming
- [ ] Implement message injection via HTTP API
- [ ] Add basic tests

### Phase 2: Factory & Spawner (Week 2)
- [ ] Create `WrapperFactory` with auto-selection logic
- [ ] Create `OpenCodeSpawner` with session inheritance
- [ ] Update `AgentSpawner` to use factory optionally
- [ ] Add session registry for tracking
- [ ] Add integration tests

### Phase 3: Discovery & Multi-host (Week 3)
- [ ] Implement `OpenCodeDiscovery` with mDNS
- [ ] Add discovery routes to dashboard API
- [ ] Test cross-host agent spawning
- [ ] Document discovery setup

### Phase 4: CLI & Polish (Week 4)
- [ ] Add CLI flags for OpenCode integration
- [ ] Add configuration file support
- [ ] Update dashboard UI for OpenCode sessions
- [ ] Performance testing and optimization
- [ ] Documentation

## Dependencies

```json
{
  "dependencies": {
    "@opencode-ai/sdk": "^1.0.0",
    "mdns-js": "^1.0.0"  // or alternative mDNS library
  }
}
```

## Testing Strategy

### Unit Tests
- `OpenCodeWrapper` session management
- `WrapperFactory` selection logic
- Event parsing and handling

### Integration Tests
- Full spawn/release cycle with OpenCode backend
- Session forking and context inheritance
- Relay message routing with OpenCode agents

### E2E Tests
- Multi-agent scenario with mixed wrappers
- mDNS discovery across hosts
- Failover from OpenCode to PTY

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| OpenCode server unavailable | Agent spawn fails | Fall back to PTY wrapper |
| SSE connection drops | Missed events | Reconnect with backoff; poll for catch-up |
| Session fork not supported | Context inheritance fails | Document as optional feature |
| mDNS not available | Discovery fails | Support manual server registration |
| OpenCode API changes | Integration breaks | Pin SDK version; add version check |

## Success Metrics

1. **Functional**: Can spawn, communicate with, and release OpenCode-backed agents
2. **Performance**: Message latency within 10% of PTY-based agents
3. **Reliability**: 99%+ message delivery rate
4. **Adoption**: CLI flag documented and usable

## Open Questions

1. **Model selection**: OpenCode doesn't currently support per-session model selection. Should we wait for this feature or work around it?

2. **Session persistence**: Should we persist session IDs for resume across daemon restarts?

3. **Authentication**: How do we handle OpenCode OAuth flows for providers?

4. **Rate limiting**: Does OpenCode have API rate limits we need to respect?

## References

- [OpenCode Server Documentation](https://opencode.ai/docs/server/)
- [OpenCode SDK Documentation](https://opencode.ai/docs/sdk/)
- [OpenCode GitHub](https://github.com/opencode-ai/opencode)
- [Agent Relay Architecture](../architecture.md)
