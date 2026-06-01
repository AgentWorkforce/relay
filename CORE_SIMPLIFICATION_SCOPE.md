# Agent Relay Core Simplification Scope

This document defines the package boundary for the SemVer-major Agent Relay core simplification and records what remains in scope after the implementation cutover.

## Product framing

Agent Relay is the public product. It provides real-time coordination between AI agents, tools, services, and humans through shared workspaces.

The backing message bus is an implementation detail. Public docs should lead with Agent Relay concepts: messaging, delivery, and actions. Transport-specific names should appear only in code internals, compatibility notes, or migration details that cannot be explained accurately otherwise.

## Core SDK scope

`@agent-relay/sdk` is the core communication SDK. It should document and expose the primitives needed by any runtime that wants to participate in Agent Relay:

- Workspace bootstrap and lookup.
- Agent, human, and system identity registration.
- Channel messages, direct messages, group DMs, thread replies, message history, reactions, and search.
- WebSocket subscriptions for message, thread, DM, channel, presence, file, webhook, and command events.
- Presence, inbox, read receipts, read status, and idempotent sends.
- Command/action registration and invocation for typed handoffs between agents, services, and tools.
- Agent token recovery helpers and transport-level types needed by SDK consumers.

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

| Package                       | Responsibility                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@agent-relay/sdk`            | Core Agent Relay communication: messaging, delivery, and actions.                                                                   |
| `@agent-relay/harness-driver` | Optional managed harness package for broker startup, PTY/headless transports, spawn/release, harness defaults, and supervised runs. |
| `agent-relay`                 | CLI product entry point that can compose the SDK and driver for terminal users.                                                     |
| Primitive packages            | Domain-specific integrations that communicate through SDK messages/actions instead of living in the core SDK.                       |

The dependency direction should stay simple: runtime depends on the SDK, not the other way around.

## Documentation requirements

- Describe Agent Relay as the public product. Keep the backing transport out of public examples.
- Present `@agent-relay/sdk` as messaging, delivery/read state, presence, and action APIs.
- Present `@agent-relay/harness-driver` as optional managed harness infrastructure.
- Avoid putting spawn-first examples in the root README or SDK README.
- Keep managed Claude/Codex/Gemini/OpenCode examples in driver or CLI documentation.
- Keep changelog entries concise and impact-first under Keep a Changelog sections.

## Migration guidance

- Keep code that only registers identities, sends messages, reads inbox state, handles commands, or subscribes to events on `@agent-relay/sdk`.
- Move code that starts brokers, spawns harnesses, injects into PTYs/headless sessions, waits for idle, or shuts down managed runs to `@agent-relay/harness-driver`.
- Treat old all-in-one SDK examples as driver examples unless they only use communication primitives.
- Preserve transport compatibility terms only where credentials, environment variables, or wire-level behavior require them.

## Removed from this branch

- The old all-in-one TypeScript SDK facade, broker client exports, communicate adapters, workflow/consensus/shadow helpers, GitHub/Slack SDK exports, browser/worker SDK exports, examples, and tests.
- Spawn-first CLI commands and attach/cloud/onboarding command trees that are not part of messaging, MCP, diagnostics, or the optional driver command group.
- CLI install hooks for bundled dashboard/acp/relayfile surfaces.

## Kept as adapters

- `@agent-relay/openclaw` remains as an OpenClaw adapter package and uses SDK messaging plus `@agent-relay/harness-driver` for managed spawn internals instead of spawn-first SDK APIs.

## Moved out

- `@agent-relay/acp-bridge` lives in `AgentWorkforce/agent-relay-acp-bridge` and is no longer a workspace package in this repository.

## Non-goals

- This branch does not define a new wire protocol.
- This branch does not migrate Python/Swift SDKs.
- This branch does not remove primitive packages that can still integrate through SDK messages/actions.
