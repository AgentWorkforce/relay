# Mobile CLI Wrapper - Implementation Spec

**Bead:** `bd-mobile-cli`
**Priority:** P0 (Critical)
**Estimated Effort:** 2-3 weeks

## Overview

Create `relay-mobile`, a CLI wrapper that enables mobile app control of Claude Code sessions. This is the critical piece that bridges desktop terminal ↔ mobile app.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Desktop Terminal                                │
│                                                                          │
│  ┌──────────────────┐                                                   │
│  │  relay-mobile    │  ← User runs this instead of `claude`            │
│  │  (CLI wrapper)   │                                                   │
│  └────────┬─────────┘                                                   │
│           │                                                              │
│           │ spawn as child process                                       │
│           ▼                                                              │
│  ┌──────────────────┐     ┌──────────────────┐                         │
│  │  Claude Code     │◀───▶│  MCP Permission  │                         │
│  │  (child proc)    │     │  Server          │                         │
│  └────────┬─────────┘     └────────┬─────────┘                         │
│           │                        │                                     │
│           │ stdout/stderr          │ permission requests                 │
│           ▼                        ▼                                     │
│  ┌────────────────────────────────────────────┐                         │
│  │              Session Manager               │                         │
│  │  - Output capture                          │                         │
│  │  - Permission forwarding                   │                         │
│  │  - Mode switching (local ↔ remote)        │                         │
│  └────────────────────┬───────────────────────┘                         │
│                       │                                                  │
└───────────────────────┼──────────────────────────────────────────────────┘
                        │ WebSocket
                        ▼
              ┌──────────────────┐
              │  agent-relay     │
              │  daemon          │
              └────────┬─────────┘
                       │
                       ▼
              ┌──────────────────┐
              │  Mobile App      │
              │  (WebSocket)     │
              └──────────────────┘
```

---

## Key Components

### 1. CLI Entry Point (`bin/relay-mobile.ts`)

```typescript
#!/usr/bin/env node
import { program } from 'commander';
import { startSession } from '../src/mobile';

program
  .name('relay-mobile')
  .description('Mobile-enabled Claude Code wrapper')
  .argument('[command...]', 'Command to run (default: claude)')
  .option('-n, --name <name>', 'Session name')
  .option('-m, --model <model>', 'Model to use')
  .option('--no-qr', 'Skip QR code display')
  .option('--remote-only', 'Start in remote mode')
  .action(async (command, options) => {
    await startSession({
      command: command.length ? command : ['claude'],
      name: options.name,
      model: options.model,
      showQr: options.qr !== false,
      startRemote: options.remoteOnly,
    });
  });

program.parse();
```

### 2. Session Launcher (`src/mobile/launcher.ts`)

```typescript
import { spawn, ChildProcess } from 'child_process';
import { MCPPermissionServer } from './mcp-server';
import { SessionSync } from './sync';
import { QRPairing } from './pairing';

interface LaunchOptions {
  command: string[];
  name?: string;
  model?: string;
  showQr: boolean;
  startRemote: boolean;
}

export class SessionLauncher {
  private child: ChildProcess | null = null;
  private mcpServer: MCPPermissionServer;
  private sync: SessionSync;
  private sessionId: string;

