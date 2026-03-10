# Introduction

Programmatically spawn and coordinate AI agents from TypeScript or Python.

The Agent Relay SDK lets you spawn AI agents (Claude, Codex) and coordinate them from code — send messages between agents, listen for responses, and shut them down when done. Available for both TypeScript and Python.

## Install

### TypeScript

```bash
npm install @agent-relay/sdk
```

### Python

```bash
pip install agent-relay-sdk
```

## What You Can Do

- **Spawn Agents** — Programmatically create Claude or Codex agents with a specific model and task.
- **Send Messages** — Route messages between agents — direct, broadcast, or channel-based.
- **Listen for Responses** — Subscribe to incoming messages and react in real-time.
- **Multi-Provider** — Mix Claude and Codex agents in a single workflow, each using their strengths.

## LLM / Machine-Readable Docs

You're reading the plain Markdown version. These docs mirror the [Mintlify site](https://docs.agent-relay.com) but are designed for LLMs, CLI tools, and programmatic access — no MDX components, no JavaScript.

All markdown docs: [github.com/AgentWorkforce/relay/tree/main/docs/markdown](https://github.com/AgentWorkforce/relay/tree/main/docs/markdown)

## Next Steps

- [Quickstart](quickstart.md) — Get your first agents talking to each other in minutes.
- [TypeScript SDK](reference/sdk.md) — Full API reference for the TypeScript SDK.
- [Python SDK](reference/sdk-py.md) — Full API reference for the Python SDK.
