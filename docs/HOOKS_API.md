# Agent Relay Hooks API

**Date:** 2025-12-21
**Status:** Proposed

## Overview

Hooks are a core primitive in agent-relay that allow:
1. **Intercepting agent output** - React to patterns, events, session lifecycle
2. **Injecting prompts** - Guide agent behavior automatically
3. **Extending with namespaces** - User-defined `@pattern:` handlers

## Pattern Namespaces

agent-relay intercepts output patterns in the format `@namespace:target message`.

### Built-in Namespaces

| Namespace | Purpose | Example |
|-----------|---------|---------|
| `@relay:` | Inter-agent messaging | `@relay:Alice Check the tests` |
| `@memory:` | Memory operations | `@memory:save User prefers dark mode` |
| `@broadcast:` | Broadcast to all | `@relay:* Status update` |

### Memory Namespace

```
@memory:save <content>        # Store a memory
@memory:search <query>        # Retrieve relevant memories
@memory:forget <id>           # Delete a memory
@memory:list                  # List recent memories
```

### User-Defined Namespaces

Users can register custom pattern handlers:

```typescript
// relay.config.ts
export default {
  patterns: {
    // Custom namespace: @deploy:
    deploy: {
      handler: async (target, message, context) => {
        if (target === 'staging') {
          await exec('npm run deploy:staging');
          return { inject: 'Deployed to staging successfully' };
        }
      }
    },

    // Custom namespace: @notify:
    notify: {
      handler: async (target, message, context) => {
        await fetch('https://slack.com/api/post', {
          body: JSON.stringify({ channel: target, text: message })
        });
      }
    }
  }
};
```

Usage in agent output:
```
@deploy:staging Release v1.2.3
@notify:#engineering Build complete
```

## Hook Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           HOOK LIFECYCLE                                     │
│                                                                              │
│  SESSION START                                                               │
│       │                                                                      │
│       ▼                                                                      │
│  ┌─────────────────┐                                                        │
│  │ onSessionStart  │ → Inject initial context, load memories                │
│  └────────┬────────┘                                                        │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────────────────────────────────────────────────────┐       │
│  │                      AGENT RUNNING                               │       │
│  │                                                                  │       │
│  │   Agent Output ──► onOutput ──► Pattern Match? ──► Handler      │       │
│  │        │                              │                          │       │
│  │        │                              ▼                          │       │
│  │        │                        @relay: → route message          │       │
│  │        │                        @memory: → store/search          │       │
│  │        │                        @custom: → user handler          │       │
│  │        │                                                         │       │
│  │        ▼                                                         │       │
│  │   onToolCall ──► Before/after tool execution                    │       │
│  │        │                                                         │       │
│  │        ▼                                                         │       │
│  │   onMessageReceived ──► Inject incoming relay messages          │       │
│  │        │                                                         │       │
│  │        ▼                                                         │       │
│  │   onIdle ──► Periodic prompts (memory review, status)           │       │
│  │                                                                  │       │
│  └─────────────────────────────────────────────────────────────────┘       │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────┐                                                        │
│  │ onSessionEnd    │ → Prompt for memory save, cleanup                      │
│  └─────────────────┘                                                        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Lifecycle Events: Detailed Specification

### onSessionStart

**When:** Immediately after tmux session is created, before agent CLI starts producing output.

**Trigger point:** `TmuxWrapper.start()` after spawn, before first `pollOutput()`.

```typescript
// In src/wrapper/tmux-wrapper.ts
async start(command: string) {
  await this.spawnTmuxSession(command);

  // TRIGGER: onSessionStart
  const result = await this.hooks.emit('sessionStart', {
    agentId: this.agentId,
    agentName: this.agentName,
    sessionId: this.sessionId,
    workingDir: process.cwd(),
  });

  // Inject any returned text (e.g., loaded memories)
  if (result?.inject) {
    await this.injectText(result.inject);
  }

  this.startPolling();
}
```