  async launch(options: LaunchOptions): Promise<void> {
    // 1. Generate session ID
    this.sessionId = crypto.randomUUID();

    // 2. Start MCP permission server
    this.mcpServer = new MCPPermissionServer({
      onPermissionRequest: (req) => this.handlePermission(req),
    });
    await this.mcpServer.start();

    // 3. Initialize sync with daemon
    this.sync = new SessionSync(this.sessionId);
    await this.sync.connect();

    // 4. Show QR code for pairing
    if (options.showQr) {
      const pairing = new QRPairing(this.sessionId);
      await pairing.display();
    }

    // 5. Build environment with MCP config
    const env = {
      ...process.env,
      CLAUDE_MCP_SERVERS: JSON.stringify({
        'relay-permissions': {
          command: 'node',
          args: [this.mcpServer.socketPath],
        },
      }),
    };

    // 6. Spawn Claude as child process
    const [cmd, ...args] = options.command;
    this.child = spawn(cmd, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    // 7. Capture and forward output
    this.child.stdout?.on('data', (data) => {
      process.stdout.write(data);
      this.sync.sendOutput(data.toString());
    });

    this.child.stderr?.on('data', (data) => {
      process.stderr.write(data);
      this.sync.sendOutput(data.toString(), 'stderr');
    });

    // 8. Handle incoming from mobile
    this.sync.onInput((input) => {
      this.child?.stdin?.write(input);
    });

    // 9. Wait for exit
    return new Promise((resolve, reject) => {
      this.child?.on('exit', (code) => {
        this.cleanup();
        if (code === 0) resolve();
        else reject(new Error(`Exit code: ${code}`));
      });
    });
  }

  private async handlePermission(req: PermissionRequest): Promise<boolean> {
    // Forward to mobile via sync
    const response = await this.sync.requestPermission(req);
    return response.approved;
  }

  private cleanup(): void {
    this.mcpServer?.stop();
    this.sync?.disconnect();
  }
}
```

### 3. MCP Permission Server (`src/mobile/mcp-server.ts`)

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

interface PermissionRequest {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  timestamp: Date;
}

interface MCPServerOptions {
  onPermissionRequest: (req: PermissionRequest) => Promise<boolean>;
}

export class MCPPermissionServer {
  private server: Server;
  private options: MCPServerOptions;
  socketPath: string;

  constructor(options: MCPServerOptions) {
    this.options = options;
    this.socketPath = `/tmp/relay-mcp-${process.pid}.sock`;
  }

  async start(): Promise<void> {
    this.server = new Server(
      { name: 'relay-permissions', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    // Intercept tool calls
    this.server.setRequestHandler('tools/call', async (request) => {
      const { name, arguments: args } = request.params;

      // Create permission request
      const permReq: PermissionRequest = {
        id: crypto.randomUUID(),
        tool: name,
        arguments: args as Record<string, unknown>,
        timestamp: new Date(),
      };

      // Ask mobile for permission
      const approved = await this.options.onPermissionRequest(permReq);

      if (!approved) {
        throw new Error('Permission denied by user');
      }

      // Let the call proceed (we don't execute, just approve)
      return { approved: true };
    });

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  stop(): void {
    this.server?.close();
  }
}
```

### 4. Mode Controller (`src/mobile/mode.ts`)

```typescript
import { EventEmitter } from 'events';
import * as readline from 'readline';

type Mode = 'local' | 'remote';

export class ModeController extends EventEmitter {
  private mode: Mode = 'local';
  private rl: readline.Interface | null = null;

  constructor() {
    super();
  }

  getMode(): Mode {
    return this.mode;
  }

  setMode(mode: Mode): void {
    if (this.mode !== mode) {
      this.mode = mode;
      this.emit('modeChange', mode);
    }
  }

  /**
   * Start listening for keypress to switch from remote → local
   */
  startKeypressListener(): void {
    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);

      process.stdin.on('keypress', (str, key) => {
        if (this.mode === 'remote') {
          // Any keypress switches to local mode
          this.setMode('local');
          console.log('\n[Switched to local mode]');
        }

        // Forward the keypress if in local mode
        if (this.mode === 'local') {
          this.emit('keypress', str, key);
        }

        // Ctrl+C handling
        if (key.ctrl && key.name === 'c') {
          this.emit('exit');
        }
      });
    }
  }

  stop(): void {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
  }
}
```

### 5. Session Sync (`src/mobile/sync.ts`)

```typescript
import { io, Socket } from 'socket.io-client';
import { encrypt, decrypt } from './crypto';

interface SyncMessage {
  type: 'output' | 'input' | 'permission_request' | 'permission_response' | 'state';
  data: unknown;
  timestamp: number;
}

export class SessionSync {
  private socket: Socket | null = null;
  private sessionId: string;
  private pendingPermissions: Map<string, (approved: boolean) => void> = new Map();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Connect to agent-relay daemon's WebSocket
      this.socket = io('http://localhost:3888', {
        query: { sessionId: this.sessionId, type: 'mobile-session' },
      });

      this.socket.on('connect', () => {
        console.log('[Mobile sync connected]');
        resolve();
      });

      this.socket.on('connect_error', reject);

      this.socket.on('message', (msg: SyncMessage) => {
        this.handleMessage(msg);
      });
    });
  }

  private handleMessage(msg: SyncMessage): void {
    switch (msg.type) {
      case 'input':
        // Mobile sent input
        this.inputHandler?.(msg.data as string);
        break;

      case 'permission_response':
        // Mobile responded to permission request
        const { requestId, approved } = msg.data as { requestId: string; approved: boolean };
        const resolver = this.pendingPermissions.get(requestId);
        if (resolver) {
          resolver(approved);
          this.pendingPermissions.delete(requestId);
        }
        break;
    }
  }

  private inputHandler: ((input: string) => void) | null = null;

  onInput(handler: (input: string) => void): void {
    this.inputHandler = handler;
  }

  sendOutput(output: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    const msg: SyncMessage = {
      type: 'output',
      data: { output, stream },
      timestamp: Date.now(),
    };
    this.socket?.emit('message', encrypt(msg));
  }

  async requestPermission(req: PermissionRequest): Promise<{ approved: boolean }> {
    return new Promise((resolve) => {
      // Store resolver
      this.pendingPermissions.set(req.id, (approved) => {
        resolve({ approved });
      });

      // Send to mobile
      const msg: SyncMessage = {
        type: 'permission_request',
        data: req,
        timestamp: Date.now(),
      };
      this.socket?.emit('message', encrypt(msg));

      // Timeout after 60 seconds
      setTimeout(() => {
        if (this.pendingPermissions.has(req.id)) {
          this.pendingPermissions.delete(req.id);
          resolve({ approved: false }); // Default deny on timeout
        }
      }, 60000);
    });
  }

  disconnect(): void {
    this.socket?.disconnect();
  }
}
```

### 6. QR Pairing (`src/mobile/pairing.ts`)

```typescript
import * as qrcode from 'qrcode-terminal';

export class QRPairing {
  private sessionId: string;
  private pairingUrl: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    // URL that mobile app deep-links to
    this.pairingUrl = `relay://pair?session=${sessionId}&host=${this.getLocalIP()}`;
  }

  async display(): Promise<void> {
    console.log('\n┌─────────────────────────────────────┐');
    console.log('│  Scan with Relay Mobile to connect  │');
    console.log('└─────────────────────────────────────┘\n');

    qrcode.generate(this.pairingUrl, { small: true });

    console.log(`\nSession ID: ${this.sessionId.slice(0, 8)}...`);
    console.log('Press any key to switch to local mode\n');
  }

  private getLocalIP(): string {
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();

    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          return net.address;
        }
      }
    }
    return 'localhost';
  }
}
```

---

## Integration with Existing Daemon

### Daemon Extensions Needed

1. **New WebSocket endpoint for mobile sessions**

```typescript
// src/daemon/mobile-endpoint.ts
app.get('/mobile/session/:sessionId', (req, res) => {
  // Upgrade to WebSocket
  const ws = new WebSocket(req, res);

  // Register as mobile client for this session
  mobileClients.set(req.params.sessionId, ws);

  ws.on('message', (msg) => {
    // Forward to session's CLI wrapper
    const session = sessions.get(req.params.sessionId);
    session?.handleMobileMessage(decrypt(msg));
  });
});
```

2. **Permission request routing**

```typescript
// When permission request comes from CLI wrapper
daemon.on('permission_request', (sessionId, request) => {
  const mobileClient = mobileClients.get(sessionId);
  if (mobileClient) {
    mobileClient.send(encrypt({
      type: 'permission_request',
      data: request,
    }));
  } else {
    // No mobile connected - use default behavior
    handleLocalPermission(request);
  }
});
```

---

## File Structure

```
src/mobile/
├── index.ts              # Main entry, exports startSession
├── launcher.ts           # SessionLauncher class
├── mcp-server.ts         # MCP permission server
├── mode.ts               # Mode controller (local/remote)
├── sync.ts               # Session sync with daemon
├── pairing.ts            # QR code pairing
├── types.ts              # Shared types
└── crypto/
    ├── index.ts          # Crypto exports
    ├── encrypt.ts        # Encryption functions
    └── decrypt.ts        # Decryption functions

