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

### Hook Context

```typescript
interface HookContext {
  // Agent info
  agentId: string;
  agentName: string;
  sessionId: string;

  // Environment
  workingDir: string;
  env: Record<string, string>;

  // Actions
  inject(text: string): void;      // Inject text to agent stdin
  send(to: string, msg: string): void;  // Send relay message

  // Built-in services
  memory: MemoryService;           // Memory operations
  relay: RelayService;             // Messaging operations

  // Session state
  output: string[];                // All output so far
  messages: Message[];             // All relay messages
}
```

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

## Trajectory Integration

Hooks integrate naturally with trajectory tracking (PDERO paradigm):

```typescript
// relay.config.ts
export default {
  hooks: {
    onSessionStart: async (ctx) => {
      // Auto-start trajectory if task is provided
      if (ctx.task) {
        await exec(`trail start "${ctx.task}" --agent ${ctx.agentName}`);
      }

      // Load active trajectory context
      const status = await exec('trail status --json');
      if (status.active) {
        return {
          inject: `Active trajectory: ${status.task}\nPhase: ${status.phase}`
        };
      }
    },

    onOutput: async (output, ctx) => {
      // Auto-detect PDERO phase transitions
      const phases = ['planning', 'designing', 'implementing', 'testing', 'observing'];
      for (const phase of phases) {
        if (output.toLowerCase().includes(phase)) {
          await exec(`trail phase ${phase.slice(0, -3)} --reason "Auto-detected"`);
          break;
        }
      }
    },

    onMessageReceived: async (from, body, ctx) => {
      // Record message in trajectory
      await exec(`trail event "Message from ${from}" --type observation`);
    },

    onSessionEnd: async (ctx) => {
      return {
        inject: `
[SESSION ENDING]
Complete your trajectory with learnings:
  trail complete --summary "What you accomplished" --confidence 0.9
`
      };
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
5. Add trajectory hooks integration
6. Add documentation and examples

## Related

- [MEMORY_STACK_DECISION.md](./MEMORY_STACK_DECISION.md) - Memory backend choice
- [FEDERATION_PROPOSAL.md](./FEDERATION_PROPOSAL.md) - Cross-server messaging
- [PROPOSAL-trajectories.md](./PROPOSAL-trajectories.md) - Trajectory tracking