**Use cases:**
- Load relevant memories from Mem0 based on project/directory
- Inject user preferences ("User prefers TypeScript")
- Set up agent context ("You are working on the auth module")

**Handler signature:**
```typescript
onSessionStart: (ctx: HookContext) => Promise<HookResult | void>
```

---

### onOutput

**When:** Every time new output is captured from the agent (polled every 100ms, fires on diff).

**Trigger point:** `TmuxWrapper.pollOutput()` when `newOutput !== lastOutput`.

```typescript
// In src/wrapper/tmux-wrapper.ts
async pollOutput() {
  const paneContent = await this.capturePane();
  const newOutput = this.diffOutput(paneContent, this.lastContent);

  if (newOutput) {
    this.lastContent = paneContent;
    this.lastOutputTime = Date.now();

    // TRIGGER: onOutput
    await this.hooks.emit('output', newOutput, this.context);

    // Check for @pattern: matches
    await this.matchPatterns(newOutput);
  }
}
```

**Use cases:**
- Log all agent output to file/database
- Detect errors and alert
- Track progress metrics
- Custom pattern matching beyond @namespace:

**Handler signature:**
```typescript
onOutput: (output: string, ctx: HookContext) => Promise<HookResult | void>
```

**Note:** This fires frequently. Keep handlers fast. Don't inject on every output.

---

### onIdle

**When:** Agent has produced no output for `idleThreshold` (default 30 seconds).

**Trigger point:** `TmuxWrapper.pollOutput()` when idle time exceeds threshold.

```typescript
// In src/wrapper/tmux-wrapper.ts
private idleThreshold = 30000; // 30 seconds
private lastIdleNotification = 0;

async pollOutput() {
  // ... capture and diff ...

  const idleTime = Date.now() - this.lastOutputTime;

  // TRIGGER: onIdle (once per idle period, not continuously)
  if (idleTime > this.idleThreshold &&
      Date.now() - this.lastIdleNotification > this.idleThreshold) {
    this.lastIdleNotification = Date.now();

    const result = await this.hooks.emit('idle', this.context);
    if (result?.inject) {
      await this.injectText(result.inject);
    }
  }
}
```

**Use cases:**
- Prompt agent for status update
- Ask if agent is stuck or needs help
- Suggest next steps
- Trigger auto-save of work in progress

**Handler signature:**
```typescript
onIdle: (ctx: HookContext) => Promise<HookResult | void>
```

**Configuration:**
```typescript
// relay.config.ts
export default {
  hooks: {
    onIdle: async (ctx) => {
      return { inject: '[STATUS CHECK] Are you making progress?' };
    }
  },
  options: {
    idleThreshold: 60000, // 60 seconds instead of default 30
  }
};
```

---

### onMessageReceived

**When:** A relay message arrives for this agent from another agent or broadcast.

**Trigger point:** `TmuxWrapper.handleIncomingMessage()` when daemon delivers message.

```typescript
// In src/wrapper/tmux-wrapper.ts
async handleIncomingMessage(message: RelayMessage) {
  // TRIGGER: onMessageReceived (before injection)
  const result = await this.hooks.emit('messageReceived', message, this.context);

  // Allow handler to modify or suppress injection
  if (result?.suppress) {
    return; // Don't inject this message
  }

  const textToInject = result?.inject || this.formatMessage(message);
  await this.injectText(textToInject);
}
```

**Use cases:**
- Custom message formatting
- Filter/suppress certain messages
- Log incoming messages
- Transform message content
- Route to different handlers based on sender

**Handler signature:**
```typescript
onMessageReceived: (message: RelayMessage, ctx: HookContext) => Promise<HookResult | void>
```

**Example - Custom formatting:**
```typescript
onMessageReceived: async (msg, ctx) => {
  // Add priority indicator
  const priority = msg.metadata?.urgent ? '🚨 URGENT' : '📨';
  return {
    inject: `${priority} Message from ${msg.from}: ${msg.content}`
  };
}
```

