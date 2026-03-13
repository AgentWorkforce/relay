# Agent Relay SDK — `on_relay` Implementation Spec

**Status**: Draft
**Date**: 2026-03-13
**Author**: Design session (human + Claude)

---

## 1. Vision

The Agent Relay SDK has two modes:

### Orchestrate Mode (existing)

For **CLI-based agent harnesses** — Claude Code, Codex, Gemini CLI, Aider, Goose, etc. Relay is the runtime: it spawns processes, manages lifecycles, and runs workflows.

```python
from agent_relay import AgentRelay

relay = AgentRelay()
await relay.claude.spawn(name="Worker", task="Fix the auth bug")
await relay.codex.spawn(name="Reviewer", task="Review Worker's changes")
```

**Use when:** You're orchestrating CLI tools that run as subprocesses. Requires the `agent-relay-broker` binary. This is the existing SDK.

### Communicate Mode (new — this spec)

For **SDK-based agent frameworks** — OpenAI Agents, Claude Agent SDK, Google ADK, CrewAI, Swarms, Agno, Pi. Your framework is the runtime. Relay just adds the wire between agents.

```python
from agent_relay import on_relay

agent = on_relay(Agent(name="Researcher", ...))
# Your agent is now "on the relay" — it can talk to any other agent
```

**Use when:** You already have agents built in a framework and want them to communicate with each other — across frameworks, across processes, across machines. No broker binary needed.

### One SDK, Two Entry Points

Both modes live in the same package:

| Registry | Package |
|----------|---------|
| PyPI | `agent-relay-sdk` |
| npm | `@agent-relay/sdk` |

```python
# Orchestrate: spawn and manage CLI agents
from agent_relay import AgentRelay

# Communicate: put existing framework agents on the relay
from agent_relay import on_relay
```

The `on_relay()` function and its supporting code (`Relay` core, transport, adapters) are new additions to the existing SDK package. No new package to install.

---

## 2. Supported Frameworks (Communicate Mode)

| Framework | Language | Send Mechanism | Receive Mechanism | Push Tier |
|-----------|----------|---------------|-------------------|-----------|
| Claude Agent SDK | TS/Python | MCP server | Hook `systemMessage` (PostToolUse, Stop) | 1 — per tool |
| Pi | TypeScript | AgentTool | `steer()` / `followUp()` | 1 — instant |
| Google ADK | Python | Function tool | `before_model_callback` mutates LLM request | 1 — per LLM call |
| OpenAI Agents | Python | `@function_tool` | Dynamic `instructions` callable | 2 — per turn |
| Agno | Python | Function / MCP | Dynamic `instructions` callable + pre-hook | 2 — per run |
| Swarms | Python | Plain callable | `receive_message()` triggers new run | 2 — per run |
| CrewAI | Python | `@tool` | Flow `@listen` + state | 2 — per task |

**Tier 1**: Messages injected mid-execution (during tool calls or before LLM calls).
**Tier 2**: Messages injected at natural boundaries (between turns, runs, or tasks). Still works — messages arrive via WebSocket in real-time and are buffered locally, so there's no network round-trip delay at injection time.

---

## 3. Architecture

```
Relaycast Cloud (or self-hosted)
       │
       │ WebSocket (always-on, lazy-connect)
       ▼
┌──────────────┐
│  Relay Core  │  from agent_relay.communicate import Relay
│              │  - send(to, text)
│              │  - post(channel, text)
│              │  - inbox() → Message[]
│              │  - agents() → str[]
│              │  - on_message(callback)
└──────┬───────┘
       │
       │  on_relay(agent) — per-framework adapter
       │  ~25-30 lines each
       │
  ┌────┼────────┬──────────┬────────────┬───────────┬──────────┬──────────┐
  ▼    ▼        ▼          ▼            ▼           ▼          ▼          ▼
 Pi  Claude   Google     OpenAI      Agno       Swarms     CrewAI     Custom
     SDK      ADK        Agents
```

### 3.1 Orchestrate vs Communicate

```
┌─────────────────────────────────────────────────────────────────────┐
│                       agent-relay-sdk                               │
│                                                                     │
│  ┌─────────────────────────┐   ┌────────────────────────────────┐  │
│  │    Orchestrate Mode     │   │      Communicate Mode          │  │
│  │                         │   │                                │  │
│  │  AgentRelay()           │   │  on_relay(agent)               │  │
│  │  AgentRelayClient       │   │  Relay class                   │  │
│  │  WorkflowBuilder        │   │  Framework adapters            │  │
│  │                         │   │                                │  │
│  │  Needs: broker binary   │   │  Needs: nothing (brokerless)   │  │
│  │  Agents: CLI processes  │   │  Agents: your framework's      │  │
│  │  Comms: MCP tools       │   │  Comms: on_relay() injects     │  │
│  └─────────────────────────┘   └────────────────────────────────┘  │
│                                                                     │
│  Shared: Relaycast messaging infrastructure                         │
└─────────────────────────────────────────────────────────────────────┘
```

An Orchestrate-mode CLI agent and a Communicate-mode SDK agent can talk to each other — they both use the same Relaycast messaging network. A Claude Code agent spawned via `relay.claude.spawn()` can DM a Swarms agent that was put `on_relay()`.

### 3.2 Transport

The `Relay` core always opens a WebSocket to Relaycast for real-time message delivery. Messages arriving via WebSocket are:
1. Delivered to any registered `on_message` callback (for Tier 1 push frameworks)
2. Buffered in `_pending` list (for Tier 2 poll frameworks, drained via `inbox()`)

### 3.3 Brokerless Mode

