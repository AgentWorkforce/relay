# A2A Transport Layer — Implementation Spec

## Overview

Add A2A (Agent2Agent) protocol support to the Agent Relay SDK as an alternative transport layer. This enables Relay agents to:

1. **Expose themselves as A2A-compliant servers** — any A2A client can discover and interact with Relay agents
2. **Communicate with external A2A agents** — Relay agents can send messages to any A2A-compliant agent on the internet
3. **Bridge A2A ↔ Relay** — external A2A agents can participate in Relay workspaces without knowing Relay internals

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Relay SDK (core.py / core.ts)       │
│                                                     │
│   relay.send(agent, msg)   relay.on_message(cb)     │
│         │                        ▲                  │
│         ▼                        │                  │
│   ┌─────────────────────────────────────────┐       │
│   │         Transport Layer (transport.py)   │       │
│   │                                         │       │
│   │   ┌──────────┐  ┌──────────┐  ┌──────┐ │       │
│   │   │ Relaycast│  │   A2A    │  │ Mock │ │       │
│   │   │Transport │  │Transport │  │      │ │       │
│   │   └──────────┘  └──────────┘  └──────┘ │       │
│   └─────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────┘
```

The A2A transport implements the same `Transport` interface as the existing Relaycast HTTP transport, but speaks A2A protocol instead.

## A2A Protocol Mapping

### Relay Concepts → A2A Concepts

| Relay | A2A | Notes |
|-------|-----|-------|
| Agent name | Agent Card `name` | Agent identity |
| Workspace | Tenant ID | Multi-tenant isolation |
| `relay.send(agent, msg)` | `message/send` (JSON-RPC) | Send message to agent |
| `relay.on_message(cb)` | A2A Server endpoint | Receive incoming messages |
| `relay.list_agents()` | Agent Card discovery | `GET /.well-known/agent.json` |
| Channel post | N/A (no direct equivalent) | Use Task with context ID |
| DM conversation | Task with context | Group messages by context |
| Agent registration | Agent Card publication | Serve Agent Card at well-known URL |
| WebSocket push | SSE streaming | Real-time updates |

### A2A Data Model (subset we implement)

```
AgentCard {
  name: string              # Agent name (= Relay agent name)
  description: string       # Agent role/description
  url: string               # Agent's A2A endpoint
  version: "1.0.0"
  capabilities: {
    streaming: true          # We support SSE
    pushNotifications: false # Phase 2
  }
  skills: [{                 # What this agent can do
    id: string
    name: string
    description: string
  }]
  defaultInputModes: ["text"]
  defaultOutputModes: ["text"]
}

Message {
  role: "user" | "agent"
  parts: [{ text: string }]  # Start with text-only parts
  messageId: string
}

Task {
  id: string
  contextId: string          # Maps to Relay conversation/channel
  status: { state: "submitted" | "working" | "completed" | "failed" }
  messages: Message[]
  artifacts: Artifact[]      # Agent output
}
```

## Implementation Plan

### File 1: `a2a_types.py` / `a2a-types.ts`
A2A data model types — AgentCard, Message, Task, Part, Artifact, etc.

```python
# Python
@dataclass
class A2APart:
    text: str | None = None
    file: dict | None = None  # FileContent for phase 2
    data: dict | None = None  # Structured data for phase 2

@dataclass
class A2AMessage:
    role: str  # "user" | "agent"
    parts: list[A2APart]
    messageId: str | None = None
    contextId: str | None = None
    taskId: str | None = None

@dataclass 
class A2ATaskStatus:
    state: str  # "submitted" | "working" | "completed" | "failed" | "canceled"
    message: A2AMessage | None = None
    timestamp: str | None = None

@dataclass
class A2ATask:
    id: str
    contextId: str | None = None
    status: A2ATaskStatus = field(default_factory=lambda: A2ATaskStatus(state="submitted"))
    messages: list[A2AMessage] = field(default_factory=list)
    artifacts: list[dict] = field(default_factory=list)

@dataclass
class A2ASkill:
    id: str
    name: str
    description: str

@dataclass
class A2AAgentCard:
    name: str
    description: str
    url: str
    version: str = "1.0.0"
    capabilities: dict = field(default_factory=lambda: {"streaming": True, "pushNotifications": False})
    skills: list[A2ASkill] = field(default_factory=list)
    defaultInputModes: list[str] = field(default_factory=lambda: ["text"])
    defaultOutputModes: list[str] = field(default_factory=lambda: ["text"])
