![Agent Relay](./readme-banner.png)

<div align="center">

[![Featured on OSSCAR](https://osscar.dev/api/badge?slug=agentworkforce)](https://osscar.dev/org/agentworkforce)

Agent Relay is real-time communication infrastructure for agent-to-agent work. Spawn agents from code, give them shared channels, direct messages, threads, reactions, and presence, and let them coordinate in the same workspace.

It is not a framework or a harness. Your agents keep running however they already run. Agent Relay is the communication layer that helps them talk to each other and take action together.

**Website:** [agentrelay.com](https://agentrelay.com) · **Docs:** [agentrelay.com/docs](https://agentrelay.com/docs)

<a href="https://www.npmjs.com/package/@agent-relay/sdk"><img alt="npm" src="https://img.shields.io/npm/v/@agent-relay/sdk"></a>
<a href="https://github.com/AgentWorkforce/relay/actions/workflows/test.yml"><img alt="Tests" src="https://img.shields.io/github/actions/workflow/status/AgentWorkforce/relay/test.yml?branch=main&label=tests"></a>
<a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>

</div>

## Why Agent Relay

- **Built for real-time coordination**: channels, messages, inboxes, reactions, and presence for agents that need to collaborate.
- **Works with terminal-native agents**: use Claude Code, Codex, Gemini CLI, OpenCode, and other supported runtimes without changing how they run.
- **SDK-first**: spawn agents programmatically, route work, wait for readiness, and manage lifecycles from TypeScript or Python.
- **Useful from both code and tools**: wire Relay into apps, scripts, plugins, and local workflows.

## Multi Agent Orchestration

Enable your Claude Code, Codex, Opencode agent spawn agent teams that can communicate and collaborate. Not subagents, but real agents who
could spawn their own subagents. This allows for powerful AI cross collaboration so you can get the best harnesses + models working
together.

## Benefits Over Subagents

1. The agent orchestrating has full insight what the spawned agents are doing. It can read the logs and steer mid turn if needed
2. Enables advanced swarm techniques as each agent can communicate with each other and coordinate to form agent teams for different types: review/fix loops, adversarial/debate pairs, fan-out -> pipeline -> gather, or lead + workers to name a few
3. Diversity of thought and implementation. Codex implement, Claude review, Gemini do the final verification leads to better results as different models + harnesses excel in different things.
4. Review happens as a conversation between the live reviewer and the live implementer, not as a report handed back to the parent after each one finishes.
5. Audit trail exists outside the agent and outside the parent. With the [Agent Relay Observer](https://agentrelay.com/observer) you get full auditability into every single DM and group message sent by the agents.

## Get Started

1. Install the agent-relay cli

```
curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash

```

2. Install the skill

```
npx skills add https://github.com/agentworkforce/skills --skill orchestrating-agent-relay
```

3. Tell your agent to use it

```
use the orchestrating-agent-relay skill to spawn a claude and codex agent and [YOUR_TASK]
```

For single, well-scoped, one-shot tasks, subagents still win. Agent relay's advantages compound when work is multi-step, multi-role, long-running or needs independent verification.

## SDK

Use the Agent Relay SDK to spawn and control agents programmatically.

### Install

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

### Quick example

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

- [Introduction](https://agentrelay.com/docs/introduction)
- [TypeScript SDK README](https://agentrelay.com/docs/typescript-sdk)
- [Python SDK README](https://agentrelay.com/docs/python-sdk)

### What you can build

- Multi-agent coding flows with shared channels and worker handoffs
- Agent inboxes for status updates, blockers, and review loops
- Tooling that lets existing agents communicate without rewriting their runtime
- Local or remote coordination patterns where multiple agents need shared context

Then use Agent Relay to bring agents into a shared workspace and route work between them.

## Supported agents and runtimes

Agent Relay is designed for terminal-native agents and SDK-driven workflows. This repo currently includes first-class support for:

- Claude Code
- Codex CLI
- Gemini CLI
- OpenCode

The broader SDK and workflow surface also includes additional integrations in the codebase. See the package docs for details.

### Development

If you want to work on the repo itself:

```bash
npm install
npm run build
npm test
```

Useful references:

- [CHANGELOG.md](./CHANGELOG.md)
- [GitHub Issues](https://github.com/AgentWorkforce/relay/issues)

## License

Apache-2.0 — Copyright 2026 Agent Workforce Incorporated

---

**Links:** [Website](https://agentrelay.com) · [Documentation](https://agentrelay.com/docs) · [Docs (Markdown)](https://agentrelay.com/docs/markdown) · [Discord](https://discord.gg/6E6CTxM8um)
