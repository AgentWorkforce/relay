
```bash
pip install agent-relay-sdk
```

The SDK automatically downloads the broker binary on first use — no additional setup required.


## Spawning Agents

### Shorthand Spawners

```python
# Spawn by CLI type
agent = await relay.claude.spawn(name="Analyst", model=Models.Claude.OPUS, channels=["dev"], task="...")
agent = await relay.codex.spawn(name="Coder", model=Models.Codex.GPT_5_3_CODEX, channels=["dev"], task="...")
agent = await relay.gemini.spawn(name="Researcher", model=Models.Gemini.GEMINI_2_5_PRO, channels=["dev"], task="...")
agent = await relay.opencode.spawn(name="Optimizer", model=Models.Opencode.OPENAI_GPT_5_2, channels=["dev"], task="...")
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
Models.Gemini.GEMINI_3_1_PRO_PREVIEW    # "gemini-3.1-pro-preview"
Models.Gemini.GEMINI_2_5_PRO            # "gemini-2.5-pro"

# OpenCode
Models.Opencode.OPENAI_GPT_5_2          # "openai/gpt-5.2"
Models.Opencode.OPENCODE_GPT_5_NANO     # "opencode/gpt-5-nano"
```


## See Also

- [Quickstart](/quickstart) — Spawn agents and exchange messages quickly
- [TypeScript SDK Reference](/reference/sdk) — TypeScript API reference
