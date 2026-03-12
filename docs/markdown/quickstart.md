# Quickstart

Spawn your first agents and send messages between them.

## Install

### TypeScript

```bash
npm install @agent-relay/sdk
```

### Python

```bash
pip install agent-relay-sdk
```

## Spawn Agents and Send a Message

### TypeScript

```typescript
import { AgentRelay, Models } from '@agent-relay/sdk';

const relay = new AgentRelay();

// Spawn a planner (Claude) and a coder (Codex)
const planner = await relay.claude.spawn({
  name: 'Planner',
  model: Models.Claude.OPUS
});

const coder = await relay.codex.spawn({
  name: 'Coder',
  model: Models.Codex.GPT_5_3_CODEX
});

// Listen for messages
relay.onMessageReceived = (msg) => {
  console.log(`${msg.from} → ${msg.to}: ${msg.text}`);
};

// Send a message from Planner to Coder
await planner.sendMessage({ to: 'Coder', text: 'Implement the auth module' });

await relay.shutdown();
```

### Python

```python
import asyncio
from agent_relay import AgentRelay, Models

async def main():
    relay = AgentRelay(channels=["dev"])

    # Listen for messages
    relay.on_message_received = lambda msg: print(f"[{msg.from_name}]: {msg.text}")

    # Spawn a planner (Claude) and a coder (Codex)
    await relay.claude.spawn(
        name="Planner",
        model=Models.Claude.OPUS,
        channels=["dev"],
        task="Plan the feature implementation",
    )

    await relay.codex.spawn(
        name="Coder",
        model=Models.Codex.GPT_5_3_CODEX,
        channels=["dev"],
        task="Implement the plan",
    )

    # Wait for both agents to be ready
    await asyncio.gather(
        relay.wait_for_agent_ready("Planner"),
        relay.wait_for_agent_ready("Coder"),
    )

    # Send a message from system to Coder
    human = relay.system()
    await human.send_message(to="Coder", text="Implement the auth module")

    await relay.shutdown()

asyncio.run(main())
```

## Supported CLIs

| CLI      | Constant prefix     |
| -------- | ------------------- |
| Claude   | `Models.Claude.*`   |
| Codex    | `Models.Codex.*`    |
| Gemini   | `Models.Gemini.*`   |
| OpenCode | `Models.OpenCode.*` |

## Next Steps

- [TypeScript SDK Reference](reference/sdk.md) — Complete TypeScript API reference.
- [Python SDK Reference](reference/sdk-py.md) — Complete Python API reference.
