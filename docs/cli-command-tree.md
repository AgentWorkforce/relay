# CLI Command Tree

Generated from the source command registrations on 2026-05-24. Treat source as
canonical in this working tree: local `dist/` is stale and does not include the
newer `registerLogCommands()` registration.

## Published Entrypoints

| Command | Package | Package path | Source owner |
| --- | --- | --- | --- |
| `agent-relay` | `agent-relay` | `package.json` -> `dist/src/cli/index.js` | `src/cli/index.ts`, `src/cli/bootstrap.ts` |
| `relay` | `agent-relay` | `package.json` -> `dist/src/cli/index.js` | `src/cli/index.ts`, `src/cli/bootstrap.ts` |
| `relay-openclaw` | `@agent-relay/openclaw` | `packages/openclaw/package.json` -> `packages/openclaw/bin/relay-openclaw.mjs` | `packages/openclaw/src/cli.ts` |
| `relay-acp` | `@agent-relay/acp-bridge` | `packages/acp-bridge/package.json` -> `dist/cli.js` | `packages/acp-bridge/src/cli.ts` |
| `agent-relay-browser-mcp` | `@agent-relay/browser-primitive` | `packages/browser-primitive/package.json` -> `dist/mcp-server.js` | `packages/browser-primitive/src/mcp-server.ts` |
| `agent-relay-broker` | Rust broker binary, resolved by SDK/platform packages | `packages/sdk/bin/agent-relay-broker` in dev; optional `@agent-relay/broker-*` packages in installs | `crates/broker/src/main.rs`, `crates/broker/src/cli/mod.rs` |

## `agent-relay`

Root package bin: `package.json` -> `dist/src/cli/index.js`.

Source registration root: `src/cli/bootstrap.ts`.

```text
agent-relay
|-- up                                            src/cli/commands/core.ts
|-- start <target> [cli]                          src/cli/commands/core.ts
|-- down                                          src/cli/commands/core.ts
|-- status                                        src/cli/commands/core.ts
|-- uninstall                                     src/cli/commands/core.ts
|-- version                                       src/cli/commands/core.ts (hidden)
|-- update                                        src/cli/commands/core.ts
|-- bridge [projects...]                          src/cli/commands/core.ts
|-- workflows                                     src/cli/commands/core.ts
|   `-- list                                      src/cli/commands/core.ts
|
|-- spawn <name> <cli> [task]                     src/cli/commands/agent-management.ts
|-- broker-spawn                                  src/cli/commands/agent-management.ts (hidden)
|-- agents                                        src/cli/commands/agent-management.ts (hidden)
|-- who                                           src/cli/commands/agent-management.ts
|-- agents:logs <name>                            src/cli/commands/agent-management.ts
|-- release <name>                                src/cli/commands/agent-management.ts
|-- set-model <name> <model>                      src/cli/commands/agent-management.ts
|-- agents:kill <name>                            src/cli/commands/agent-management.ts (hidden)
|
|-- send <agent> <message>                        src/cli/commands/messaging.ts
|-- read <id>                                     src/cli/commands/messaging.ts (hidden)
|-- history                                       src/cli/commands/messaging.ts
|-- inbox                                         src/cli/commands/messaging.ts
|-- replies <agent>                               src/cli/commands/messaging.ts
|
|-- cloud                                         src/cli/commands/cloud.ts
|   |-- login                                     src/cli/commands/cloud.ts
|   |-- logout                                    src/cli/commands/cloud.ts
|   |-- whoami                                    src/cli/commands/cloud.ts
|   |-- connect <provider>                        src/cli/commands/cloud.ts
|   |-- run <workflow>                            src/cli/commands/cloud.ts
|   |-- schedule <workflow>                       src/cli/commands/cloud.ts
|   |-- schedules                                 src/cli/commands/cloud.ts
|   |-- status <runId>                            src/cli/commands/cloud.ts
|   |-- logs <runId>                              src/cli/commands/cloud.ts
|   |-- sync <runId>                              src/cli/commands/cloud.ts
|   `-- cancel <runId>                            src/cli/commands/cloud.ts
|
|-- login                                         src/cli/commands/proactive-bootstrap.ts
|-- init <name>                                   src/cli/commands/proactive-bootstrap.ts
|-- workspaces                                    src/cli/commands/proactive-bootstrap.ts
|   `-- create <name>                             src/cli/commands/proactive-bootstrap.ts
|-- tokens                                        src/cli/commands/proactive-bootstrap.ts
|   `-- issue                                     src/cli/commands/proactive-bootstrap.ts
|
|-- metrics                                       src/cli/commands/monitoring.ts (hidden)
|-- health                                        src/cli/commands/monitoring.ts
|-- profile <command...>                          src/cli/commands/monitoring.ts (hidden)
|
|-- auth <provider>                               src/cli/commands/auth.ts
|-- setup                                         src/cli/commands/setup.ts (hidden)
|-- telemetry [action]                            src/cli/commands/setup.ts
|-- run <file>                                    src/cli/commands/setup.ts
|-- swarm                                         src/cli/commands/swarm.ts
|-- on [cli]                                      src/cli/commands/on.ts
|-- off                                           src/cli/commands/on.ts
|-- connect <provider>                            src/cli/commands/connect.ts (deprecated)
|
|-- dlq                                           src/cli/commands/dlq.ts
|   |-- list                                      src/cli/commands/dlq.ts
|   |-- inspect <event-id>                        src/cli/commands/dlq.ts
|   |-- replay [event-id]                         src/cli/commands/dlq.ts
|   `-- purge                                     src/cli/commands/dlq.ts
|
|-- view <name>                                   src/cli/commands/view.ts
|-- activity                                      src/cli/commands/activity.ts
|-- drive <name>                                  src/cli/commands/drive.ts
|-- passthrough <name>                            src/cli/commands/passthrough.ts
|-- new <name> <cli> [args...]                    src/cli/commands/new.ts
|-- rm <name>                                     src/cli/commands/rm.ts
|
`-- log                                           src/cli/commands/log.ts
    |-- path                                      src/cli/commands/log.ts
    |-- list [brokerId]                           src/cli/commands/log.ts
    |-- view <brokerId>                           src/cli/commands/log.ts
    |-- rotate                                    src/cli/commands/log.ts
    `-- clear                                     src/cli/commands/log.ts