```

### File 2: `a2a_transport.py` / `a2a-transport.ts`
Transport implementation — A2A client (sending messages to external A2A agents).

```python
class A2ATransport(Transport):
    """
    Transport that speaks A2A protocol instead of Relaycast API.
    
    Sends: JSON-RPC 2.0 to external A2A agent endpoints
    Receives: Runs a local HTTP server that accepts A2A JSON-RPC calls
    """
    
    def __init__(self, config: A2AConfig):
        self.config = config
        self.agent_card: A2AAgentCard | None = None
        self.tasks: dict[str, A2ATask] = {}
        self._message_callbacks: list[Callable] = []
        self._server: aiohttp server | None = None
    
    # === Transport interface (same as RelaycastTransport) ===
    
    async def register(self, name: str) -> dict:
        """
        'Register' by starting an HTTP server that serves:
        - GET /.well-known/agent.json → AgentCard
        - POST / → JSON-RPC 2.0 endpoint (message/send, message/stream, etc.)
        
        Returns agent info dict compatible with Relay core.
        """
    
    async def unregister(self) -> None:
        """Stop the HTTP server."""
    
    async def send_dm(self, target: str, text: str) -> dict:
        """
        Send a message to an external A2A agent.
        
        1. Discover target agent: GET {target_url}/.well-known/agent.json
        2. Send message: POST {agent_card.url} with JSON-RPC message/send
        3. Handle response: Task (async) or Message (sync)
        4. Return result mapped to Relay message format
        """
    
    async def list_agents(self) -> list[dict]:
        """
        List known A2A agents.
        Uses a registry of known Agent Card URLs (configured or discovered).
        """
    
    def on_message(self, callback: Callable) -> None:
        """Register callback for incoming A2A messages."""
    
    async def connect_ws(self) -> None:
        """
        A2A doesn't use WebSocket. Instead, the HTTP server
        accepts incoming JSON-RPC calls. This is a no-op or
        starts SSE listener for subscribed tasks.
        """
    
    # === A2A-specific methods ===
    
    async def _handle_jsonrpc(self, request: dict) -> dict:
        """
        Handle incoming JSON-RPC 2.0 requests:
        - message/send → create task, invoke message callback, return task/message
        - message/stream → same but with SSE response
        - tasks/get → return task by ID
        - tasks/cancel → cancel a task
        """
    
    async def _discover_agent(self, url: str) -> A2AAgentCard:
        """Fetch and parse Agent Card from /.well-known/agent.json"""
    
    def _relay_msg_to_a2a(self, text: str, sender: str) -> A2AMessage:
        """Convert Relay message format to A2A Message."""
    
    def _a2a_to_relay_msg(self, msg: A2AMessage, sender: str) -> Message:
        """Convert A2A Message to Relay Message format."""
```

### File 3: `a2a_server.py` / `a2a-server.ts`
The HTTP server that makes a Relay agent A2A-compliant.

```python
class A2AServer:
    """
    Lightweight HTTP server that exposes a Relay agent as an A2A endpoint.
    
    Routes:
      GET  /.well-known/agent.json  → Agent Card
      POST /                         → JSON-RPC 2.0 dispatcher
      GET  /tasks/:id/stream         → SSE stream for task updates (optional)
    """
    
    def __init__(self, agent_name: str, port: int, skills: list[A2ASkill] = None):
        self.agent_name = agent_name
        self.port = port
        self.skills = skills or []
        self.tasks: dict[str, A2ATask] = {}
        self._on_message: Callable | None = None
    
    def get_agent_card(self) -> A2AAgentCard:
        """Build Agent Card for this agent."""
        return A2AAgentCard(
            name=self.agent_name,
            description=f"Agent Relay agent: {self.agent_name}",
            url=f"http://localhost:{self.port}",
            skills=self.skills,
        )
    
    async def handle_message_send(self, request: dict) -> dict:
        """
        JSON-RPC: message/send
        1. Extract message from params
        2. Create or update Task
        3. Call self._on_message callback (bridges to Relay on_message)
        4. Return Task or Message response
        """
    
    async def handle_tasks_get(self, task_id: str) -> dict:
        """JSON-RPC: tasks/get — return task state"""
    
    async def handle_tasks_cancel(self, task_id: str) -> dict:
        """JSON-RPC: tasks/cancel — cancel a running task"""
    
    async def start(self) -> None:
        """Start aiohttp server."""
    
    async def stop(self) -> None:
        """Stop server."""
```

### File 4: `a2a_bridge.py` / `a2a-bridge.ts`
Bridge that connects A2A transport to Relaycast transport — enabling A2A agents to participate in Relay workspaces.

```python
class A2ABridge:
    """
    Bridges an external A2A agent into a Relay workspace.
    
    - Registers a proxy agent on Relay workspace
    - When Relay messages arrive for the proxy, forwards them as A2A messages to the external agent
    - When A2A responses come back, forwards them as Relay messages
    
    Usage:
        bridge = A2ABridge(
            relay_config=RelayConfig(workspace="myworkspace", api_key="rk_..."),
            a2a_agent_url="https://partner-billing-agent.example.com",
            proxy_name="partner-billing"
        )
        await bridge.start()
        # Now "partner-billing" appears as an agent in the Relay workspace
        # Other Relay agents can send("partner-billing", "process refund for order #1042")
    """
    
    def __init__(self, relay_config: RelayConfig, a2a_agent_url: str, proxy_name: str):
        self.relay = Relay(proxy_name, relay_config)
        self.a2a_client = A2ATransport(A2AConfig(target_url=a2a_agent_url))
    
    async def start(self):
        """Register proxy on Relay, listen for messages, forward to A2A agent."""
        await self.relay.__aenter__()
        self.relay.on_message(self._handle_relay_message)
    
    async def _handle_relay_message(self, msg: Message):
        """Forward Relay message → A2A message/send → forward response back."""
        a2a_msg = A2AMessage(role="user", parts=[A2APart(text=msg.text)])
        response = await self.a2a_client.send_dm(self.relay.name, msg.text)
        # Forward A2A response back to original sender on Relay
        await self.relay.send(msg.sender, response.text)
    
    async def stop(self):
        await self.relay.__aexit__(None, None, None)
