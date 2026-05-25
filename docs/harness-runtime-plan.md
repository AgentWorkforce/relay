# Harness Runtime Plan

## Goal

Harnesses should be user-extensible without requiring Rust changes for normal
agent CLIs. The Rust broker should own durable runtime execution, lifecycle
tracking, routing, delivery queues, retries, and observability. SDKs should be
able to define named harnesses that resolve to broker-executable JSON plans.

## Core Model

The broker supports two runtime executors first:

- `pty`: runs a command inside a PTY and manages terminal-oriented delivery.
- `app_server`: talks to an existing or broker-owned app-server session.

Named harnesses such as `codex`, `qwen`, or `opencode-server` resolve to one of
those executable shapes.

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
    mode: 'pty-injection';
    format?: 'relay-block';
  };
  metadata?: Record<string, unknown>;
};
```

App-server plans are session backed:

```ts
type AppServerHarnessPlan = {
  runtime: 'app_server';
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
    ownership: 'broker-owned' | 'attached';
    pid?: number;
  };
  release?: 'abort' | 'detach' | 'delete';
  metadata?: Record<string, unknown>;
};
```

The broker runs the returned plan. It does not need to understand arbitrary
TypeScript or Python logic.

## Harness Definition Classes

Static harness definitions are JSON-compatible and work in attached or detached
brokers:

```ts
const harnesses = {
  qwen: {
    runtime: 'pty',
    command: 'qwen',
    args: ['run', '{modelArgs}', '{args}'],
    modelArgs: ['-m', '{model}'],
    searchPaths: ['~/.local/bin'],
  },
};
```

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
      env: ctx.env,
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

This lets users add a CLI like Qwen Code locally with config only. A Rust
contribution is only needed when Relay wants a built-in with tested defaults or
the CLI needs broker-side behavior.

## App-Server Runtime

The app-server executor consumes an app-server plan. For OpenCode, the adapter
can attach to a local or remote `opencode serve` endpoint, create or receive a
session id, deliver Relay messages through the session message API, and release
by aborting, detaching, or deleting the session.

App-server runtimes do not expose PTY input, resize, or snapshot capabilities.

## Hooks

Event hooks are non-blocking subscriptions:

```ts
relay.on('agent.spawned', async (event) => {
  await posthog.capture(...);
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
4. Add an app-server plan path with an OpenCode protocol driver.
5. Add capability-aware runtime checks for PTY-only operations.
6. Add attached broker control RPCs for dynamic resolvers.
7. Add detached-mode validation for dynamic resolvers and in-process decision hooks.
8. Document static Qwen, dynamic Codex, and OpenCode app-server examples.
