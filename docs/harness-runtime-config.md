# Harness Runtime Config

## Goal

Harnesses should be user-extensible without requiring Rust changes for normal
agent CLIs. The durable boundary is data: the Rust broker validates and executes
`HarnessConfig` objects. SDKs may help users build those objects, but the broker
does not call back into SDK-defined functions after the SDK process exits.

## Core Model

The broker has two public runtime categories:

- `pty`: runs a command inside a PTY and manages terminal-oriented delivery.
- `headless`: controls a non-terminal agent through a driver.

The first headless driver is `app_server`, used for session-backed HTTP agents
such as OpenCode. `driver` defaults to `app_server` when `runtime` is
`headless`.

Names in this design:

- A harness config is the concrete `pty` or `headless` object the broker runs.
- A harness adapter is SDK/userland code that returns a harness config.
- `harnessId` references a config in the broker's in-memory registry.
- `harnessConfig` is the spawn field for sending a one-off concrete config.

## Config Shapes

PTY configs are process and terminal backed:

```ts
type PtyHarnessConfig = {
  runtime: 'pty';
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  sessionId?: string;
  delivery?: {
    mode?: 'pty-injection';
    format?: 'relay-block';
  };
  metadata?: Record<string, unknown>;
};
```

Headless app-server configs are session backed:

```ts
type HeadlessAppServerHarnessConfig = {
  runtime: 'headless';
  driver?: 'app_server';
  protocol: 'opencode' | string;
  endpoint: string;
  sessionId: string;
  auth?: {
    type: 'bearer' | 'basic' | 'none';
    token?: string;
    username?: string;
    password?: string;
  };
  host?: {
    ownership?: 'broker-owned' | 'attached';
    pid?: number;
  };
  release?: 'abort' | 'detach' | 'delete';
  metadata?: Record<string, unknown>;
};
```

For now, `app_server` configs are attach-only. `host.ownership:
'broker-owned'` is reserved and rejected until the broker owns app-server
lifecycle supervision. When `host.pid` is provided, the broker reports that as
the harness PID.

Config `env` and `auth` values are visible to the broker. Adapters should return
explicit allowlists instead of copying whole process environments.

## SDK Adapters

An SDK adapter is a helper that returns data:

```ts
function companyClaude(): ResolvedHarnessConfig {
  return {
    runtime: 'pty',
    command: 'claude',
    args: ['--dangerously-skip-permissions', '--append-system-prompt', 'Follow the company review rubric.'],
  };
}
```

Register stable configs by name:

```ts
const relay = new AgentRelay({
  harnesses: {
    'company-claude': companyClaude(),
  },
});
```

The SDK registers those configs with the broker's in-memory registry on start.
Future spawns can use `harnessId: 'company-claude'`.

Use inline configs for per-spawn setup:

```ts
const sessionId = await createCodexSession({ cwd, task });

await relay.spawn('CodexReviewer', 'codex', task, {
  harnessConfig: {
    runtime: 'pty',
    command: 'codex',
    args: ['resume', sessionId],
    cwd,
    sessionId,
  },
});
```

This avoids pretending that SDK callbacks are durable. If the SDK process exits,
the broker can still execute registered or inline configs because it already has
the data.

## Broker Registry

The broker keeps an in-memory map:

```ts
Record<string, ResolvedHarnessConfig>;
```

HTTP/SDK API:

- `PUT /api/harnesses/:name` registers or replaces a config.
- `GET /api/harnesses` lists registered configs.
- `POST /api/spawn` accepts either `harnessId` or `harnessConfig`.

Resolution rules:

- `harnessConfig` is already concrete and runs as supplied.
- `harnessId` resolves against the receiving broker's registry.
- Providing both is rejected.
- Unknown `harnessId` is rejected.

Registry state is intentionally runtime-local for now. In multi-broker
environments, use inline `harnessConfig` or ensure every broker registers the
same named configs before agents send `harnessId` spawns.

## Relaycast Spawns

Agent-crafted Relaycast spawns can send a registry reference:

```json
{
  "agent": {
    "name": "ClaudeReviewer",
    "cli": "company-claude",
    "task": "Review the current diff.",
    "harnessId": "company-claude"
  }
}
```

Or a portable inline config:

```json
{
  "agent": {
    "name": "CodexReviewer",
    "cli": "codex",
    "task": "Review the current diff.",
    "harnessConfig": {
      "runtime": "pty",
      "command": "codex",
      "args": ["resume", "session_123"],
      "sessionId": "session_123"
    }
  }
}
```

The broker validates the selected config and then uses the same spawn path as
SDK-submitted configs.

## Broker Responsibilities

The broker owns:

- Agent registry and name uniqueness.
- Spawn, release, and future fork lifecycle.
- Relay routing and local-vs-remote delivery.
- Delivery queues, retry, ack, failure, and manual flush semantics.
- Process and server supervision for broker-owned runtimes.
- Capability checks for PTY-only routes.
- Event emission, metrics, logs, and replay buffers.

The broker does not own arbitrary user logic unless that logic is built into
Rust or represented as validated config data.

## Runtime Notes

The PTY executor consumes a concrete PTY config. It handles process spawn,
terminal streaming, raw input, resize, snapshot, release, and PTY message
injection.

The headless runtime covers non-PTY workers. Provider-command headless workers
remain the built-in path for existing providers. App-server headless workers
attach to a session server instead. Headless runtimes do not expose PTY input,
resize, or snapshot capabilities.

## Implementation Phases

1. Add shared config schema and SDK types.
2. Teach the broker to accept and execute resolved PTY configs.
3. Add a headless app-server config path with an OpenCode protocol driver.
4. Add an in-memory broker harness registry and `harnessId` spawn selection.
5. Allow Relaycast spawn events to carry `harnessId` or inline `harnessConfig`.
6. Add capability-aware runtime checks for PTY-only operations.
7. Document Claude PTY, Codex inline PTY, and OpenCode headless examples.