```

## Config

```python
@dataclass
class A2AConfig:
    """Config for A2A transport."""
    # For A2A server mode (exposing agent as A2A endpoint)
    server_port: int = 5000
    server_host: str = "0.0.0.0"
    
    # For A2A client mode (connecting to external A2A agents)  
    target_url: str | None = None  # URL of external A2A agent
    
    # Agent Card registry (list of known A2A agent URLs for discovery)
    registry: list[str] = field(default_factory=list)
    
    # Auth (A2A supports various auth schemes)
    auth_scheme: str | None = None  # "bearer", "api_key", etc.
    auth_token: str | None = None
    
    # Relay bridge config (optional — for bridging A2A into Relay workspace)
    relay_config: RelayConfig | None = None
    proxy_name: str | None = None
```

## Test Plan

### Unit Tests (per language)

1. **A2A Types** — serialization/deserialization of AgentCard, Message, Task, Part
2. **A2A Transport** — mock HTTP to test send/receive cycle
3. **A2A Server** — test JSON-RPC dispatch, Agent Card serving
4. **A2A Bridge** — test bidirectional message forwarding
5. **Message conversion** — Relay Message ↔ A2A Message roundtrip

### Integration Tests

6. **Self-talk** — Two Relay agents, one with A2A transport, one with Relaycast transport, communicating via bridge
7. **External A2A agent** — Relay agent sends message to a real A2A sample server
8. **Agent Card discovery** — Verify /.well-known/agent.json serves correct card
9. **Task lifecycle** — submitted → working → completed flow

### E2E Tests

10. **Relay workspace + external A2A agent** — Bridge an external A2A agent into a Relay workspace, send it work, verify response flows back

## File Layout

```
packages/sdk-py/src/agent_relay/communicate/
├── __init__.py          # Add A2ATransport, A2ABridge exports
├── core.py              # No changes (transport-agnostic)
├── transport.py          # Existing Relaycast transport
├── types.py             # Existing types
├── a2a_types.py         # NEW — A2A data model
├── a2a_transport.py     # NEW — A2A client transport
├── a2a_server.py        # NEW — A2A server (makes Relay agent A2A-compliant)  
└── a2a_bridge.py        # NEW — Bridges A2A ↔ Relay workspace

packages/sdk-py/tests/communicate/
├── test_a2a_types.py    # NEW
├── test_a2a_transport.py # NEW
├── test_a2a_server.py   # NEW
├── test_a2a_bridge.py   # NEW
└── test_a2a_e2e.py      # NEW

packages/sdk/src/communicate/
├── index.ts             # Add A2ATransport, A2ABridge exports
├── core.ts              # No changes
├── transport.ts         # Existing
├── types.ts             # Existing
├── a2a-types.ts         # NEW
├── a2a-transport.ts     # NEW
├── a2a-server.ts        # NEW
└── a2a-bridge.ts        # NEW

packages/sdk/src/__tests__/communicate/
├── a2a-types.test.ts    # NEW
├── a2a-transport.test.ts # NEW
├── a2a-server.test.ts   # NEW
├── a2a-bridge.test.ts   # NEW
└── a2a-e2e.test.ts      # NEW
```

## Dependencies

### Python
- `aiohttp` — HTTP server for A2A endpoint (already in requirements)
- No new external dependencies

### TypeScript  
- Uses built-in `http` module for server
- `eventsource` — SSE client for streaming (optional, phase 2)
- No new external dependencies for phase 1

## Implementation Phases

### Phase 1 (this PR) — Core A2A support
- [ ] A2A types (both languages)
- [ ] A2A transport — client side (send messages to A2A agents)
- [ ] A2A server — make Relay agents A2A-discoverable
- [ ] A2A bridge — proxy external A2A agents into Relay workspaces
- [ ] Unit tests (both languages)
- [ ] One integration test per language

### Phase 2 (follow-up) — Production readiness
- [ ] SSE streaming support
- [ ] Push notifications (webhooks)
- [ ] File/structured data parts (not just text)
- [ ] Agent Card auth schemes (OAuth2, API key)
- [ ] A2A agent registry/directory integration
- [ ] Task history and pagination

### Phase 3 (future) — Ecosystem
- [ ] Relaycast server exposes all workspace agents as A2A endpoints
- [ ] A2A agent marketplace integration
- [ ] gRPC binding support
- [ ] Multi-tenant Agent Card routing

## Non-Goals (Phase 1)
- gRPC binding (JSON-RPC over HTTP only)
- Push notifications
- File/binary content in Parts
- Agent Card authentication negotiation
- Automatic agent discovery via DNS/registry
