# Python SDK Reference

Complete reference for the `agent-relay-sdk` Python package.

```bash
pip install agent-relay-sdk
```

The SDK automatically downloads the broker binary on first use — no additional setup required.

---

## AgentRelay

The main entry point. Manages the broker lifecycle, spawns agents, and routes messages.

```python
from agent_relay import AgentRelay

relay = AgentRelay(
    channels=["general"],        # Default channels
    binary_path=None,            # Path to broker binary (auto-resolved)
    binary_args=None,            # Extra broker arguments
    broker_name=None,            # Broker instance name (auto-generated)
    cwd=None,                    # Working directory (defaults to cwd)
    env=None,                    # Environment variables (inherited)
    request_timeout_ms=10_000,   # Timeout for broker requests
    shutdown_timeout_ms=3_000,   # Timeout when shutting down
)
```

---

## Spawning Agents

### Shorthand Spawners

```python
# Spawn by CLI type
agent = await relay.claude.spawn(name="Analyst", model=Models.Claude.OPUS, channels=["dev"], task="...")
agent = await relay.codex.spawn(name="Coder", model=Models.Codex.GPT_5_3_CODEX, channels=["dev"], task="...")
agent = await relay.gemini.spawn(name="Researcher", model=Models.Gemini.GEMINI_2_5_PRO, channels=["dev"], task="...")
```

**Spawn keyword arguments:**

| Parameter    | Type        | Description                              |
| ------------ | ----------- | ---------------------------------------- |
| `name`       | `str`       | Agent name (defaults to CLI name)        |
| `model`      | `str`       | Model to use (see Models below)          |
| `task`       | `str`       | Initial task / prompt                    |
| `channels`   | `list[str]` | Channels to join                         |
| `args`       | `list[str]` | Extra CLI arguments                      |
| `cwd`        | `str`       | Working directory override               |
| `on_start`   | `Callable`  | Sync/async callback before spawn request |
| `on_success` | `Callable`  | Sync/async callback after spawn succeeds |
| `on_error`   | `Callable`  | Sync/async callback when spawn fails     |

### `relay.spawn(name, cli, task?, options?)`

Spawn any CLI by name:

```python
from agent_relay import SpawnOptions

agent = await relay.spawn("Worker", "claude", "Help with refactoring", SpawnOptions(
    model="sonnet",
    channels=["team"],
))
```

### `relay.spawn_and_wait(name, cli, task, options?)`

Spawn and wait for the agent to be ready before returning:

```python
agent = await relay.spawn_and_wait("Worker", "claude", "Analyze the codebase", timeout_ms=30_000)
```

---

## Agent

All spawn methods return an `Agent`:

```python
class Agent:
    name: str                    # Agent name
    runtime: str                 # "pty" | "headless"
    channels: list[str]          # Joined channels
    status: str                  # "spawning" | "ready" | "idle" | "exited"
    exit_code: int | None
    exit_signal: str | None
    exit_reason: str | None

    async def send_message(*, to: str, text: str, thread_id=None, priority=None, data=None) -> Message
    async def release(reason=None, *, on_start=None, on_success=None, on_error=None) -> None
    async def wait_for_ready(timeout_ms=60_000) -> None
    async def wait_for_exit(timeout_ms=None) -> str   # "exited" | "timeout" | "released"
    async def wait_for_idle(timeout_ms=None) -> str   # "idle" | "timeout" | "exited"
    def on_output(callback) -> Callable[[], None]     # returns unsubscribe
```

---

## Human Handles

Send messages from a named human or system identity (not a spawned CLI agent):

```python
# Named human
human = relay.human("Orchestrator")
await human.send_message(to="Worker", text="Start the task")

# System identity (name: "system")
sys = relay.system()
await sys.send_message(to="Worker", text="Stop and report status")

# Broadcast to all agents
await relay.broadcast("All hands: stand by for new task")
```

---

## Event Hooks

Assign a callable to subscribe, `None` to unsubscribe:

```python
relay.on_message_received = lambda msg: ...       # New message
relay.on_message_sent = lambda msg: ...           # Message sent
relay.on_agent_spawned = lambda agent: ...        # Agent spawned
relay.on_agent_released = lambda agent: ...       # Agent released
relay.on_agent_exited = lambda agent: ...         # Agent exited
relay.on_agent_ready = lambda agent: ...          # Agent ready
relay.on_agent_idle = lambda data: ...            # Agent idle (data: {name, idle_secs})
relay.on_agent_exit_requested = lambda data: ...  # Exit requested (data: {name, reason})
relay.on_worker_output = lambda data: ...         # Output (data: {name, stream, chunk})
relay.on_delivery_update = lambda event: ...      # Delivery status update
```

**Message type:**

```python
@dataclass
class Message:
    event_id: str
    from_name: str
    to: str
    text: str
    thread_id: str | None = None
    data: dict | None = None
```

---

## Other Methods

```python
# List all known agents
agents = await relay.list_agents()  # list[Agent]

# Get broker status
status = await relay.get_status()  # dict

# Wait for the first of many agents to exit
agent, result = await AgentRelay.wait_for_any([agent1, agent2], timeout_ms=60_000)

# Shut down all agents and the broker
await relay.shutdown()
```

---

## Complete Example

```python
import asyncio
from agent_relay import AgentRelay, Models

async def main():
    relay = AgentRelay(channels=["dev"])

    relay.on_message_received = lambda msg: print(f"[{msg.from_name}]: {msg.text}")
    relay.on_agent_ready = lambda agent: print(f"  ✓ {agent.name} ready")
    relay.on_agent_exited = lambda agent: print(f"  ✗ {agent.name} exited")

    # Spawn agents
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

    # Wait for both to be ready
    await asyncio.gather(
        relay.wait_for_agent_ready("Planner"),
        relay.wait_for_agent_ready("Coder"),
    )

    # Send a message
    human = relay.system()
    await human.send_message(to="Coder", text="Start implementing the auth module")

    # Let agents collaborate
    await asyncio.sleep(600)
    await relay.shutdown()

asyncio.run(main())
```

---

## Models

```python
from agent_relay import Models

# Claude
Models.Claude.OPUS      # "opus"
Models.Claude.SONNET    # "sonnet"
Models.Claude.HAIKU     # "haiku"

# Codex
Models.Codex.GPT_5_3_CODEX        # "gpt-5.3-codex"
Models.Codex.GPT_5_2_CODEX        # "gpt-5.2-codex"
Models.Codex.GPT_5_3_CODEX_SPARK  # "gpt-5.3-codex-spark"
Models.Codex.GPT_5_1_CODEX_MAX    # "gpt-5.1-codex-max"
Models.Codex.GPT_5_1_CODEX_MINI   # "gpt-5.1-codex-mini"

# Gemini
Models.Gemini.GEMINI_2_5_PRO    # "gemini-2.5-pro"
Models.Gemini.GEMINI_2_5_FLASH  # "gemini-2.5-flash"
```

---

## Error Types

```python
from agent_relay import AgentRelayProtocolError, AgentRelayProcessError

try:
    await relay.claude.spawn(name="Worker")
except AgentRelayProtocolError as e:
    # Broker returned an error response (e.code available)
    pass
except AgentRelayProcessError as e:
    # Broker process failed to start or crashed
    pass
```

---

## See Also

- [Quickstart](../quickstart.md) — Spawn agents and exchange messages quickly
- [TypeScript SDK Reference](sdk.md) — TypeScript API reference