```

There is also a pre-Commander shorthand in `src/cli/bootstrap.ts`:

```text
agent-relay -n NAME CLI [args...]
`-- dispatches like: agent-relay new NAME CLI --attach --mode passthrough --ephemeral
```

## `relay`

`relay` is published as a second bin for the same CLI entrypoint, but it is not
currently just an alias. `src/cli/bootstrap.ts` passes the resolved program name
into `createProgram()`, and `src/cli/commands/relay-runtime.ts` only registers
its proactive-runtime commands when `program.name() === "relay"`.

Current blocker: the source registration order registers
`src/cli/commands/proactive-bootstrap.ts` first, which creates `init <name>`.
Then `src/cli/commands/relay-runtime.ts` tries to create `init [name]`. Commander
rejects the duplicate command, so constructing `createProgram({ name: "relay" })`
throws before the `relay` command tree can be used.

Intended `relay`-only additions:

```text
relay
|-- init [name]                                   src/cli/commands/relay-runtime.ts
|-- deploy <file>                                 src/cli/commands/relay-runtime.ts
|-- logs                                          src/cli/commands/relay-runtime.ts
|
|-- agents                                        src/cli/commands/relay-runtime.ts
|   |-- list                                      src/cli/commands/relay-runtime.ts
|   |-- inspect <agent>                           src/cli/commands/relay-runtime.ts
|   `-- undeploy <agent>                          src/cli/commands/relay-runtime.ts
|
`-- secrets                                       src/cli/commands/relay-runtime.ts
    |-- create <name>                             src/cli/commands/relay-runtime.ts
    |-- get <name>                                src/cli/commands/relay-runtime.ts
    `-- delete <name>                             src/cli/commands/relay-runtime.ts
