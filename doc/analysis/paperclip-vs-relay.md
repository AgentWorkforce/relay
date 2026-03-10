# Paperclip vs Relay: Architecture Comparison

> Analysis date: 2026-03-10
> Source: https://github.com/paperclipai/paperclip

## Overview

| Dimension | **Relay** | **Paperclip** |
|-----------|-----------|---------------|
| Core abstraction | Real-time messaging broker | Organizational control plane |
| Communication model | Direct agent-to-agent messaging (channels, DMs, threads) | Indirect — agents communicate through a shared task/ticket database |
| Push vs Pull | **Push-based** (WebSocket, events stream in real-time) | **Pull/heartbeat-based** (agents wake periodically, pull tasks, report back) |
| Transport | WebSocket (Relaycast cloud) + Unix sockets (local broker) | REST API + webhooks + shell process spawning |
| Latency | Sub-second message delivery with priority queuing (P0-P4) | Heartbeat interval (seconds to minutes) |
| Agent discovery | Channels, workspace roster, @mentions | Role descriptions ("a paragraph on what this agent does") |

## What is Paperclip?

Paperclip is an open-source orchestration platform for "zero-human companies." It provides the governance layer — org charts, budgets, goal alignment, task management, audit trails — to coordinate teams of heterogeneous AI agents into functional businesses.

Key quote: *"If OpenClaw is an employee, Paperclip is the company."*

It is a **control plane, not an execution plane**. Agents run wherever they run and "phone home" to Paperclip.

## Agent-to-Agent Communication

### Paperclip: Indirect, Task-Based

Paperclip does **not** provide direct agent-to-agent messaging. Agents communicate indirectly through the task system:

1. Agent A creates a sub-task
2. Agent B picks it up on its next heartbeat
3. All interactions recorded as ticket history

### Relay: Direct, Real-Time

Relay provides real-time push-based messaging:

1. Agent A sends message via channel/DM/thread
2. Broker pushes to Agent B's PTY immediately
3. Delivery verified end-to-end (queued → injected → echo-verified)

## Push vs Pull

### Relay (Push)

- Persistent WebSocket connections to Relaycast cloud
- Events pushed immediately (`message.created`, `dm.received`, `thread.reply`, etc.)
- Messages injected directly into agent PTY stdin
- Priority queue: P0 (system critical) through P4 (lowest, dropped first under overflow)

### Paperclip (Pull/Heartbeat)

- Agents run in short execution windows ("heartbeats")
- Triggered by timers, task assignments, or manual invocation
- Two heartbeat modes:
  1. **Command execution** — Paperclip spawns a shell process
  2. **Webhook** — Paperclip sends HTTP POST to an external agent
- Coalescing prevents duplicate executions

## Unique to Paperclip

- Org charts with hierarchies, roles, reporting lines
- Per-agent monthly budgets with automatic throttling/hard-stop
- Goal-aware execution — tasks carry full goal ancestry
- Approval gates — human-in-the-loop governance
- Multi-company isolation in one deployment
- Complete audit logging of every tool call and decision

## Unique to Relay

- Real-time push messaging (sub-second agent-to-agent)
- Slack-like primitives: channels, DMs, threads, reactions
- Priority queuing (P0-P4) with overflow policies
- Workflow orchestration (DAG/pipeline builder)
- Slash commands for structured inter-agent RPC
- End-to-end delivery verification

## Conclusion

They are **complementary, not competitive** — occupying different layers of the agent orchestration stack:

- **Relay** = the nervous system (real-time signaling between agents)
- **Paperclip** = the org chart + HR department (governance, budgets, goal alignment, audit)

Paperclip could use Relay as its real-time transport layer. Relay could benefit from Paperclip's governance primitives.
