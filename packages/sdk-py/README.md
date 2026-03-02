# Agent Relay Python SDK

Python SDK for real-time agent-to-agent communication. Spawn AI agents, send messages, and coordinate multi-agent workflows with a simple async API.

## Install

```bash
pip install agent-relay
```

The SDK automatically downloads the broker binary on first use — no additional setup required.

## Quick Start

```python
import asyncio
from agent_relay import AgentRelay, Models

async def main():
    relay = AgentRelay(channels=["dev"])

    # Event hooks
    relay.on_message_received = lambda msg: print(f"[{msg.from_name}]: {msg.text}")
    relay.on_agent_ready = lambda agent: print(f"  ✓ {agent.name} ready")
    relay.on_agent_exited = lambda agent: print(f"  ✗ {agent.name} exited")

    # Spawn agents
    await relay.claude.spawn(
        name="Reviewer",
        model=Models.Claude.OPUS,
        channels=["dev"],
        task="Review the PR and suggest improvements",
    )

    await relay.codex.spawn(
        name="Builder",
        model=Models.Codex.GPT_5_3_CODEX,
        channels=["dev"],
        task="Implement the suggested improvements",
    )

    # Wait for both agents to be ready
    await asyncio.gather(
        relay.wait_for_agent_ready("Reviewer"),
        relay.wait_for_agent_ready("Builder"),
    )

    # Let agents collaborate, then shut down
    await asyncio.sleep(600)
    await relay.shutdown()

asyncio.run(main())
```

## API

### AgentRelay

The main entry point. Pass `channels` to subscribe to message channels.

```python
relay = AgentRelay(channels=["dev", "planning"])
```

### Spawning Agents

Use runtime-specific spawners:

```python
await relay.claude.spawn(name="Agent1", model=Models.Claude.SONNET, channels=["dev"], task="...")
await relay.codex.spawn(name="Agent2", model=Models.Codex.GPT_5_3_CODEX, channels=["dev"], task="...")
await relay.gemini.spawn(name="Agent3", model=Models.Gemini.GEMINI_2_5_PRO, channels=["dev"], task="...")
```

### Sending Messages

```python
human = relay.system()
await human.send_message(to="Agent1", text="Please start the analysis")
```

### Event Hooks

```python
relay.on_message_received = lambda msg: ...   # New message
relay.on_agent_ready = lambda agent: ...       # Agent connected
relay.on_agent_exited = lambda agent: ...      # Agent exited
relay.on_agent_spawned = lambda agent: ...     # Agent spawned
relay.on_worker_output = lambda data: ...      # Agent output
relay.on_agent_idle = lambda agent: ...        # Agent idle
```

### Models

```python
Models.Claude.OPUS
Models.Claude.SONNET
Models.Claude.HAIKU

Models.Codex.GPT_5_2_CODEX
Models.Codex.GPT_5_3_CODEX

Models.Gemini.GEMINI_2_5_PRO
Models.Gemini.GEMINI_2_5_FLASH
```

## Workflow Builder (Advanced)

For structured DAG-based workflows, the builder API is also available:

```python
from agent_relay import workflow

result = (
    workflow("ship-feature")
    .agent("planner", cli="claude", role="Planning lead")
    .agent("builder", cli="codex", role="Implementation engineer")
    .step("plan", agent="planner", task="Create a detailed plan")
    .step("build", agent="builder", task="Implement the plan", depends_on=["plan"])
    .run()
)
```

## Requirements

- Python 3.10+

## License

Apache-2.0 -- Copyright 2025-2026 Agent Workforce Incorporated
