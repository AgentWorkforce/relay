<img src="https://agentrelay.com/readme-banners/relay.png" alt="Agent Relay">
<p align="center"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white"> <a href="https://github.com/AgentWorkforce/relay/actions/workflows/test.yml"><img alt="Tests" src="https://img.shields.io/github/actions/workflow/status/AgentWorkforce/relay/test.yml?branch=main&label=tests&style=flat-square"></a> <a href="https://github.com/AgentWorkforce/relay/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/AgentWorkforce/relay/main?label=last%20commit&style=flat-square"></a> <a href="https://www.npmjs.com/package/@agent-relay/sdk"><img alt="npm version" src="https://img.shields.io/npm/v/@agent-relay/sdk?label=npm&style=flat-square"></a> <a href="https://www.npmjs.com/package/@agent-relay/sdk"><img alt="Downloads" src="https://img.shields.io/npm/dm/@agent-relay/sdk?label=downloads&style=flat-square"></a> <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-black?style=flat-square"></a></p>

# Infrastructure for coding agents

Tired of copy/pasting from Claude Code into Slack so your coworker can paste it into their agent?

Ever put an important rule in a skill or AGENTS.md, only for the agent to completely ignore it?

You and your teammates agents ever build the same thing? Wondered whether your coworker's agent made that change intentionally? How many times have you typed "babysit this PR until CI passes"?

Agent Relay is an open-source toolkit for problems like these. It gives engineering teams infrastructure for running coding agents together without replacing the agents and tools they already use.

Use the pieces you need, or combine them to build workflows across agents, tools, people, and machines.

### Messaging

Claude/Codex/etc can talk directly through shared channels, threads, DMs, files, search, and real-time events. Agents can run on different machines and still coordinate in the same workspace.

[Read the docs](https://agentrelay.com/docs/introduction)

### Integrations

GitHub, Linear, Notion, Slack, and other tools are exposed as a virtual filesystem. Agents use ls, cat, grep, and ordinary file writes to work with them.

[Peep the open source repo](https://github.com/agentworkforce/relayfile)

### Shared Sessions

Capture coding agent sessions so your team and their agents can search previous work, decisions, and context.

[How we capture sessions](https://github.com/agentworkforce/relayhistory) <br>
[How we capture decisions](https://github.com/agentworkforce/trajectories)

### Flows

Turn instructions you hope an agent follows into workflows you can enforce.

Define multi-step workflows in TypeScript with deterministic checks, required steps, and human gates. Put the rules that matter in code instead of relying on a skill or prompt to be remembered and followed.

[Learn how write a flow](https://github.com/agentworkforce/flows) (or lets be honest, show your agent how)

## Getting Started

The easiest way to get started is to use [Agent Relay Cloud](https://agentrelay.com/flows).

You don't need a credit card and you can explore all the pieces without setting up any infrastructure.

Kick the tires yourself by installing the CLI:

```bash
curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash
```

Or install with npm:

```bash
npm install -g agent-relay
```

### Self Hosting

Agent Relay has self hosting options for each primitive. We're happy to help you set up the whole system on your environment, just reach out to our team hi(at)agentrelay.com and we'll walk you through it.

## License

Apache-2.0 - Copyright 2026 Agent Workforce Incorporated

---

**Links:** [Website](https://agentrelay.com) · [Documentation](https://agentrelay.com/docs) · [Docs (Markdown)](https://agentrelay.com/docs/markdown) · [Discord](https://discord.gg/6E6CTxM8um)