---

### onSessionEnd

**When:** Agent session is ending (user pressed Ctrl+C, agent exited, or explicit stop).

**Trigger point:** `TmuxWrapper.stop()` or SIGINT/SIGTERM handler.

```typescript
// In src/wrapper/tmux-wrapper.ts
async stop() {
  // TRIGGER: onSessionEnd (before cleanup)
  const result = await this.hooks.emit('sessionEnd', this.context);

  if (result?.inject) {
    await this.injectText(result.inject);
    // Give agent time to process and respond
    await this.waitForResponse(5000);
  }

  await this.cleanup();
}

// Also in signal handlers
process.on('SIGINT', async () => {
  await wrapper.stop();
  process.exit(0);
});
```

**Use cases:**
- Prompt agent to save important learnings
- Capture final summary
- Cleanup resources
- Save session transcript

**Handler signature:**
```typescript
onSessionEnd: (ctx: HookContext) => Promise<HookResult | void>
```

**Example - Memory prompt:**
```typescript
onSessionEnd: async (ctx) => {
  return {
    inject: `
[SESSION ENDING]
Before you go, save any important learnings:
  @memory:save <what you learned>
`
  };
}
```

---

### onToolCall (Future)

**When:** Agent invokes a tool (requires parsing tool calls from output).

**Status:** Future enhancement - requires understanding agent's tool output format.

```typescript
onToolCall: (tool: string, args: any, ctx: HookContext) => Promise<HookResult | void>
```

**Use cases:**
- Audit tool usage
- Block dangerous operations
- Inject additional context before tool runs

---

## Implementation Location

All lifecycle events are triggered from `src/wrapper/tmux-wrapper.ts`:

```typescript
// src/wrapper/tmux-wrapper.ts - Current structure
export class TmuxWrapper {
  // ADD: Hook emitter
  private hooks: HookEmitter;

  constructor(config: WrapperConfig) {
    this.hooks = new HookEmitter(config.hooks);
  }

  async start() { /* triggers onSessionStart */ }
  async pollOutput() { /* triggers onOutput, onIdle */ }
  async handleIncomingMessage() { /* triggers onMessageReceived */ }
  async stop() { /* triggers onSessionEnd */ }
}
```

New file needed: `src/hooks/emitter.ts`:

```typescript
// src/hooks/emitter.ts
export class HookEmitter {
  private handlers: Map<string, HookHandler[]>;

  constructor(config?: HooksConfig) {
    this.handlers = new Map();
    if (config) this.loadFromConfig(config);
  }

  on(event: HookEvent, handler: HookHandler) {
    const existing = this.handlers.get(event) || [];
    this.handlers.set(event, [...existing, handler]);
  }

  async emit(event: HookEvent, ...args: any[]): Promise<HookResult | void> {
    const handlers = this.handlers.get(event) || [];
    let result: HookResult | void;

    for (const handler of handlers) {
      result = await handler(...args);
      if (result?.stop) break; // Stop propagation
    }

    return result;
  }
}
```

## Event Summary Table

| Event | Trigger | Frequency | Can Inject? | Use Case |
|-------|---------|-----------|-------------|----------|
| `onSessionStart` | Session spawn | Once | ✅ Yes | Load memories, set context |
| `onOutput` | New output captured | Many (100ms poll) | ⚠️ Rarely | Logging, error detection |
| `onIdle` | No output for 30s | Periodic | ✅ Yes | Status prompts |
| `onMessageReceived` | Relay message arrives | Per message | ✅ Yes | Custom formatting |
| `onSessionEnd` | Session closing | Once | ✅ Yes | Save memories, cleanup |
| `onToolCall` | Tool invoked | Per tool | Future | Audit, block |

## Hook API

### Configuration File