Communicate mode talks directly to the Relaycast HTTP/WS API. No Rust broker binary needed. This enables:
- Serverless / cloud deployment
- Lightweight integrations
- Cross-machine agent coordination

If a broker IS running (detected via env var or explicit config), the core routes through the broker instead for unified agent management.

---

## 4. Package Structure

The communicate mode code lives inside the existing SDK packages — no new packages to publish.

### 4.1 Python — new files in `packages/sdk-py/`

```
packages/sdk-py/src/agent_relay/
├── __init__.py              # ADD: export on_relay
├── relay.py                 # existing orchestrate mode
├── client.py                # existing orchestrate mode
├── ...                      # existing files unchanged
│
├── communicate/             # NEW — all communicate mode code
│   ├── __init__.py          # re-exports Relay, Message, on_relay
│   ├── core.py              # Relay class (~200 lines)
│   ├── types.py             # Message, RelayConfig dataclasses
│   ├── transport.py         # WebSocket + HTTP client for Relaycast
│   ├── _utils.py            # Shared helpers (format messages, etc.)
│   └── adapters/
│       ├── __init__.py
│       ├── openai_agents.py # on_relay() for OpenAI Agents SDK
│       ├── claude_sdk.py    # on_relay() for Claude Agent SDK (Python)
│       ├── google_adk.py    # on_relay() for Google ADK
│       ├── agno.py          # on_relay() for Agno
│       ├── swarms.py        # on_relay() for Swarms
│       └── crewai.py        # on_relay() for CrewAI

packages/sdk-py/tests/
├── ...                      # existing tests unchanged
└── communicate/             # NEW
    ├── conftest.py          # Shared fixtures, mock Relaycast server
    ├── test_core.py         # Relay class unit tests
    ├── test_transport.py    # WebSocket/HTTP transport tests
    ├── test_types.py        # Type validation tests
    ├── adapters/
    │   ├── test_openai_agents.py
    │   ├── test_claude_sdk.py
    │   ├── test_google_adk.py
    │   ├── test_agno.py
    │   ├── test_swarms.py
    │   └── test_crewai.py
    └── integration/
        ├── test_cross_framework.py  # Agent A talks to Agent B across frameworks
        └── test_end_to_end.py       # Full round-trip with real Relaycast
```

### 4.2 TypeScript — new files in `packages/sdk/src/`

```
packages/sdk/src/
├── index.ts                 # ADD: export communicate module
├── relay.ts                 # existing orchestrate mode
├── client.ts                # existing orchestrate mode
├── ...                      # existing files unchanged
│
├── communicate/             # NEW — all communicate mode code
│   ├── index.ts             # re-exports
│   ├── core.ts              # Relay class (~200 lines)
│   ├── types.ts             # Message, RelayConfig interfaces
│   ├── transport.ts         # WebSocket + HTTP client
│   ├── utils.ts             # Shared helpers
│   └── adapters/
│       ├── claude-sdk.ts    # onRelay() for Claude Agent SDK
│       └── pi.ts            # onRelay() for Pi

packages/sdk/src/__tests__/
├── ...                      # existing tests unchanged
└── communicate/             # NEW
    ├── core.test.ts
    ├── transport.test.ts
    ├── adapters/
    │   ├── claude-sdk.test.ts
    │   └── pi.test.ts
    └── integration/
        └── cross-framework.test.ts
```

### 4.3 Import Paths

```python
# Python — top-level convenience import
from agent_relay import on_relay

# Python — explicit communicate module
from agent_relay.communicate import Relay, Message, RelayConfig
from agent_relay.communicate.adapters.openai_agents import on_relay
from agent_relay.communicate.adapters.google_adk import on_relay

# The top-level on_relay auto-detects framework (see Section 6.9)
```

```typescript
// TypeScript — subpath export
import { onRelay } from "@agent-relay/sdk/communicate";
import { Relay } from "@agent-relay/sdk/communicate";

// Framework-specific
import { onRelay } from "@agent-relay/sdk/communicate/adapters/claude-sdk";
import { onRelay } from "@agent-relay/sdk/communicate/adapters/pi";
```

### 4.4 New SDK Exports

Add subpath export to `packages/sdk/package.json`:

```json
{
  "exports": {
    "./communicate": {
      "types": "./dist/communicate/index.d.ts",
      "import": "./dist/communicate/index.js"
    }
  }
}
```

### 4.5 Dependencies

Framework SDKs are **optional** — adapters use lazy imports and raise clear errors if the framework isn't installed. The communicate module adds minimal new dependencies:

**Python** — add to `pyproject.toml`:

```toml
[project.optional-dependencies]
communicate = [
    "aiohttp>=3.9",          # HTTP + WebSocket client (brokerless transport)
]
openai-agents = ["openai-agents>=0.1"]
claude-sdk = ["claude-agent-sdk>=0.1"]
google-adk = ["google-adk>=0.1"]
agno = ["agno>=0.1"]
swarms = ["swarms>=0.1"]
crewai = ["crewai>=0.1"]
```

Install: `pip install agent-relay-sdk[communicate]`

**TypeScript** — add `ws` as optional dependency (only needed for brokerless mode; existing SDK may already have WebSocket support via the broker).

---

## 5. Core API Specification

### 5.1 Types

#### Python (`types.py`)