bin/
└── relay-mobile.ts       # CLI entry point
```

---

## Package.json Additions

```json
{
  "bin": {
    "relay-mobile": "./dist/bin/relay-mobile.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.22.0",
    "qrcode-terminal": "^0.12.0",
    "socket.io-client": "^4.8.1",
    "libsodium-wrappers": "^0.7.13",
    "commander": "^11.0.0"
  }
}
```

---

## Usage Examples

```bash
# Basic usage - wraps claude
relay-mobile

# With options
relay-mobile -n my-session --model opus

# Wrap different command
relay-mobile codex

# Skip QR code
relay-mobile --no-qr

# Start in remote mode (mobile controls first)
relay-mobile --remote-only
```

---

## Testing Plan

1. **Unit Tests**
   - Mode switching state machine
   - Permission request/response flow
   - Message encryption/decryption

2. **Integration Tests**
   - CLI wrapper spawns Claude successfully
   - MCP server intercepts permissions
   - WebSocket sync works

3. **E2E Tests**
   - Full flow: Desktop → Daemon → Mobile simulator
   - Permission approval/denial
   - Mode switching

---

## Rollout Plan

**Phase 1: MVP (1 week)**
- [ ] Basic CLI wrapper
- [ ] Output forwarding to daemon
- [ ] QR code display

**Phase 2: Permissions (1 week)**
- [ ] MCP permission server
- [ ] Permission forwarding
- [ ] Timeout handling

**Phase 3: Mode Switching (3 days)**
- [ ] Keypress detection
- [ ] Local/remote state machine
- [ ] UI indicators

**Phase 4: Polish (3 days)**
- [ ] Error handling
- [ ] Reconnection logic
- [ ] Documentation