```typescript
// relay.config.ts (in project root or ~/.config/agent-relay/)
import type { RelayConfig } from 'agent-relay';

export default {
  // Pattern handlers (namespaces)
  patterns: {
    memory: 'builtin',  // Use built-in memory handler
    deploy: { handler: myDeployHandler },
  },

  // Lifecycle hooks
  hooks: {
    onSessionStart: async (ctx) => {
      // Load relevant memories
      const memories = await ctx.memory.search(ctx.workingDir);
      return { inject: `Relevant context:\n${memories}` };
    },

    onSessionEnd: async (ctx) => {
      return {
        inject: `Session ending. Save any important learnings with @memory:save`
      };
    },

    onOutput: async (output, ctx) => {
      // Custom output processing
      if (output.includes('ERROR')) {
        await ctx.notify('errors', output);
      }
    },

    onIdle: async (ctx) => {
      // Called after 30s of no output
      // Could prompt for status update
    },
  },

  // Memory configuration
  memory: {
    backend: 'mem0',  // or 'qdrant', 'custom'
    autoSave: false,  // Don't auto-extract, let agent decide
    promptOnEnd: true, // Prompt to save at session end
  },
} satisfies RelayConfig;
```

### Programmatic API

```typescript
import { Relay } from 'agent-relay';

const relay = new Relay({
  name: 'MyAgent',
});

// Register pattern handler
relay.pattern('deploy', async (target, message, ctx) => {
  console.log(`Deploying to ${target}: ${message}`);
  await deploy(target);
  return { inject: `Deployed to ${target}` };
});

// Register lifecycle hook
relay.on('sessionStart', async (ctx) => {
  const memories = await loadMemories(ctx.agentId);
  ctx.inject(`Your memories:\n${memories}`);
});

relay.on('sessionEnd', async (ctx) => {
  ctx.inject('Save important learnings with @memory:save');
});

// Start with wrapped command
relay.wrap('claude');
```

### Hook Context (Read-Only)

Hooks receive a **read-only context** with limited information. They cannot take actions directly - they return a `HookResult` that the relay system interprets.

```typescript
interface HookContext {
  // Agent identity (read-only)
  readonly agentId: string;
  readonly agentName: string;
  readonly sessionId: string;

  // Environment (read-only)
  readonly workingDir: string;
  readonly projectName: string;

  // Session state (read-only, last N items)
  readonly recentOutput: readonly string[];  // Last 50 output chunks
  readonly recentMessages: readonly Message[]; // Last 20 messages

  // Timing (read-only)
  readonly sessionStartTime: number;
  readonly lastOutputTime: number;
  readonly idleSeconds: number;
}
```

### Hook Result (Allowed Actions)

Hooks communicate intent via return value. The relay system executes allowed actions.

```typescript
interface HookResult {
  // Text injection (max 2000 chars, sanitized)
  inject?: string;

  // Suppress default behavior (onMessageReceived only)
  suppress?: boolean;

  // Stop other handlers from running
  stop?: boolean;

  // Send relay message (limited to 1 per hook invocation)
  sendMessage?: {
    to: string;      // Agent name or "*" for broadcast
    content: string; // Max 5000 chars
  };

  // Log to relay audit log (optional)
  log?: string;
}
```

### What Hooks CANNOT Do

| Prohibited | Why |
|------------|-----|
| File system access | Use @pattern: handlers for controlled file ops |
| Shell execution | Security risk - use dedicated patterns |
| Network requests | Use @pattern: handlers with explicit config |
| Modify env vars | Read-only context |
| Access full output | Memory bounded - only recent chunks |
| Unlimited injection | Max 2000 chars per injection |
| Multiple messages | One sendMessage per invocation |

### Sandboxing

Hooks run in a restricted context:

```typescript
// Hooks are pure functions: context in, result out
type HookHandler = (ctx: HookContext) => Promise<HookResult | void>;

// The relay system enforces limits
function executeHook(handler: HookHandler, ctx: HookContext): HookResult {
  const result = await handler(Object.freeze(ctx)); // Immutable context

  // Enforce limits
  if (result?.inject && result.inject.length > 2000) {
    result.inject = result.inject.slice(0, 2000) + '... [truncated]';
  }

  if (result?.sendMessage?.content.length > 5000) {
    throw new HookError('Message exceeds 5000 char limit');
  }

  return result;
}
```

### Capability Escalation

For advanced use cases, users can enable additional capabilities in config:

```typescript
// relay.config.ts
export default {
  hooks: {
    onSessionEnd: myHandler,
  },

  // Explicit capability grants (default: all false)
  capabilities: {
    allowNetworkInHooks: false,  // Permit fetch() in handlers
    allowFileReadInHooks: false, // Permit fs.readFile()
    unlimitedInjection: false,   // Remove 2000 char limit
  }
};
```

**Default is locked down.** Users must explicitly opt-in to dangerous capabilities.

## Built-in Pattern Handlers

### @relay: (Messaging)

```typescript
// Built-in, always available
relay.pattern('relay', async (target, message, ctx) => {
  if (target === '*') {
    await ctx.relay.broadcast(message);
  } else {
    await ctx.relay.send(target, message);
  }
});
```

### @memory: (Memory Operations)

```typescript
// Built-in when memory is configured
relay.pattern('memory', async (action, content, ctx) => {
  switch (action) {
    case 'save':
      await ctx.memory.add(content, { agentId: ctx.agentId });
      return { inject: `✓ Saved to memory` };

    case 'search':
      const results = await ctx.memory.search(content);
      return { inject: `Memories:\n${format(results)}` };

    case 'forget':
      await ctx.memory.delete(content);
      return { inject: `✓ Forgotten` };
  }
});
```

## Example: Full Memory Integration

```typescript
// relay.config.ts
export default {
  patterns: {
    memory: 'builtin',
  },

  hooks: {
    onSessionStart: async (ctx) => {
      // Search for relevant context based on current directory/project
      const projectMemories = await ctx.memory.search(
        `project: ${ctx.workingDir}`
      );
      const userPrefs = await ctx.memory.search('user preferences');

      if (projectMemories.length || userPrefs.length) {
        return {
          inject: `
[CONTEXT FROM MEMORY]
${projectMemories.map(m => `- ${m.content}`).join('\n')}

[USER PREFERENCES]
${userPrefs.map(m => `- ${m.content}`).join('\n')}
`
        };
      }
    },

    onSessionEnd: async (ctx) => {
      return {
        inject: `
[SESSION ENDING]
If you learned anything important, save it:
  @memory:save <what you learned>

Examples:
  @memory:save User prefers TypeScript over JavaScript
  @memory:save This project uses Prisma for database access
  @memory:save Auth tokens stored in httpOnly cookies
`
      };
    },
  },

  memory: {
    backend: 'mem0',
    config: {
      vectorStore: { provider: 'qdrant', url: 'http://localhost:6333' },
      embedder: { provider: 'ollama', model: 'nomic-embed-text' },
    },
  },
};
```

## Escaping Patterns

To output literal `@namespace:` without triggering handlers:

```
\@relay:AgentName    # Outputs literally, not routed
\\@relay:AgentName   # Outputs \@relay:AgentName
```

## Priority & Order

1. Patterns are matched in order of specificity
2. Built-in patterns run before user patterns (unless overridden)
3. Multiple handlers for same pattern run in registration order
4. Return `{ stop: true }` to prevent further handlers

## Next Steps

1. Implement pattern registry in agent-relay daemon
2. Add hook lifecycle events to wrapper
3. Implement @memory: built-in handler
4. Create relay.config.ts loader
5. Add documentation and examples

## Related

- [MEMORY_STACK_DECISION.md](./MEMORY_STACK_DECISION.md) - Memory backend choice
- [FEDERATION_PROPOSAL.md](./FEDERATION_PROPOSAL.md) - Cross-server messaging