```python
from dataclasses import dataclass, field
from typing import Callable, Optional, Awaitable
from enum import Enum

@dataclass(frozen=True)
class Message:
    """An inbound message from another agent."""
    sender: str
    text: str
    channel: Optional[str] = None     # None = DM, otherwise channel name
    thread_id: Optional[str] = None
    timestamp: Optional[float] = None
    message_id: Optional[str] = None

@dataclass
class RelayConfig:
    """Configuration for a Relay connection. Everything optional with env var defaults."""
    workspace: Optional[str] = None       # default: RELAY_WORKSPACE env var
    api_key: Optional[str] = None         # default: RELAY_API_KEY env var
    base_url: Optional[str] = None        # default: RELAY_BASE_URL or Relaycast cloud
    channels: list[str] = field(default_factory=lambda: ["general"])
    poll_interval_ms: int = 1000          # fallback polling if WS fails
    auto_cleanup: bool = True             # atexit cleanup

MessageCallback = Callable[[Message], None] | Callable[[Message], Awaitable[None]]
```

#### TypeScript (`types.ts`)

```typescript
export interface Message {
  readonly sender: string;
  readonly text: string;
  readonly channel?: string;
  readonly threadId?: string;
  readonly timestamp?: number;
  readonly messageId?: string;
}

export interface RelayConfig {
  workspace?: string;
  apiKey?: string;
  baseUrl?: string;
  channels?: string[];
  pollIntervalMs?: number;
  autoCleanup?: boolean;
}

export type MessageCallback = (message: Message) => void | Promise<void>;
```

### 5.2 Relay Class (Core)

#### Python (`core.py`)

```python
class Relay:
    """Lightweight connection to the Agent Relay network.

    Usage:
        relay = Relay("MyAgent")
        await relay.send("Bob", "Hello!")
        messages = await relay.inbox()
        await relay.close()
    """

    def __init__(self, name: str, config: RelayConfig | None = None):
        """Register this agent with the Relay network.

        Args:
            name: Agent name visible to other agents.
            config: Optional configuration. Defaults from env vars.
        """

    # ── Sending ─────────────────────────────────────────

    async def send(self, to: str, text: str) -> None:
        """Send a DM to another agent."""

    async def post(self, channel: str, text: str) -> None:
        """Post a message to a channel."""

    async def reply(self, message_id: str, text: str) -> None:
        """Reply to a specific message in its thread."""

    # ── Receiving ───────────────────────────────────────

    async def inbox(self) -> list[Message]:
        """Drain and return all buffered messages since last call.

        Messages arrive via WebSocket in real-time and are buffered.
        This method returns the buffer and clears it.
        Returns an empty list if no new messages.
        """

    def on_message(self, callback: MessageCallback) -> Callable[[], None]:
        """Register a callback for real-time message delivery.

        Returns an unsubscribe function.
        The callback fires immediately when a message arrives via WebSocket.
        Messages delivered to callbacks are NOT buffered for inbox().
        """

    # ── Discovery ───────────────────────────────────────

    async def agents(self) -> list[str]:
        """List currently online agent names."""

    # ── Lifecycle ───────────────────────────────────────

    async def close(self) -> None:
        """Unregister from the network and close connections."""

    # ── Sync wrappers (for frameworks that need sync) ───

    def send_sync(self, to: str, text: str) -> None: ...
    def post_sync(self, channel: str, text: str) -> None: ...
    def inbox_sync(self) -> list[Message]: ...
    def agents_sync(self) -> list[str]: ...
    def close_sync(self) -> None: ...
```

#### TypeScript (`core.ts`)

Same interface but async-only (no sync wrappers needed in TS).

### 5.3 Internal Behavior

#### Lazy Connection
- WebSocket connects on first `send()`, `post()`, `inbox()`, or `on_message()` call
- Agent registers with Relaycast on connect
- No connection attempt at `__init__` time

#### Message Routing
- If `on_message` callback(s) registered: messages go to callbacks only (not buffered)
- If no callbacks: messages buffered in `_pending` list, drained by `inbox()`
- If both: messages go to callbacks AND are buffered (adapter decides which path to use)

#### Auto-Cleanup
- If `config.auto_cleanup` is True (default), register `atexit` handler to call `close_sync()`
- Also support async context manager: `async with Relay("name") as relay: ...`

#### Error Handling
- WebSocket disconnect: auto-reconnect with exponential backoff (1s, 2s, 4s, max 30s)
- HTTP errors: raise `RelayConnectionError` with status code and message
- Missing env vars: raise `RelayConfigError` with clear message about which var is needed

---

## 6. Adapter Specifications

Each adapter implements `on_relay()` that wraps a framework-native agent object. The function:
1. Extracts the agent name from the framework's convention
2. Creates a `Relay` instance (or accepts one as optional parameter)
3. Appends sending tools in the framework's native tool format
4. Wraps the instruction/callback mechanism for receiving
5. Returns the modified agent (same object, mutated in place)

### 6.1 OpenAI Agents Python

**File**: `communicate/adapters/openai_agents.py`
**Framework**: `openai-agents` (pip install openai-agents)
**Import**: `from agents import Agent, Runner, function_tool`

```python
def on_relay(agent: Agent, relay: Relay | None = None) -> Agent:
    """Put an OpenAI Agents SDK agent on the relay.

    Sending: Injects relay_send, relay_inbox, relay_post, relay_agents as @function_tool
    Receiving: Wraps agent.instructions as callable that prepends inbox contents
    """
```

**Sending tools injected:**
- `relay_send(to: str, text: str) -> str`
- `relay_inbox() -> str`
- `relay_post(channel: str, text: str) -> str`
- `relay_agents() -> str`

**Receiving mechanism:**
- Wrap `agent.instructions` (str or callable) as an async callable
- On each turn, drain `relay.inbox()` and prepend to instructions if non-empty
- Format: `\n\nNew messages from other agents:\n  {sender}: {text}\n  ...`

