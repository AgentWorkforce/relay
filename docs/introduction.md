# Introduction

Spawn, coordinate, and connect AI agents from TypeScript or Python.

The Agent Relay SDK has two modes:

- **Orchestrate** — Spawn and manage AI agents (Claude, Codex, Gemini, OpenCode) from code. Send messages, listen for responses, and shut them down when done.
- **Communicate** — Put an existing framework agent "on the relay" with a single `on_relay()` / `onRelay()` call. Works with AI SDK, OpenAI Agents, Claude Agent SDK, Google ADK, Pi, Agno, Swarms, and CrewAI.

```bash
# TypeScript
npm install @agent-relay/sdk
```

```bash
# Python
pip install agent-relay-sdk
```

## Two Modes

### Orchestrate Mode

Spawn and control agents from your code:

```typescript
// TypeScript
import { AgentRelayClient } from '@agent-relay/sdk';
const client = new AgentRelayClient();
const agent = await client.spawnPty({ cli: 'claude', task: 'Review the PR' });
```

```python
# Python
from agent_relay import workflow
wf = workflow("review")
wf.agent("reviewer", cli="claude")
wf.step("review", agent="reviewer", task="Review the PR")
wf.build()
```

### Communicate Mode

Connect any framework agent to Relaycast in 3 lines:

```python
# Python
from agent_relay.communicate import Relay, on_relay
relay = Relay("MyAgent")
agent = on_relay(my_framework_agent, relay)
```

```typescript
// TypeScript
import { Relay } from '@agent-relay/sdk/communicate';
import { onRelay } from '@agent-relay/sdk/communicate/adapters/pi';
const config = onRelay('MyAgent', piConfig, new Relay('MyAgent'));
```

## What You Can Do

- **Spawn Agents** — Programmatically create Claude, Codex, Gemini, or OpenCode agents with a specific model and task.
- **Send Messages** — Route messages between agents — direct, broadcast, or channel-based.
- **Connect Frameworks** — Put OpenAI Agents, Claude SDK, Google ADK, Pi, Agno, Swarms, or CrewAI agents on the relay.
- **Multi-Provider** — Mix Claude, Codex, Gemini, and OpenCode agents in a single workflow, each using their strengths.

## Claude Code Plugin

Use Agent Relay directly inside Claude Code — no SDK required. The plugin adds multi-agent coordination via slash commands or natural language.

```bash
/plugin marketplace add Agentworkforce/skills
```

Once installed, coordinate agents with built-in skills:

```bash
/relay-team Refactor the auth module — split the middleware, update tests, and update docs
/relay-fanout Run linting fixes across all packages in the monorepo
/relay-pipeline Analyze the API logs, then generate a summary report, then draft an email
```

Or just describe what you want in plain language — the plugin's hooks and agent definitions handle the infrastructure automatically:

```bash
Use relay fan-out to lint all packages in parallel
Split the migration into three relay workers — one for the schema, one for the API, one for the frontend
```

## LLM / Machine-Readable Docs

These docs are also available as plain Markdown for LLMs, CLI tools, and programmatic access:

- [Markdown Docs on GitHub](https://github.com/AgentWorkforce/relay/tree/main/docs) — Plain-text versions of every page — no MDX components, no JavaScript. Designed for `curl`, agents, and language models.

## Next Steps

- [Quickstart](quickstart.md) — Get your first agents talking to each other in minutes.
- [Communicate Mode](communicate.md) — Put any framework agent on the relay with on_relay().
- [TypeScript SDK](reference/sdk.md) — Full API reference for the TypeScript SDK.
- [Python SDK](reference/sdk-py.md) — Full API reference for the Python SDK.
