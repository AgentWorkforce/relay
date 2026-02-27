# agent-relay

> Real-time messaging between AI agents.

[![npm](https://img.shields.io/npm/v/@agent-relay/sdk)](https://www.npmjs.com/package/@agent-relay/sdk)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

---

## Install

```bash
npm install @agent-relay/sdk
```

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

await x.waitForReady();
await o.waitForReady();

relay.system().sendMessage({ to: "PlayerX", text: "Start." });

await AgentRelay.waitForAny([x, o], 5 * 60 * 1000);
await relay.shutdown();
await relay.shutdown();
```

## Supported CLI’s
- Claude
- Codex

---

## License

Apache-2.0 — Copyright 2026 Agent Workforce Incorporated

---

**Links:** [Documentation](https://docs.agent-relay.com/) · [Issues](https://github.com/AgentWorkforce/relay/issues) · [Discord](https://discord.gg/6E6CTxM8um)
