# Harness Runtime Plan

## Goal

Harnesses should be user-extensible without requiring Rust changes for normal
agent CLIs. The Rust broker should own durable runtime execution, lifecycle
tracking, routing, delivery queues, retries, and observability. SDKs should be
able to define named harnesses that resolve to broker-executable JSON plans.

## Core Model

The broker has two public runtime categories:

- `pty`: runs a command inside a PTY and manages terminal-oriented delivery.
- `headless`: controls a non-terminal agent through a driver.

The first headless drivers are:

- `provider_command`: the existing broker-owned one-shot headless path for
  built-in providers such as Claude and OpenCode.
- `app_server`: a session-backed HTTP driver for attached agent servers.

Named harnesses such as `codex`, `claude`, or `opencode-server` resolve to one of
those executable plans.

## Plan Shapes

PTY plans are process and terminal backed:

```ts
type PtyHarnessPlan = {
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

Headless app-server plans are session backed. They are still `headless` workers;
`driver: 'app_server'` explains how the broker talks to the worker:

```ts
type HeadlessAppServerHarnessPlan = {
  runtime: 'headless';
  driver: 'app_server';
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

The broker runs the returned plan. It does not need to understand arbitrary
TypeScript or Python logic.

For now, `app_server` plans are attach-only. `host.ownership: 'broker-owned'`
is reserved and rejected until the broker owns app-server lifecycle supervision.
When `host.pid` is provided, the broker reports that as the harness PID.

Plan `env` and `auth` values are visible to the broker and may be included in
runtime state. SDK resolvers should return explicit allowlists and avoid copying
the whole process environment.

## Harness Definition Classes

Static harness definitions are JSON-compatible and work in attached or detached
brokers:

```ts
const harnesses = {
  'company-claude': {
    runtime: 'pty',
    command: 'claude',
    args: [
      '--dangerously-skip-permissions',
      '--append-system-prompt',
      'Follow the company review rubric.',
      '{modelArgs}',
      '{args}',
    ],
    modelArgs: ['--model', '{model}'],
  },
};
```

Custom PTY harnesses own their CLI flags. Broker built-in permission bypass
defaults are not injected into caller-provided harness plans.

Dynamic harness resolvers are SDK functions and are attached-only. They can run
pre-spawn logic, such as creating a provider session, then return a concrete
plan:

```ts
const harnesses = {
  codex: async (ctx) => {
    const sessionId = await createCodexSession(ctx);
    return {
      runtime: 'pty',
      command: 'codex',
      args: ['resume', sessionId, ...ctx.args],
      env: {
        PATH: ctx.env.PATH ?? '',
        CODEX_HOME: ctx.env.CODEX_HOME ?? '',
      },
      sessionId,
    };
  },
};
```

Detached brokers must reject dynamic in-process resolvers because the SDK
process may exit while the broker and agents continue.

## Broker Lifetime

Broker lifetime should be explicit:

```ts
broker: {
  lifetime: 'attached' | 'detached';
}
```

Attached brokers are owned by the SDK process. Dynamic resolvers and in-process
decision hooks are allowed because the broker exits if the SDK control
connection exits.

Detached brokers survive SDK callers. They only accept static harness plans,
built-in Rust adapters, and durable extension hosts.

## Broker Responsibilities

The broker owns:

- Agent registry and name uniqueness.
- Spawn, release, and future fork lifecycle.
- Relay routing and local-vs-remote delivery.
- Delivery queues, retry, ack, failure, and manual flush semantics.
- Process and server supervision for broker-owned runtimes.
- Capability checks for PTY-only routes.
- Event emission, metrics, logs, and replay buffers.

The broker does not own custom user logic unless that logic is built into Rust.

## PTY Runtime

The PTY executor consumes a concrete PTY plan. It handles process spawn,
terminal streaming, raw input, resize, snapshot, release, and PTY message
injection.

This lets users add a CLI wrapper locally with config only. A Rust
contribution is only needed when Relay wants a built-in with tested defaults or
the CLI needs broker-side behavior.

## Headless Runtime

The headless runtime covers non-PTY workers. Provider-command headless workers
run a command per delivery, for example `claude -p` or `opencode run`.
App-server headless workers attach to a session server instead.

For OpenCode app-server harnesses, the SDK creates or selects a session and
returns its endpoint and session id. The broker attaches to that local or remote
`opencode serve` endpoint, delivers Relay messages through the session message
API, and releases by aborting, detaching, or deleting the session.

Headless runtimes do not expose PTY input, resize, or snapshot capabilities.

## Hooks

Event hooks are non-blocking subscriptions:

```ts
relay.addListener('agentSpawned', async (agent) => {
  await posthog.capture({
    distinctId: agent.name,
    event: 'agent_spawned',
    properties: { runtime: agent.runtime },
  });
});
```

Decision hooks are request-response calls over an attached SDK control
connection:

- `resolveHarness`
- `beforeSpawn`
- `authorizeSpawn`

Detached brokers must use static config, built-in sinks, HTTP webhooks, or a
durable extension host for decision-making.

## Implementation Phases

1. Add shared plan schema and SDK types.
2. Add static SDK harness resolution to PTY plans.
3. Teach the broker to accept and execute resolved PTY plans.
4. Add a headless app-server plan path with an OpenCode protocol driver.
5. Add capability-aware runtime checks for PTY-only operations.
6. Add attached broker control RPCs for dynamic resolvers.
7. Add detached-mode validation for dynamic resolvers and in-process decision hooks.
8. Document static Claude, dynamic Codex, and OpenCode headless app-server examples.
