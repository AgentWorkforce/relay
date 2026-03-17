# agent-relay

> Real-time messaging between AI agents.

[![npm](https://img.shields.io/npm/v/@agent-relay/sdk)](https://www.npmjs.com/package/@agent-relay/sdk)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

---

## Install

**TypeScript / Node.js**
```bash
npm install @agent-relay/sdk
# or
bun add @agent-relay/sdk
```

**Python**
```bash
pip install agent-relay-sdk
```

See the [Python SDK](./packages/sdk-py) for full documentation.

## Documentation

- **Web:** [docs.agent-relay.com](https://docs.agent-relay.com/)
- **Markdown:** [docs/markdown/](docs/markdown/) — plain-text docs for LLMs and terminal use

## Usage

```typescript
import { AgentRelay, Models } from "@agent-relay/sdk";

const relay = new AgentRelay();

relay.onMessageReceived = (msg) =>
  console.log(`[${msg.from} → ${msg.to}]: ${msg.text}`);

const channel = ["tic-tac-toe"];

const x = await relay.claude.spawn({
  name: "PlayerX",
  model: Models.Claude.SONNET,
  channels: channel,
  task: "Play tic-tac-toe as X against PlayerO. You go first.",
});
const o = await relay.codex.spawn({
  name: "PlayerO",
  model: Models.Codex.GPT_5_3_CODEX_SPARK,
  channels: channel,
  task: "Play tic-tac-toe as O against PlayerX.",
});

console.log("Waiting for agents to be ready...");
await Promise.all([
  relay.waitForAgentReady("PlayerX"),
  relay.waitForAgentReady("PlayerO"),
]);
console.log("Both ready. Starting game.");

relay.system().sendMessage({ to: "PlayerX", text: "Start." });

const FIVE_MINUTES = 5 * 60 * 1000;
await AgentRelay.waitForAny([x, o], FIVE_MINUTES);
await relay.shutdown();
```

## Claude Code Plugin

Use Agent Relay directly inside Claude Code — no SDK required. The plugin adds multi-agent coordination via slash commands or natural language.

```
/plugin marketplace add Agentworkforce/relay
```

Once installed, coordinate agents with built-in skills:

```
> /relay-team Refactor the auth module — split the middleware, update tests, and update docs
> /relay-fanout Run linting fixes across all packages in the monorepo
> /relay-pipeline Analyze the API logs, then generate a summary report, then draft an email
```

Or just describe what you want in plain language:

```
> Use relay fan-out to lint all packages in parallel
> Split the migration into three relay workers — one for the schema, one for the API, one for the frontend
```

See the [plugin README](plugins/claude-relay-plugin/README.md) for full details.

## Supported CLI’s
- Claude
- Codex
- Gemini
- Opencode

---

## License

Apache-2.0 — Copyright 2026 Agent Workforce Incorporated

---

**Links:** [Documentation](https://docs.agent-relay.com/) · [Docs (Markdown)](https://github.com/AgentWorkforce/relay/tree/main/README.md) · [Issues](https://github.com/AgentWorkforce/relay/issues) · [Discord](https://discord.gg/6E6CTxM8um)

> **Plain-text docs:** All documentation is available as Markdown directly in this repository. Browse the repo on GitHub for the raw `.md` files, or fetch from your terminal:
> ```bash
> curl https://raw.githubusercontent.com/AgentWorkforce/relay/main/README.md
> ```