```

## `agent-relay-broker`

Rust entrypoint: `crates/broker/src/main.rs`.

Clap command tree: `crates/broker/src/cli/mod.rs`.

```text
agent-relay-broker
|-- init                                          crates/broker/src/cli/mod.rs
|-- pty <cli> -- [args...]                        crates/broker/src/cli/mod.rs
|-- headless <provider> -- [args...]              crates/broker/src/cli/mod.rs
|-- mcp-args                                      crates/broker/src/cli/mod.rs
|-- swarm                                         crates/broker/src/swarm.rs
|-- dump-pty <name>                               crates/broker/src/cli/mod.rs
`-- wrap <cli> [args...]                          crates/broker/src/cli/mod.rs (hidden/internal)
```

Note: `crates/broker/src/config.rs` also defines a Clap parser for a legacy
flat `agent-relay-broker <command> [args...]` shape, but `crates/broker/src/lib.rs`
routes the binary through `cli::run()`, so `crates/broker/src/cli/mod.rs` is the
active command tree.

## `relay-openclaw`

Package bin: `packages/openclaw/package.json`.

Runtime shim: `packages/openclaw/bin/relay-openclaw.mjs`.

Manual parser: `packages/openclaw/src/cli.ts`.

```text
relay-openclaw
|-- setup [key]                                   packages/openclaw/src/cli.ts
|-- gateway                                       packages/openclaw/src/cli.ts
|-- status                                        packages/openclaw/src/cli.ts
|-- spawn                                         packages/openclaw/src/cli.ts
|-- list                                          packages/openclaw/src/cli.ts
|-- release                                       packages/openclaw/src/cli.ts
|-- mcp-server                                    packages/openclaw/src/cli.ts
|-- add-workspace [key]                           packages/openclaw/src/cli.ts
|-- list-workspaces                               packages/openclaw/src/cli.ts
|-- switch-workspace <alias-or-id>                packages/openclaw/src/cli.ts
|-- runtime-setup                                 packages/openclaw/src/cli.ts
|-- help                                          packages/openclaw/src/cli.ts
`-- --version | -v | version                      packages/openclaw/src/cli.ts
```

## `relay-acp`

Package bin: `packages/acp-bridge/package.json`.

Manual parser: `packages/acp-bridge/src/cli.ts`.

```text
relay-acp [options]
|-- --name <name>                                 packages/acp-bridge/src/cli.ts
|-- --socket <path>                               packages/acp-bridge/src/cli.ts
|-- --debug                                       packages/acp-bridge/src/cli.ts
|-- --help | -h                                   packages/acp-bridge/src/cli.ts
`-- --version | -v                                packages/acp-bridge/src/cli.ts
```

## `agent-relay-browser-mcp`

Package bin: `packages/browser-primitive/package.json`.

MCP JSON-RPC stdio server: `packages/browser-primitive/src/mcp-server.ts`.

This is a machine-facing MCP server rather than a human command tree. Its
runtime surface is JSON-RPC methods and MCP tools inside
`BrowserMcpServer.dispatch()`.

## Cleanup Targets

1. `relay` currently collides on `init`: `proactive-bootstrap.ts` registers
   `init <name>`, then `relay-runtime.ts` registers `init [name]`.
2. `relay` is semantically different from `agent-relay` even though both bins
   point to the same entrypoint. Decide whether it should stay a distinct
   product surface or become a true alias.
3. `agents` is overloaded: `agent-management.ts` owns a hidden root `agents`
   command for local spawned workers, while `relay-runtime.ts` unhides/reuses it
   for deployed proactive agents.
4. `agents:logs` and `agents:kill` coexist with an `agents` group. If the CLI is
   cleaned up, `agents logs` and `agents kill` would be a more consistent tree.
5. Cloud/proactive concepts are spread across root (`login`, `init`,
   `workspaces`, `tokens`), `cloud *`, and intended `relay *` commands.
6. `connect <provider>` is deprecated but still visible at the root.
7. Hidden/internal commands should be reviewed as an explicit policy set:
   `version`, `broker-spawn`, `agents`, `agents:kill`, `read`, `metrics`,
   `profile`, and `setup`.
8. `src/cli/commands/doctor.ts` exists but is not registered by
   `src/cli/bootstrap.ts`; `on --doctor` uses `src/cli/commands/on/prereqs.ts`.