**Edge cases:**
- If `agent.instructions` is already a callable, wrap and chain
- If `agent.instructions` is a string, convert to callable that returns that string + inbox
- If `agent.instructions` is None, create callable that returns only inbox (or empty string)

### 6.2 Claude Agent SDK (TypeScript)

**File**: `communicate/adapters/claude-sdk.ts`
**Framework**: `@anthropic-ai/claude-agent-sdk`
**Import**: `import { query } from "@anthropic-ai/claude-agent-sdk"`

```typescript
function onRelay(name: string, opts: QueryOptions): QueryOptions
```

Note: Claude Agent SDK doesn't have an Agent class — it uses `query(prompt, options)`. So `onRelay` wraps the options object, not an agent.

**Sending:** Inject Relaycast MCP server into `options.mcpServers`
**Receiving:** Add hooks:
- `PostToolUse`: drain inbox, return as `systemMessage` if non-empty
- `Stop`: drain inbox, if non-empty return `systemMessage` + `continue: true` to keep agent alive

### 6.3 Claude Agent SDK (Python)

**File**: `communicate/adapters/claude_sdk.py`
**Framework**: `claude-agent-sdk`
**Import**: `from claude_agent_sdk import query, ClaudeAgentOptions`

Same pattern as TypeScript but in Python. Uses Python hooks API.

### 6.4 Pi (TypeScript)

**File**: `communicate/adapters/pi.ts`
**Framework**: `@mariozechner/pi-coding-agent`

```typescript
function onRelay(name: string, config: AgentSessionConfig): AgentSessionConfig
```

**Sending:** Append Relay tools as `AgentTool` objects with TypeBox schemas
**Receiving:** Register `relay.onMessage()` callback that calls:
- `session.steer()` if agent is streaming (interrupts)
- `session.followUp()` if agent is idle (queues)

Requires capturing the session reference. The adapter adds an `onSessionCreated` hook to the config.

### 6.5 Google ADK

**File**: `communicate/adapters/google_adk.py`
**Framework**: `google-adk`
**Import**: `from google.adk.agents import Agent`

```python
def on_relay(agent: Agent, relay: Relay | None = None) -> Agent:
```

**Sending:** Append plain Python functions to `agent.tools`
**Receiving:** Set/chain `agent.before_model_callback` to:
- Drain `relay.inbox()`
- Append messages to `llm_request.contents` as user Content parts
- Chain to original callback if one existed

### 6.6 Agno

**File**: `communicate/adapters/agno.py`
**Framework**: `agno`
**Import**: `from agno.agent import Agent`

```python
def on_relay(agent: Agent, relay: Relay | None = None) -> Agent:
```

**Sending:** Append plain Python functions to `agent.tools`
**Receiving:** Wrap `agent.instructions` as callable that drains inbox (same pattern as OpenAI Agents)

### 6.7 Swarms

**File**: `communicate/adapters/swarms.py`
**Framework**: `swarms`
**Import**: `from swarms import Agent`

```python
def on_relay(agent: Agent, relay: Relay | None = None) -> Agent:
```

**Sending:** Append plain callables to `agent.tools`
**Receiving:** Register `relay.on_message()` callback that calls `agent.receive_message(sender, text)`, which triggers a new run

### 6.8 CrewAI

**File**: `communicate/adapters/crewai.py`
**Framework**: `crewai`
**Import**: `from crewai import Agent`

```python
def on_relay(agent: Agent, relay: Relay | None = None) -> Agent:
```

**Sending:** Append `@tool` decorated functions to `agent.tools`
**Receiving:** Wrap `agent.backstory` or `agent.goal` to include inbox contents. CrewAI is the most limited — no dynamic instructions, no mid-task hooks. The adapter documents this limitation.

Alternative for CrewAI: provide a `RelayTool` that the agent can call to check inbox, and recommend using Flows for richer integration.

### 6.9 Auto-Detect `on_relay()` (Top-Level)

The top-level `from agent_relay import on_relay` auto-detects the framework by inspecting the agent object's type:

```python
# agent_relay/__init__.py

def on_relay(agent, relay=None):
    """Put any agent on the relay. Auto-detects the framework."""
    cls_module = type(agent).__module__

    if cls_module.startswith("agents"):
        from agent_relay.communicate.adapters.openai_agents import on_relay as _adapt
    elif cls_module.startswith("google.adk"):
        from agent_relay.communicate.adapters.google_adk import on_relay as _adapt
    elif cls_module.startswith("agno"):
        from agent_relay.communicate.adapters.agno import on_relay as _adapt
    elif cls_module.startswith("swarms"):
        from agent_relay.communicate.adapters.swarms import on_relay as _adapt
    elif cls_module.startswith("crewai"):
        from agent_relay.communicate.adapters.crewai import on_relay as _adapt
    else:
        raise TypeError(
            f"on_relay() doesn't recognize {type(agent).__name__} from {cls_module}. "
            f"Use a framework-specific adapter: "
            f"from agent_relay.communicate.adapters.openai_agents import on_relay"
        )

    return _adapt(agent, relay=relay)
```

