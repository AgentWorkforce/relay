# agent-relay

> Real-time agent-to-agent communication. Rust broker + TypeScript SDK.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

---

## Overview

Agent Relay enables real-time communication between AI agents. It uses [Relaycast](https://relaycast.dev) as a headless message transport and provides a Rust broker binary that manages agent lifecycles (PTY workers, headless Claude) with a TypeScript SDK for programmatic control.

## Architecture

```
┌──────────────────────────┐
│        Relaycast         │
│     (headless Slack)     │
└────────────┬─────────────┘
             │
     ┌───────┴───────┐
     │   relay SDK   │
     └───────┬───────┘
             │
     ┌───────┴───────┐
     │    broker     │
     │  (agent-relay │
     │    binary)    │
     └───┬───────┬───┘
         │       │
    ┌────┴──┐ ┌──┴────────┐
    │  PTY  │ │ headless  │
    │worker │ │  agent    │
    └───────┘ └───────────┘
```

## Install

**Binary (no Node.js required):**
```bash
curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash
```

**SDK (for programmatic use):**
```bash
npm install @agent-relay/sdk
```

## Quick Start

```typescript
import { AgentRelay } from "@agent-relay/sdk";

const relay = new AgentRelay();

// Spawn agents
const codex = await relay.codex.spawn({ name: "Worker", task: "Build the feature" });
const claude = await relay.claude.spawn({ name: "Reviewer", task: "Review code changes" });

// Listen for messages
relay.onMessageReceived = (msg) => {
  console.log(`${msg.from}: ${msg.body}`);
};

// Send messages
await codex.sendMessage({ body: "Ready for review" });

// Clean up
await relay.shutdown();
```

## CLI

The `agent-relay` binary has four modes:

| Command | Description |
|---------|-------------|
| `agent-relay init` | Start as broker (manages agents, routes messages) |
| `agent-relay pty <cli> [args]` | Wrap a CLI in a PTY with message injection |
| `agent-relay headless claude [args]` | Run headless Claude worker |
| `agent-relay listen` | Connect to Relaycast without wrapping a CLI |

## Development

```bash
# Build
cargo build --release

# Test
cargo test

# Lint
cargo clippy -- -D warnings

# SDK type check
cd packages/sdk-ts && npx tsc --noEmit
```

## License

Apache-2.0 — Copyright 2025 Agent Workforce Incorporated

---

**Links:** [Documentation](https://docs.agent-relay.com/) · [Issues](https://github.com/AgentWorkforce/relay/issues) · [Relaycast](https://relaycast.dev)
