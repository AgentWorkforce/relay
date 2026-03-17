# Introduction

Spawn, coordinate, and connect AI agents from TypeScript or Python.

The Agent Relay SDK has two modes:

- **Orchestrate** — Spawn and manage AI agents (Claude, Codex, Gemini, OpenCode) from code. Send messages, listen for responses, and shut them down when done.
- **Communicate** — Put an existing framework agent "on the relay" with a single `on_relay()` call. Works with OpenAI Agents, Claude Agent SDK, Google ADK, Pi, Agno, Swarms, and CrewAI.

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

- **Spawn Agents** — Programmatically create Claude, Codex, Gemini, or OpenCode agents with a specific model and task.
- **Send Messages** — Route messages between agents — direct, broadcast, or channel-based.
- **Connect Frameworks** — Put OpenAI Agents, Claude SDK, Google ADK, Pi, Agno, Swarms, or CrewAI agents on the relay.
- **Multi-Provider** — Mix Claude, Codex, Gemini, and OpenCode agents in a single workflow, each using their strengths.

## LLM / Machine-Readable Docs

You're reading the plain Markdown version. These docs mirror the [Mintlify site](https://docs.agent-relay.com) but are designed for LLMs, CLI tools, and programmatic access — no MDX components, no JavaScript.

All markdown docs: [github.com/AgentWorkforce/relay/tree/main/docs/markdown](https://github.com/AgentWorkforce/relay/tree/main/docs/markdown)

## Next Steps

- [Quickstart](quickstart.md) — Get your first agents talking to each other in minutes.
- [Communicate Mode](communicate.md) — Put any framework agent on the relay with on_relay().
- [TypeScript SDK](reference/sdk.md) — Full API reference for the TypeScript SDK.
- [Python SDK](reference/sdk-py.md) — Full API reference for the Python SDK.