For TypeScript and Claude Agent SDK / Pi (which don't pass an agent object), users import the framework-specific adapter directly:

```typescript
import { onRelay } from "@agent-relay/sdk/communicate/adapters/claude-sdk";
import { onRelay } from "@agent-relay/sdk/communicate/adapters/pi";
```

---

## 7. Implementation Phases

### Phase 1: Core + Tests (Foundation)

**Goal**: Relay class works end-to-end. All core primitives tested.

#### Wave 1.1: Types & Core Shell

| Task | Agent | Description |
|------|-------|-------------|
| 1.1.1 | Worker A | Create `packages/sdk-py/src/agent_relay/communicate/` directory structure with `__init__.py` files |
| 1.1.2 | Worker A | Implement `communicate/types.py`: `Message`, `RelayConfig`, `MessageCallback`, `RelayConnectionError`, `RelayConfigError` |
| 1.1.3 | Worker B | Write `tests/communicate/test_types.py`: message creation, frozen immutability, default config values, env var resolution |

**Review Gate 1.1**: Reviewer verifies types are correct, tests pass, no unnecessary complexity.

#### Wave 1.2: Transport Layer

| Task | Agent | Description |
|------|-------|-------------|
| 1.2.1 | Worker A | Implement `communicate/transport.py`: `RelayTransport` class with `connect()`, `disconnect()`, `send_http()`, `on_ws_message()` |
| 1.2.2 | Worker A | HTTP methods: `register_agent()`, `unregister_agent()`, `send_dm()`, `post_message()`, `list_agents()`, `check_inbox()` |
| 1.2.3 | Worker B | Write `tests/communicate/test_transport.py` with mock HTTP/WS server: connection lifecycle, reconnect on disconnect, message buffering, error handling |
| 1.2.4 | Worker B | Write `tests/communicate/conftest.py`: `MockRelayServer` fixture using `aiohttp` or `pytest-httpserver` that simulates Relaycast API endpoints |

**Review Gate 1.2**: Reviewer verifies transport handles all error cases, reconnect logic is correct, mock server is realistic.

#### Wave 1.3: Relay Core

| Task | Agent | Description |
|------|-------|-------------|
| 1.3.1 | Worker A | Implement `communicate/core.py`: `Relay` class using `RelayTransport`. Lazy connection, message buffering, callback routing, sync wrappers, atexit cleanup, context manager |
| 1.3.2 | Worker B | Write `tests/communicate/test_core.py`: lazy connect on first use, send/receive round-trip, inbox drain clears buffer, on_message callback fires, sync wrappers work, close unregisters, context manager cleanup, concurrent access safety |

**Review Gate 1.3**: Full core review. Verify: thread safety, no resource leaks, clean error messages, all tests pass.

---

### Phase 2: Tier 1 Adapters (Push-Based)

**Goal**: The three frameworks with real-time push work end-to-end.

#### Wave 2.1: Claude Agent SDK Adapter

| Task | Agent | Description |
|------|-------|-------------|
| 2.1.1 | Worker A | Implement `communicate/adapters/claude_sdk.py`: `on_relay()` wrapping query options, PostToolUse hook injection, Stop hook with continue, MCP server config |
| 2.1.2 | Worker B | Write `tests/communicate/adapters/test_claude_sdk.py`: verify hooks are added to options, verify systemMessage returned when inbox non-empty, verify empty inbox returns no systemMessage, verify Stop hook continues when messages pending, verify MCP server injected, verify chaining with existing hooks |

**Review Gate 2.1**: Reviewer verifies hook behavior, edge cases (existing hooks preserved), message formatting.

#### Wave 2.2: Google ADK Adapter

| Task | Agent | Description |
|------|-------|-------------|
| 2.2.1 | Worker A | Implement `communicate/adapters/google_adk.py`: `on_relay()`, function tools for send/inbox/post/agents, `before_model_callback` injection |
| 2.2.2 | Worker B | Write `tests/communicate/adapters/test_google_adk.py`: verify tools appended, verify callback injected, verify callback drains inbox into llm_request.contents, verify empty inbox doesn't modify request, verify chaining with existing before_model_callback |

**Review Gate 2.2**: Reviewer verifies ADK Content format is correct, callback chains properly.

#### Wave 2.3: Pi Adapter (TypeScript)

| Task | Agent | Description |
|------|-------|-------------|
| 2.3.1 | Worker A | Create `packages/sdk/src/communicate/` directory structure |
| 2.3.2 | Worker A | Implement TypeScript `communicate/core.ts`, `communicate/types.ts`, `communicate/transport.ts` (port from Python) |
| 2.3.3 | Worker A | Implement `communicate/adapters/pi.ts`: `onRelay()`, TypeBox tool schemas, steer/followUp routing |
| 2.3.4 | Worker B | Write `tests/communicate/core.test.ts`, `tests/communicate/adapters/pi.test.ts`: same test coverage as Python core + Pi-specific steer vs followUp behavior |

**Review Gate 2.3**: Reviewer verifies TypeScript core has parity with Python, Pi adapter correctly distinguishes steer vs followUp.

#### Wave 2.4: Claude Agent SDK TypeScript Adapter

| Task | Agent | Description |
|------|-------|-------------|
| 2.4.1 | Worker A | Implement `communicate/adapters/claude-sdk.ts`: `onRelay()` wrapping QueryOptions |
| 2.4.2 | Worker B | Write `tests/communicate/adapters/claude-sdk.test.ts` |

**Review Gate 2.4**: Reviewer verifies TS adapter matches Python Claude SDK adapter behavior.

---

### Phase 3: Tier 2 Adapters (Poll-Based)

**Goal**: All four poll-based frameworks work.

#### Wave 3.1: OpenAI Agents Adapter

| Task | Agent | Description |
|------|-------|-------------|
| 3.1.1 | Worker A | Implement `communicate/adapters/openai_agents.py`: `on_relay()`, function_tool creation, instructions wrapping (handle str, callable, None) |
| 3.1.2 | Worker B | Write `tests/communicate/adapters/test_openai_agents.py`: verify tools added, verify instructions wrapped for each input type (str, callable, None), verify inbox injected into instructions, verify empty inbox returns base instructions unchanged |

**Review Gate 3.1**: Reviewer verifies all three instructions input types handled correctly.

#### Wave 3.2: Agno Adapter

| Task | Agent | Description |
|------|-------|-------------|
| 3.2.1 | Worker A | Implement `communicate/adapters/agno.py`: `on_relay()`, function tools, instructions wrapping |
| 3.2.2 | Worker B | Write `tests/communicate/adapters/test_agno.py` |

#### Wave 3.3: Swarms Adapter

| Task | Agent | Description |
|------|-------|-------------|
| 3.3.1 | Worker A | Implement `communicate/adapters/swarms.py`: `on_relay()`, callable tools, on_message → receive_message bridge |
| 3.3.2 | Worker B | Write `tests/communicate/adapters/test_swarms.py`: verify on_message callback registered, verify receive_message called with correct args |

#### Wave 3.4: CrewAI Adapter

| Task | Agent | Description |
|------|-------|-------------|
| 3.4.1 | Worker A | Implement `communicate/adapters/crewai.py`: `on_relay()`, @tool decorated functions, document limitations |
| 3.4.2 | Worker B | Write `tests/communicate/adapters/test_crewai.py` |

**Review Gate 3.x**: Reviewer verifies all four adapters, consistent patterns, no framework SDK imported at module level (lazy imports only).

---

### Phase 4: Integration Tests & Cross-Framework

**Goal**: Prove agents in different frameworks can talk to each other.

#### Wave 4.1: Cross-Framework Tests

| Task | Agent | Description |
|------|-------|-------------|
| 4.1.1 | Worker A | Write `tests/communicate/integration/test_cross_framework.py`: OpenAI Agent sends message → Google ADK agent receives via before_model_callback |
| 4.1.2 | Worker A | Test: Swarms agent sends → Claude SDK agent receives via hook systemMessage |
| 4.1.3 | Worker A | Test: Multiple agents in different frameworks all posting to same channel |
| 4.1.4 | Worker B | Write `tests/communicate/integration/test_end_to_end.py`: real Relaycast server (CI-only, behind env flag), full round-trip send/receive |

**Review Gate 4.1**: Reviewer verifies cross-framework tests use mock server (not real Relaycast) for CI speed, end-to-end tests are clearly marked as integration-only.

#### Wave 4.2: TypeScript Integration Tests

| Task | Agent | Description |
|------|-------|-------------|
| 4.2.1 | Worker A | Write `tests/communicate/integration/cross-framework.test.ts`: Pi agent ↔ Claude SDK agent communication |

**Review Gate 4.2**: Reviewer verifies TS integration tests.

---

### Phase 5: Documentation & Examples

**Goal**: Users can get started in 60 seconds.

#### Wave 5.1: Documentation

| Task | Agent | Description |
|------|-------|-------------|
| 5.1.1 | Worker A | Update SDK README files to document both Orchestrate and Communicate modes |
| 5.1.2 | Worker B | Write example scripts in `packages/sdk-py/examples/communicate/`: one per framework, each under 20 lines |
| 5.1.3 | Worker B | Write example scripts in `packages/sdk/examples/communicate/`: Pi + Claude SDK examples |

#### Wave 5.2: Docs Site Pages

| Task | Agent | Description |
|------|-------|-------------|
| 5.2.1 | Worker A | Write `docs/communicate.mdx` + `docs/markdown/communicate.md`: overview page — "Put your agents on the relay" |
| 5.2.2 | Worker A | Write per-framework pages: `docs/communicate/openai-agents.mdx`, `docs/communicate/claude-sdk.mdx`, `docs/communicate/google-adk.mdx`, `docs/communicate/agno.mdx`, `docs/communicate/swarms.mdx`, `docs/communicate/crewai.mdx`, `docs/communicate/pi.mdx` |
| 5.2.3 | Worker A | Update `docs/introduction.mdx` to explain the two SDK modes (Orchestrate for CLI harnesses, Communicate for SDK frameworks) |

**Review Gate 5.x**: Reviewer verifies docs are accurate, examples run, both .mdx and .md files in sync per docs-sync rule.

---

## 8. Test Strategy (TDD)

### 8.1 Test-First Rule

**Every implementation task MUST have its corresponding test task completed FIRST or IN PARALLEL.** The test file defines the contract. The implementation satisfies it.

### 8.2 Test Categories

| Category | Location | Runs In CI | Description |
|----------|----------|-----------|-------------|
| Unit | `tests/test_*.py` | Always | Core class behavior, no network |
| Adapter | `tests/adapters/test_*.py` | Always | Adapter wrapping logic, mocked framework objects |
| Integration | `tests/integration/` | Always (mock server) | Cross-framework messaging via mock Relaycast |
| End-to-End | `tests/integration/test_end_to_end.py` | CI with `RELAY_E2E=1` | Real Relaycast, real WebSocket |

### 8.3 Mock Relaycast Server

A shared test fixture (`conftest.py`) provides `MockRelayServer` that:
- Runs an HTTP server on a random port
- Accepts agent registration (`POST /agents`)
- Accepts message send (`POST /messages`)
- Returns inbox messages (`GET /inbox/{agent}`)
- Supports WebSocket upgrade at `/ws/{agent}` for push delivery
- Tracks all messages for assertion

```python
@pytest.fixture
async def relay_server():
    server = MockRelayServer()
    await server.start()
    yield server
    await server.stop()

@pytest.fixture
def relay(relay_server) -> Relay:
    return Relay("TestAgent", RelayConfig(
        base_url=relay_server.url,
        api_key="test-key",
    ))
```

### 8.4 Adapter Test Pattern

Each adapter test mocks the framework's agent class minimally — just enough to verify `on_relay()` wired things correctly:

```python
# Example: test_openai_agents.py

class MockAgent:
    """Minimal mock of openai agents.Agent"""
    def __init__(self, name, instructions=None, tools=None):
        self.name = name
        self.instructions = instructions
        self.tools = tools or []

async def test_on_relay_adds_tools(relay_server):
    agent = MockAgent(name="Test")
    agent = on_relay(agent, relay=Relay("Test", RelayConfig(base_url=relay_server.url)))

    tool_names = [t.name for t in agent.tools]
    assert "relay_send" in tool_names
    assert "relay_inbox" in tool_names
    assert "relay_post" in tool_names
    assert "relay_agents" in tool_names

async def test_on_relay_wraps_string_instructions(relay_server):
    relay = Relay("Test", RelayConfig(base_url=relay_server.url))
    # Pre-buffer a message
    relay._pending.append(Message(sender="Alice", text="Hello"))

    agent = MockAgent(name="Test", instructions="Be helpful.")
    agent = on_relay(agent, relay=relay)

    # Instructions should now be callable
    result = await agent.instructions(None, agent)
    assert "Be helpful." in result
    assert "Alice: Hello" in result

async def test_on_relay_wraps_callable_instructions(relay_server):
    relay = Relay("Test", RelayConfig(base_url=relay_server.url))

    original_called = False
    async def original(ctx, ag):
        nonlocal original_called
        original_called = True
        return "Original instructions"

    agent = MockAgent(name="Test", instructions=original)
    agent = on_relay(agent, relay=relay)

    result = await agent.instructions(None, agent)
    assert original_called
    assert "Original instructions" in result

async def test_on_relay_empty_inbox_no_modification(relay_server):
    relay = Relay("Test", RelayConfig(base_url=relay_server.url))

    agent = MockAgent(name="Test", instructions="Be helpful.")
    agent = on_relay(agent, relay=relay)

    result = await agent.instructions(None, agent)
    assert result == "Be helpful."
    assert "messages" not in result.lower()
```

### 8.5 Coverage Requirements

- Core (`core.py`, `transport.py`, `types.py`): **≥90% line coverage**
- Each adapter: **≥85% line coverage**
- Integration tests: **≥1 cross-framework test per adapter**

---

## 9. Relaycast API Contract

The Connect SDK depends on these Relaycast HTTP/WS endpoints. This section documents the expected contract.

### 9.1 HTTP Endpoints

```
POST   /v1/agents/register      { name, workspace }         → { agent_id, token }
DELETE /v1/agents/{agent_id}                                 → 204
POST   /v1/messages/dm           { to, text, from }         → { message_id }
POST   /v1/messages/channel      { channel, text, from }    → { message_id }
POST   /v1/messages/reply        { message_id, text, from } → { message_id }
GET    /v1/inbox/{agent_id}                                  → { messages: Message[] }
GET    /v1/agents                                            → { agents: string[] }
```

All requests require `Authorization: Bearer {api_key}` header.

### 9.2 WebSocket

```
WS /v1/ws/{agent_id}?token={token}

Server → Client messages (JSON):
{ "type": "message", "sender": "...", "text": "...", "channel": "...", "message_id": "..." }
{ "type": "ping" }

Client → Server messages (JSON):
{ "type": "pong" }
```

### 9.3 Note

If the actual Relaycast API differs from the above, the `transport.py` layer is the ONLY file that needs to change. All adapters and core depend on `Relay` class, not on HTTP endpoints directly.

---

## 10. Error Handling Spec

| Error | Exception | When | Recovery |
|-------|-----------|------|----------|
| Missing RELAY_API_KEY | `RelayConfigError` | First connection attempt | User sets env var |
| Missing RELAY_WORKSPACE | `RelayConfigError` | First connection attempt | User sets env var |
| HTTP 401 | `RelayAuthError` | Any API call | User checks API key |
| HTTP 4xx | `RelayConnectionError` | Any API call | Raise with status + body |
| HTTP 5xx | `RelayConnectionError` | Any API call | Retry with backoff (3 attempts) |
| WebSocket disconnect | (silent) | During operation | Auto-reconnect with backoff |
| Framework not installed | `ImportError` with helpful message | Adapter import | User installs framework |
| Agent name collision | `RelayConnectionError` | Registration | User picks unique name |

---

## 11. Performance Constraints

| Metric | Target |
|--------|--------|
| `Relay.__init__()` | <1ms (no I/O) |
| First `send()` (cold start) | <500ms (register + send) |
| Subsequent `send()` | <100ms |
| `inbox()` (buffer drain) | <1ms (local memory only) |
| WebSocket message delivery | <50ms (Relaycast → callback) |
| Memory per buffered message | ~1KB |
| Max buffer size | 10,000 messages (then oldest dropped with warning) |

---

## 12. Agent Team Structure

### Roles

| Role | Count | Responsibility |
|------|-------|---------------|
| Lead | 1 | Coordinates waves, manages dependencies, resolves blockers |
| Worker | 2-3 | Implement code (Worker A = implementation, Worker B = tests) |
| Reviewer | 1-2 | Reviews each wave's output at review gates |

### Workflow

```
1. Lead assigns wave tasks to workers
2. Worker B writes tests FIRST (TDD)
3. Worker A implements to pass tests
4. Both workers self-verify (tests pass, linting clean)
5. Lead triggers review gate
6. Reviewer checks:
   - Tests are meaningful (not trivially passing)
   - Implementation is minimal (no over-engineering)
   - Error handling covers documented cases
   - No framework SDKs imported at module level
   - Lazy imports used for optional dependencies
   - Consistent code style across adapters
7. Reviewer approves or requests changes
8. Lead moves to next wave
```

### Review Gate Checklist

Each review gate MUST verify:

- [ ] All tests pass (`pytest` / `vitest`)
- [ ] No tests are skipped without documented reason
- [ ] Coverage meets thresholds (90% core, 85% adapters)
- [ ] No unnecessary dependencies added
- [ ] Framework SDKs are lazy-imported (not top-level)
- [ ] Error messages are clear and actionable
- [ ] `on_relay()` returns the same agent object (mutated, not cloned)
- [ ] No global state (each `Relay` instance is independent)
- [ ] Thread safety: `_pending` buffer is safe for concurrent read/write
- [ ] Adapter is ≤50 lines of code (excluding imports and docstrings)
- [ ] Type hints on all public functions
- [ ] Docstrings on all public functions (Google style for Python, JSDoc for TS)

---

## 13. Dependencies

Dependencies are added to the EXISTING SDK packages — no new packages.

### Python — additions to `packages/sdk-py/pyproject.toml`

```toml
# Add to existing [project.optional-dependencies]
communicate = [
    "aiohttp>=3.9",          # HTTP + WebSocket client for brokerless transport
]
openai-agents = ["openai-agents>=0.1"]
claude-sdk = ["claude-agent-sdk>=0.1"]
google-adk = ["google-adk>=0.1"]
agno = ["agno>=0.1"]
swarms = ["swarms>=0.1"]
crewai = ["crewai>=0.1"]

# Add to existing dev dependencies
# "pytest-cov>=5.0",  (if not already present)
```

Install: `pip install agent-relay-sdk[communicate]`

### TypeScript — additions to `packages/sdk/package.json`

```json
{
  "peerDependencies": {
    "@anthropic-ai/claude-agent-sdk": ">=0.1.0",
    "@mariozechner/pi-coding-agent": ">=0.50.0"
  },
  "peerDependenciesMeta": {
    "@anthropic-ai/claude-agent-sdk": { "optional": true },
    "@mariozechner/pi-coding-agent": { "optional": true }
  }
}
```

Add `@sinclair/typebox` to devDependencies if not already present (needed for Pi adapter).

---

## 14. Success Criteria

The project is complete when:

1. **All 7 `on_relay()` adapters pass their tests** (unit + adapter)
2. **Cross-framework integration test passes**: Agent A (OpenAI Agents) sends message → Agent B (Google ADK) receives via before_model_callback → Agent B replies → Agent A sees reply in next turn's dynamic instructions
3. **Each adapter is ≤50 lines** (excluding imports/docstrings)
4. **Core is ≤200 lines** per language
5. **Zero framework dependencies at install time** (all optional/peer)
6. **READMEs show working example for each framework** in ≤10 lines
7. **CI passes**: all tests, coverage thresholds met, no lint errors

---

## 15. Open Questions

1. **Relaycast API authentication for brokerless mode**: Does the current Relaycast API support direct agent registration without going through the broker? If not, a thin registration endpoint may be needed.

2. **Message ordering guarantees**: Should `inbox()` guarantee chronological order? Current spec says yes (WebSocket messages arrive in order, buffer is FIFO).

3. **Deduplication**: If the same message arrives via WebSocket AND a subsequent `inbox()` HTTP poll (fallback), should we deduplicate by `message_id`? Current spec says yes, using a bounded set of seen IDs.

4. **Rate limiting**: Should the `Relay` class enforce client-side rate limits on `send()`? Recommendation: no, let Relaycast server enforce limits and surface 429 errors.

5. **Binary/file messages**: Current spec is text-only. File/image support is out of scope for v1 but the `Message` type should be extensible.

---

## Appendix A: Adapter Quick Reference

### Pattern Template (Python, Tier 2)

```python
"""Adapter for {Framework} — puts {Framework} agents on the relay."""
from __future__ import annotations
from typing import TYPE_CHECKING

from agent_relay.communicate.core import Relay
from agent_relay.communicate.types import RelayConfig
from agent_relay.communicate._utils import format_inbox

if TYPE_CHECKING:
    pass  # framework type imports for type checking only

def on_relay(agent, relay: Relay | None = None):
    """Put a {Framework} agent on the relay.

    Args:
        agent: A {Framework} Agent instance.
        relay: Optional pre-configured Relay. Created from agent name if omitted.

    Returns:
        The same agent, with Relay tools and inbox injection added.
    """
    try:
        from {framework} import {needed_imports}
    except ImportError:
        raise ImportError(
            "on_relay() for {Framework} requires the '{package}' package. "
            "Install it with: pip install {package}"
        )

    name = _extract_name(agent)
    relay = relay or Relay(name)

    # SENDING: append tools
    agent.tools = [*(agent.tools or []), *_make_tools(relay)]

    # RECEIVING: wrap instructions
    _wrap_instructions(agent, relay)

    return agent
```

### Pattern Template (TypeScript, Tier 1)

```typescript
/**
 * Adapter for {Framework} — puts {Framework} agents on the relay.
 */
import { Relay } from '../core.js';
import type { RelayConfig } from '../types.js';

export function onRelay(name: string, config: FrameworkConfig, relay?: Relay): FrameworkConfig {
  relay ??= new Relay(name);

  return {
    ...config,
    // SENDING: inject tools or MCP
    tools: [...(config.tools ?? []), ...makeTools(relay)],
    // RECEIVING: inject hooks or callbacks
    hooks: { ...config.hooks, ...makeHooks(relay) },
  };
}
```
