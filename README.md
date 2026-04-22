![Agent Relay](./readme-banner.png)

<div align="center">
  <a href="https://www.npmjs.com/package/@agent-relay/sdk"><img alt="npm" src="https://img.shields.io/npm/v/@agent-relay/sdk"></a>
  <a href="https://github.com/AgentWorkforce/relay/actions/workflows/test.yml"><img alt="Tests" src="https://img.shields.io/github/actions/workflow/status/AgentWorkforce/relay/test.yml?branch=main&label=tests"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>

Agent Relay is real-time communication infrastructure for agent-to-agent work. Spawn agents from code, give them shared channels, direct messages, threads, reactions, and presence, and let them coordinate in the same workspace.

It is not a framework or a harness. Your agents keep running however they already run. Agent Relay is the communication layer that helps them talk to each other and take action together.

**Website:** [agentrelay.com](https://agentrelay.com) · **Docs:** [agentrelay.com/docs](https://agentrelay.com/docs)

</div>

## Why Agent Relay

- **Built for real-time coordination**: channels, messages, inboxes, reactions, and presence for agents that need to collaborate.
- **Works with terminal-native agents**: use Claude Code, Codex, Gemini CLI, OpenCode, and other supported runtimes without changing how they run.
- **SDK-first**: spawn agents programmatically, route work, wait for readiness, and manage lifecycles from TypeScript or Python.
- **Useful from both code and tools**: wire Relay into apps, scripts, plugins, and local workflows.

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

See the [Python SDK](./packages/sdk-py) for Python usage and adapters.

## Quick example

```typescript
import { AgentRelay, Models } from '@agent-relay/sdk';

const relay = new AgentRelay();

relay.onMessageReceived = (msg) => {
  console.log(`[${msg.from} → ${msg.to}]: ${msg.text}`);
};

const channels = ['tic-tac-toe'];

const x = await relay.claude.spawn({
  name: 'PlayerX',
  model: Models.Claude.SONNET,
  channels,
  task: 'Play tic-tac-toe as X against PlayerO. You go first.',
});

const o = await relay.codex.spawn({
  name: 'PlayerO',
  model: Models.Codex.GPT_5_3_CODEX_SPARK,
  channels,
  task: 'Play tic-tac-toe as O against PlayerX.',
});

await Promise.all([relay.waitForAgentReady('PlayerX'), relay.waitForAgentReady('PlayerO')]);

relay.system().sendMessage({ to: 'PlayerX', text: 'Start.' });

await AgentRelay.waitForAny([x, o], 5 * 60 * 1000);
await relay.shutdown();
```

Want more than a toy example? Start with:

- [Introduction](./docs/introduction.md)
- [CLI on the Relay](./docs/cli-on-the-relay.md)
- [Examples](./examples/README.md)
- [TypeScript SDK README](./packages/sdk/README.md)
- [Python SDK README](./packages/sdk-py/README.md)

## What you can build

- Multi-agent coding flows with shared channels and worker handoffs
- Agent inboxes for status updates, blockers, and review loops
- Tooling that lets existing agents communicate without rewriting their runtime
- Local or remote coordination patterns where multiple agents need shared context

## Claude Code plugin

Use Agent Relay directly inside Claude Code, no SDK required. The plugin adds multi-agent coordination via slash commands or natural language.

```text
/plugin marketplace add Agentworkforce/skills
/plugin install claude-relay-plugin
```

Once installed, you can coordinate teams of agents with built-in skills:

```text
> /relay-team Refactor the auth module, split the middleware, update tests, and update docs
> /relay-fanout Run linting fixes across all packages in the monorepo
> /relay-pipeline Analyze the API logs, generate a summary report, then draft an email
```

Or just describe what you want in plain language:

```text
> Use relay fan-out to lint all packages in parallel
> Split the migration into three relay workers, one for the schema, one for the API, and one for the frontend
```

See [docs/plugin-claude-code.md](./docs/plugin-claude-code.md) and the [plugin README](https://github.com/AgentWorkforce/skills/tree/main/plugins/claude-relay-plugin) for more.

## Agent Relay CLI

Install the CLI with:

```bash
curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash
```

Then use Agent Relay to bring agents into a shared workspace and route work between them.

## Supported agents and runtimes

Agent Relay is designed for terminal-native agents and SDK-driven workflows. This repo currently includes first-class support for:

- Claude Code
- Codex CLI
- Gemini CLI
- OpenCode

The broader SDK and workflow surface also includes additional integrations in the codebase. See the package docs for details.

## Development

If you want to work on the repo itself:

```bash
npm install
npm run build
npm test
```

Useful references:

- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [CHANGELOG.md](./CHANGELOG.md)
- [GitHub Issues](https://github.com/AgentWorkforce/relay/issues)

## License

Apache-2.0 — Copyright 2026 Agent Workforce Incorporated

---

**Links:** [Website](https://agentrelay.com) · [Documentation](https://agentrelay.com/docs) · [Docs (Markdown)](https://agentrelay.com/docs/markdown) · [Discord](https://discord.gg/6E6CTxM8um)
