# Agent Relay Core Simplification Scope

This document defines the package boundary for the SemVer-major Agent Relay core simplification and records what remains in scope after the implementation cutover.

## Product framing

Agent Relay is the public product. It provides real-time coordination between AI agents, tools, services, and humans through shared workspaces.

Relaycast is the backing transport. It owns the low-level message bus responsibilities: workspace identity, agent identity, channels, direct messages, threads, WebSocket events, presence, read state, delivery state, and command/action routing.

The docs should lead with Agent Relay. Relaycast should appear as the transport layer when users need to understand routing, credentials, or compatibility.

## Core SDK scope

`@agent-relay/sdk` is the core communication SDK. It should document and expose the primitives needed by any runtime that wants to participate in Agent Relay:

- Workspace bootstrap and lookup.
- Agent, human, and system identity registration.
- Channel messages, direct messages, group DMs, thread replies, message history, reactions, and search.
- WebSocket subscriptions for message, thread, DM, channel, presence, file, webhook, and command events.
- Presence, inbox, read receipts, read status, and idempotent sends.
- Command/action registration and invocation for typed handoffs between agents, services, and tools.
- Relaycast error helpers and transport-level types needed by SDK consumers.

The core SDK should remain useful in service agents, hosted agents, browser-compatible clients, tests, terminal harness integrations, and human-operated tooling.

## Out of core SDK scope

The following capabilities are not core SDK responsibilities:

- Starting or supervising a local broker process.
- Owning PTY or headless app-server sessions.
- Spawning Claude, Codex, Gemini, OpenCode, or arbitrary CLI harnesses.
- Injecting messages into managed harness stdin/app-server APIs.
- Tracking local harness idle state, lifecycle hooks, session IDs, release, or shutdown.
- Workflow orchestration, consensus helpers, shadow agents, persona materialization, or multi-agent run supervision.
- Bundling GitHub, Slack, browser, credential proxy, or other primitive adapters into the core package.

Those features can still exist in Agent Relay. They should be documented as optional layers rather than the core SDK contract.

## Package split

| Package               | Responsibility                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@agent-relay/sdk`    | Core Agent Relay communication over the Relaycast transport.                                                                        |
| `@agent-relay/driver` | Optional managed harness package for broker startup, PTY/headless transports, spawn/release, harness defaults, and supervised runs. |
| `agent-relay`         | CLI product entry point that can compose the SDK and driver for terminal users.                                                     |
| Primitive packages    | Domain-specific integrations that communicate through SDK messages/actions instead of living in the core SDK.                       |

The dependency direction should stay simple: driver depends on the SDK, not the other way around.

## Documentation requirements

- Describe Agent Relay as the public product and Relaycast as the backing transport.
- Present `@agent-relay/sdk` as messaging, delivery/read state, presence, and action/command APIs.
- Present `@agent-relay/driver` as optional managed harness infrastructure.
- Avoid putting spawn-first examples in the root README or SDK README.
- Keep managed Claude/Codex/Gemini/OpenCode examples in driver or CLI documentation.
- Keep changelog entries concise and impact-first under Keep a Changelog sections.

## Migration guidance

- Keep code that only registers identities, sends messages, reads inbox state, handles commands, or subscribes to events on `@agent-relay/sdk`.
- Move code that starts brokers, spawns harnesses, injects into PTYs/headless sessions, waits for idle, or shuts down managed runs to `@agent-relay/driver`.
- Treat old all-in-one SDK examples as driver examples unless they only use communication primitives.
- Preserve Relaycast compatibility terms where credentials, environment variables, or wire-level transport behavior require them.

## Removed from this branch

- The old all-in-one TypeScript SDK facade, broker client exports, communicate adapters, workflow/consensus/shadow helpers, GitHub/Slack SDK exports, browser/worker SDK exports, examples, and tests.
- Spawn-first CLI commands and attach/cloud/onboarding command trees that are not part of messaging, MCP, diagnostics, or the optional driver command group.
- Legacy ACP/OpenClaw packages that depended on the removed spawn-first SDK facade.
- CLI install hooks for bundled dashboard/acp/relayfile surfaces.

## Non-goals

- This branch does not define a new Relaycast wire protocol.
- This branch does not migrate Python/Swift SDKs.
- This branch does not remove primitive packages that can still integrate through SDK messages/actions.
