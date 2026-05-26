# Agent Relay Python SDK

Python SDK for two workflows:

- `Orchestrate` mode spawns and manages AI agents from Python.
- `Communicate` mode puts an existing agent framework on Relaycast with `Relay` + `on_relay()`.

## Installation

### Orchestrate

```bash
pip install agent-relay-sdk
```

### Communicate

```bash
pip install "agent-relay-sdk[communicate]"
```

The SDK ships per-platform wheels with the broker binary embedded. `pip install` is the network boundary — no downloads happen at import or first use. Communicate mode also needs the framework package you want to wrap, such as `claude-agent-sdk`, `google-adk`, `agno`, `swarms`, or `crewai`.

## Requirements

- Python 3.10+
- A supported platform (the wheel ships a prebuilt `agent-relay-broker`):

  | Platform            | Wheel tag                                      |
  | ------------------- | ---------------------------------------------- |
  | macOS Apple Silicon | `macosx_11_0_arm64`                            |
  | macOS Intel         | `macosx_10_12_x86_64`                          |
  | Linux x86_64        | `manylinux_2_17_x86_64.manylinux2014_x86_64`   |
  | Linux aarch64       | `manylinux_2_17_aarch64.manylinux2014_aarch64` |

  Linux binaries are built statically against musl, so they install on glibc and musl distros (Debian, Ubuntu, RHEL, Alpine, …). Other platforms (Windows, FreeBSD, linux-armv7) are unsupported — `pip install` will fail with "no matching distribution found".

  To override the bundled binary (e.g. for local development against a custom broker build), set `BROKER_BINARY_PATH` or `AGENT_RELAY_BIN` to an absolute path.

## Development

For an editable install (`pip install -e packages/sdk-py`), build the broker locally and copy it into the wheel tree:

```bash
cargo build --release --bin agent-relay-broker
packages/sdk-py/scripts/sync-broker-dev.sh
```

The destination (`src/agent_relay/bin/`) is gitignored. Alternatively, set `BROKER_BINARY_PATH=$(pwd)/target/release/agent-relay-broker` in your shell.

## Choose a Mode

### Orchestrate

Use `AgentRelay` when you want Python to spawn agents, wait for readiness, route messages, and shut everything down.

```python
import asyncio
from agent_relay import AgentRelay, Models

async def main():
    relay = AgentRelay(channels=["dev"])
    relay.on_message_received = lambda msg: print(f"[{msg.from_name}]: {msg.text}")

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
        task="Implement the suggestions",
    )

    await asyncio.gather(
        relay.wait_for_agent_ready("Reviewer"),
        relay.wait_for_agent_ready("Builder"),
    )
    await relay.shutdown()

asyncio.run(main())
```

### Communicate

Use `Relay` + `on_relay()` when your framework already owns the runtime and you only want Relaycast messaging.

```python
relay = Relay("Researcher")
agent = FrameworkAgent(...)
agent = on_relay(agent, relay)
```

Supported Python adapters:

- OpenAI Agents
- Claude Agent SDK
- Google ADK
- Agno
- Swarms
- CrewAI

The wrapped agent gets Relay tools for direct messages, channel posts, inbox reads, and agent discovery. Framework-specific receive hooks are added automatically.

## API

### AgentRelay

The main Orchestrate entry point. Pass `channels` to subscribe to message channels.

```python
relay = AgentRelay(channels=["dev", "planning"])
```

### Spawning Agents

Use runtime-specific spawners:

```python
await relay.claude.spawn(name="Agent1", model=Models.Claude.SONNET, channels=["dev"], task="...")
await relay.codex.spawn(name="Agent2", model=Models.Codex.GPT_5_3_CODEX, channels=["dev"], task="...")
await relay.gemini.spawn(name="Agent3", model=Models.Gemini.GEMINI_2_5_PRO, channels=["dev"], task="...")

worker = await relay.claude.spawn(
    name="HookedWorker",
    channels=["dev"],
    on_start=lambda ctx: print(f"spawning {ctx['name']}"),
    on_success=lambda ctx: print(f"spawned {ctx['name']} ({ctx['runtime']})"),
    on_error=lambda ctx: print(f"failed to spawn {ctx['name']}: {ctx['error']}"),
)

await worker.release(
    "done",
    on_start=lambda ctx: print(f"releasing {ctx['name']}"),
    on_success=lambda ctx: print(f"released {ctx['name']}"),
)
```

### Relay

The Communicate-mode client. Configure it directly or via `RELAY_WORKSPACE`, `RELAY_API_KEY`, and `RELAY_BASE_URL`.

```python
from agent_relay import Relay

relay = Relay("Researcher")
await relay.send("Lead", "Status update")
await relay.post("docs", "Wave 5.1 complete")
messages = await relay.inbox()

human = relay.system()
await human.send_message(
    to="Agent1",
    text="Please start the analysis",
    mode="wait",   # or "steer"
)
```

### `on_relay()`

Wrap a framework-owned agent or options object and keep the runtime you already use.

```python
from agent_relay import Relay, on_relay

relay = Relay("Researcher")
wrapped = on_relay(framework_agent_or_options, relay)
```

### Event Hooks

```python
relay.on_message_received = lambda msg: ...       # New message
relay.on_agent_ready = lambda agent: ...          # Agent connected
relay.on_agent_exited = lambda agent: ...         # Agent exited
relay.on_agent_spawned = lambda agent: ...        # Agent spawned
relay.on_worker_output = lambda data: ...         # Agent output
relay.on_agent_idle = lambda agent: ...           # Agent idle
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

## License

Apache-2.0
