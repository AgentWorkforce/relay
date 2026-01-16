# Competitive Analysis: OpenAI Agents SDK vs agent-relay

**Date**: January 2026
**Analyst**: Claude Agent
**Subject**: openai/openai-agents-python comparison

---

## Executive Summary

The [OpenAI Agents SDK](https://github.com/openai/openai-agents-python) (v0.6.6) is a Python library for building multi-agent workflows programmatically. Unlike claude-flow, this is a **legitimate, well-designed multi-agent framework** from a major vendor.

**Key Finding**: OpenAI Agents SDK and agent-relay are **complementary, not competitive**. They operate at different layers:
- **OpenAI Agents SDK**: A library for *building* agents in Python code
- **agent-relay**: Infrastructure for *coordinating* existing CLI-based agents

You could theoretically build an agent with OpenAI's SDK and have it communicate with Claude Code via agent-relay.

---

## Architecture Comparison

### OpenAI Agents SDK

```
┌─────────────────────────────────────────────────────────┐
│                  Python Application                      │
│  ┌─────────────────────────────────────────────────────┐│
│  │              AgentRunner (orchestrator)              ││
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐             ││
│  │  │ Agent A │←→│ Handoff │←→│ Agent B │             ││
│  │  │ (object)│  │ (tool)  │  │ (object)│             ││
│  │  └────┬────┘  └─────────┘  └────┬────┘             ││
│  │       ↓                         ↓                   ││
│  │  ┌─────────────────────────────────────────────┐   ││
│  │  │           LLM Provider (API calls)           │   ││
│  │  │  OpenAI / Anthropic / 100+ via adapters      │   ││
│  │  └─────────────────────────────────────────────┘   ││
│  └─────────────────────────────────────────────────────┘│
│                         ↓                                │
│           Sessions (SQLite / Redis)                      │
│           Tracing (OpenAI Dashboard)                     │
└─────────────────────────────────────────────────────────┘
```

**Model**: Single Python process → Multiple agent objects → Handoff via tool calls
**Communication**: In-memory function calls and shared state
**Persistence**: SQLite or Redis sessions

### agent-relay

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Claude CLI │    │  Codex CLI  │    │  Custom Bot │
│ (Process 1) │    │ (Process 2) │    │ (Process 3) │
└──────┬──────┘    └──────┬──────┘    └──────┬──────┘
       │                  │                  │
       │  ->relay:Bob     │  ->relay:*       │  ->relay:#dev
       ↓                  ↓                  ↓
┌──────────────────────────────────────────────────────┐
│          relay-pty (Rust) / tmux wrapper             │
│         (Output parsing + message injection)          │
└──────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────┐
│                    Relay Daemon                       │
│     Router → Storage → Session Continuity            │
└──────────────────────────────────────────────────────┘
```

**Model**: Multiple independent processes → Message broker → IPC
**Communication**: Unix sockets, binary framing protocol
**Persistence**: SQLite messages, Ledger/Handoff system

---

## Feature Comparison Matrix

| Capability | OpenAI Agents SDK | agent-relay | Notes |
|------------|-------------------|-------------|-------|
| **Architecture** | Library (in-process) | Infrastructure (multi-process) | Different layers |
| **Language** | Python | TypeScript + Rust | Different ecosystems |
| **Agent Definition** | Code (Python classes) | Any CLI that outputs text | agent-relay is CLI-agnostic |
| **Multi-Agent** | Objects in same process | Separate OS processes | Different meaning |
| **LLM Support** | 100+ via adapters | N/A (infrastructure) | SDK handles LLM calls |
| **Handoffs** | Tool-based delegation | Message-based coordination | Similar concept, different impl |
| **Sessions** | SQLite, Redis | SQLite + Ledger/Handoff | Both have persistence |
| **Tracing** | Built-in + OpenAI Dashboard | Dashboard + message history | Both have observability |
| **Guardrails** | Input/output validation | Not implemented | SDK advantage |
| **Voice/Realtime** | WebSocket streaming | Not applicable | SDK advantage |
| **MCP Support** | Native integration | Not applicable | SDK advantage |
| **Cross-CLI** | No (Python only) | Yes (any terminal agent) | agent-relay advantage |
| **Zero-config agents** | No (must code agents) | Yes (works with existing CLIs) | agent-relay advantage |
| **Shadow agents** | No | Yes | agent-relay advantage |
| **Multi-project** | No | Yes (bridge mode) | agent-relay advantage |

---

## How OpenAI Agents SDK Actually Works

### Execution Model

The SDK runs everything in a **single Python process**. Here's the complete flow:

```
┌─────────────────────────────────────────────────────────────────┐
│                      Runner.run(agent, input)                    │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                     EXECUTION LOOP                         │  │
│  │                                                            │  │
│  │  1. on_agent_start hook                                    │  │
│  │  2. Run input guardrails (turn 1 only)                     │  │
│  │  3. on_llm_start hook                                      │  │
│  │  4. Call LLM (model.get_response())                        │  │
│  │  5. on_llm_end hook                                        │  │
│  │  6. Process response:                                      │  │
│  │     ├─ Final output? → Run output guardrails → Return      │  │
│  │     ├─ Handoff? → on_handoff hook → Switch agent → Loop    │  │
│  │     └─ Tool calls? → Execute tools → Loop                  │  │
│  │  7. Check max_turns, loop back to step 3                   │  │
│  │                                                            │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**Key insight**: A "turn" is one LLM invocation. Tool execution doesn't count as a turn - the loop continues until the LLM produces final output or a handoff.

### How Handoffs Work

Handoffs are **tool calls that the LLM chooses to invoke**:

```python
# Define agents
billing_agent = Agent(name="Billing", instructions="Handle billing...")
refund_agent = Agent(name="Refund", instructions="Process refunds...")

# Triage agent can hand off to either
triage_agent = Agent(
    name="Triage",
    instructions="Route customers to the right department",
    handoffs=[billing_agent, refund_agent]
)
```

When the runner starts, it converts `handoffs` into tool definitions:
```json
{
  "type": "function",
  "function": {
    "name": "transfer_to_billing",
    "description": "Transfer to Billing agent"
  }
}
```

When the LLM calls `transfer_to_billing`, the runner:
1. Fires `on_handoff` lifecycle hook
2. Optionally runs `on_invoke_handoff` callback
3. Applies `input_filter` to conversation history
4. Switches `current_agent` to `billing_agent`
5. Continues the loop with the new agent

**This all happens in-memory** - no IPC, no messages, just swapping object references.

### How Parallelism Works

The SDK uses `asyncio.gather()` for concurrent operations:

```python
# Run 3 translations in parallel
results = await asyncio.gather(
    Runner.run(spanish_agent, text),
    Runner.run(spanish_agent, text),
    Runner.run(spanish_agent, text),
)
# Pick the best one
best = await Runner.run(picker_agent, [r.final_output for r in results])
```

**Key insight**: This is Python async concurrency within one process, not distributed parallelism across machines.

### Session Persistence

```python
# Create session with SQLite backend
session = SQLiteSession("./conversations.db", "user-123")

# Run with session - history auto-managed
result = await Runner.run(agent, input, session=session)

# Later runs automatically get conversation history
result2 = await Runner.run(agent, "follow up", session=session)
```

The session stores:
- All conversation items (messages, tool calls, handoffs)
- JSON serialized to SQLite with timestamps
- Indexed by session ID for retrieval

### Lifecycle Hooks

The SDK provides comprehensive hooks:

```python
class MyHooks(RunHooksBase):
    async def on_agent_start(self, context, agent):
        print(f"Starting {agent.name}")

    async def on_llm_start(self, context, agent):
        print(f"Calling LLM for {agent.name}")

    async def on_llm_end(self, context, agent, response):
        print(f"LLM returned for {agent.name}")

    async def on_tool_start(self, context, agent, tool):
        print(f"Executing {tool.name}")

    async def on_handoff(self, context, from_agent, to_agent):
        print(f"Handoff: {from_agent.name} → {to_agent.name}")

result = await Runner.run(agent, input, run_hooks=MyHooks())
```

---

## Technical Deep Dive: The Real Comparison

### 1. What "Multi-Agent" Means

**OpenAI Agents SDK**: Multiple `Agent` objects within a single Python runtime. They share memory, execute sequentially (or with `asyncio.gather`), and "hand off" via tool calls that switch the active agent.

```python
# All agents exist in the same process
billing_agent = Agent(name="Billing", instructions="...")
refund_agent = Agent(name="Refund", instructions="...")
triage_agent = Agent(
    name="Triage",
    handoffs=[billing_agent, refund_agent]  # Tool-based handoff
)

# Single runner orchestrates everything
result = await Runner.run(triage_agent, "I need a refund")
```

**agent-relay**: Multiple separate processes (could be different machines, different users, different AI providers) communicating through a message broker.

```bash
# Terminal 1: Claude agent
claude --agent-profile lead
# Outputs: ->relay:Coder Please implement the auth module

# Terminal 2: Codex agent (completely separate process)
codex
# Receives: "Relay message from Lead: Please implement the auth module"
```

**Analysis**: OpenAI's "multi-agent" is orchestration within one program. agent-relay's is coordination between independent programs. Both are valid; they solve different problems.

### 2. Handoff Mechanisms

**OpenAI Agents SDK**:
- Handoffs are tool calls that the LLM can invoke
- Transfer happens in-memory by switching the active agent object
- Supports callbacks, input filtering, conditional enabling
- Elegant API: `handoff(agent, on_handoff=callback)`

**agent-relay**:
- Handoffs are explicit messages between processes
- Transfer happens via IPC (Unix socket → daemon → recipient)
- Supports spawn/release for dynamic agent creation
- Session continuity via Ledger + Handoff documents

### 3. Session Management

**OpenAI Agents SDK**:
- `SQLiteSession`: File-based conversation storage
- `RedisSession`: Distributed deployments
- Automatic history management across runs
- Clean API with session IDs

**agent-relay**:
- SQLite for message persistence
- Ledger: Ephemeral within-session state
- Handoff: Permanent cross-session knowledge transfer
- More complex but handles process crashes and restarts

### 4. Observability

**OpenAI Agents SDK**:
- Built-in tracing with spans for all operations
- Integration with OpenAI Dashboard
- Third-party processors (Logfire, AgentOps, etc.)
- Sensitive data filtering

**agent-relay**:
- Web dashboard for real-time monitoring
- Message history with full searchability
- Agent presence tracking
- Log streaming from all agents

---

## Where We Actually Compete

Despite being "complementary," there is real overlap in use cases:

### Overlap 1: Multi-Agent Coordination

| Scenario | OpenAI SDK Approach | agent-relay Approach |
|----------|---------------------|----------------------|
| **Triage → Specialist** | Handoff tool call, in-memory switch | Message: `->relay:Specialist Please handle this` |
| **Parallel workers** | `asyncio.gather()` multiple runs | Spawn multiple agents, broadcast task |
| **Sequential pipeline** | Code orchestration with Runner.run() | Lead agent delegates via messages |
| **Quality review** | Guardrails + separate validator agent | Shadow agent watches primary |

**Who wins**: Depends on constraints:
- Same Python process, fast iteration → OpenAI SDK
- Different machines, different AIs, crash isolation → agent-relay

### Overlap 2: Session Continuity

| Feature | OpenAI SDK | agent-relay |
|---------|------------|-------------|
| **Storage** | SQLite, Redis | SQLite |
| **Scope** | Conversation history | Messages + Ledger + Handoff docs |
| **Cross-session** | Session ID lookup | Handoff documents with context |
| **Crash recovery** | Session persists, re-run | Ledger survives, agent restarts |

**Who wins**:
- OpenAI SDK has cleaner API
- agent-relay handles process crashes better (separate daemon)

### Overlap 3: Observability

| Feature | OpenAI SDK | agent-relay |
|---------|------------|-------------|
| **Tracing** | Spans with OpenAI Dashboard | Message history + Dashboard |
| **Lifecycle events** | Hooks (on_llm_start, etc.) | WebSocket events |
| **Third-party** | Logfire, AgentOps, Braintrust | Custom integrations |

**Who wins**: OpenAI SDK has superior tracing infrastructure

### The Key Differentiator: Process Model

```
OpenAI SDK:
┌─────────────────────────────────────────┐
│           Single Python Process          │
│  Agent A ←→ Agent B ←→ Agent C          │
│     (objects sharing memory)             │
└─────────────────────────────────────────┘
  - Fast (nanosecond handoffs)
  - Simple (one runtime)
  - Fragile (process dies, all agents die)
  - Homogeneous (all Python, same LLM client)

agent-relay:
┌──────────┐  ┌──────────┐  ┌──────────┐
│ Process 1│  │ Process 2│  │ Process 3│
│ Claude   │  │ Codex    │  │ Custom   │
└────┬─────┘  └────┬─────┘  └────┬─────┘
     │             │             │
     └─────────────┼─────────────┘
                   │
            ┌──────┴──────┐
            │ Relay Daemon │
            └─────────────┘
  - Slower (millisecond messages)
  - Complex (distributed system)
  - Resilient (process dies, others continue)
  - Heterogeneous (any CLI, any AI)
```

---

## Honest Assessment

### Where OpenAI Agents SDK Wins

1. **Developer Experience** - Clean Python API, well-documented, easy to start
2. **LLM Integration** - Native support for 100+ models with adapters
3. **Guardrails** - Built-in input/output validation
4. **Voice/Realtime** - WebSocket streaming for voice applications
5. **Corporate Backing** - OpenAI maintains it, 18.4k stars
6. **MCP Integration** - Native Model Context Protocol support
7. **Tracing** - Superior observability with dashboard integration

### Where agent-relay Wins

1. **CLI-Agnostic** - Works with Claude, Codex, Gemini, any terminal agent
2. **True Process Isolation** - Agents can crash independently
3. **Heterogeneous Teams** - Mix different AI providers in one workflow
4. **Zero Code Required** - Existing CLI tools work without modification
5. **Shadow Agents** - Oversight mechanisms not available elsewhere
6. **Multi-Project Bridge** - Cross-repository coordination
7. **Native Performance** - Rust PTY wrapper for <10ms latency

### Where They're Similar

1. Both support persistent sessions
2. Both have observability/tracing
3. Both handle conversation history
4. Both support async operations

---

## Decision Framework: When to Use Which

### Use OpenAI Agents SDK When:

1. **Building from scratch** - You're writing a new Python application
2. **Single-provider LLM** - All agents use same API (OpenAI, Anthropic via adapter)
3. **Fast iteration** - Handoffs need to be instantaneous
4. **Guardrails required** - Need input/output validation
5. **Voice/realtime** - Building voice assistants or streaming apps
6. **Simple deployment** - One process, one container

### Use agent-relay When:

1. **Existing tools** - You have Claude Code, Codex, or other CLIs already
2. **Mixed providers** - Need Claude AND GPT AND Gemini working together
3. **Crash isolation** - One agent failing shouldn't kill others
4. **Human-in-loop** - Developers actively using AI terminals
5. **Cross-repo work** - Agents spanning multiple projects
6. **Oversight needs** - Shadow agents monitoring primary agents

### Use Both Together When:

1. **Enterprise platform** - SDK-built specialized agents + CLI agents coordinated by relay
2. **Hybrid teams** - Some developers use Claude Code directly, others use custom bots
3. **Gradual migration** - Moving from CLI tools to programmatic agents

---

## Complementary Use Cases

These tools can work together:

### Scenario: Enterprise AI Platform

```
┌─────────────────────────────────────────────────────────┐
│                    agent-relay daemon                    │
│  (coordinates all AI agents across the organization)     │
└───────────────────────┬─────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┐
        ↓               ↓               ↓
┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│  Claude Code  │ │ Custom Python │ │    Codex      │
│  (Terminal)   │ │ Agent (SDK)   │ │  (Terminal)   │
└───────────────┘ └───────────────┘ └───────────────┘
                        │
                  Built with OpenAI
                  Agents SDK, but
                  coordinates via
                  agent-relay
```

### Scenario: Hybrid Workflow

1. **OpenAI SDK** builds a specialized customer service agent
2. **agent-relay** coordinates it with Claude Code for code changes
3. Both contribute to a unified workflow

---

## Competitive Positioning

### Market Segments

```
                        Build Agents ←──────────→ Coordinate Agents
                              │                         │
    Programmatic ─────────────┼── OpenAI SDK           │
                              │                         │
    Infrastructure ───────────┼─────────────── agent-relay
                              │                         │
```

### Not Competitors

Unlike claude-flow, the OpenAI Agents SDK is not making inflated claims. It's a well-engineered library that does exactly what it says. The comparison is:

| Aspect | OpenAI Agents SDK | agent-relay |
|--------|-------------------|-------------|
| **Purpose** | Build multi-agent apps | Coordinate existing agents |
| **Users** | Python developers | DevOps, AI teams |
| **Integration** | Import and code | Deploy and configure |
| **Agents** | You build them | They already exist |

---

## Recommendations for agent-relay

### Don't Compete - Complement

1. **Build an adapter** - Let OpenAI SDK agents participate in agent-relay networks
2. **Reference their patterns** - Handoff, guardrails, tracing are well-designed
3. **Different messaging** - "Coordinate your AI agents" vs "Build AI agents"

### Learn From Their Design

1. **Guardrails** - Consider adding input/output validation for messages
   ```typescript
   // Potential API for agent-relay
   relay.addGuardrail({
     type: 'input',
     validate: (msg) => !msg.includes('API_KEY'),
     action: 'block'
   });
   ```

2. **Tracing API** - Their span-based model is elegant
   ```typescript
   // Potential tracing improvement
   const span = relay.trace.startSpan('agent-coordination');
   span.addEvent('message_sent', { to: 'Coder', size: 150 });
   span.end();
   ```

3. **Session protocol** - Their Session interface is clean
   ```typescript
   // Our Ledger/Handoff could adopt similar interface
   interface RelaySession {
     get(key: string): Promise<unknown>;
     set(key: string, value: unknown): Promise<void>;
     getHistory(): Promise<Message[]>;
   }
   ```

4. **Lifecycle hooks** - More granular callbacks
   ```typescript
   relay.hooks.on('beforeMessageSend', (msg) => { /* ... */ });
   relay.hooks.on('afterMessageDeliver', (msg) => { /* ... */ });
   relay.hooks.on('agentSpawn', (agent) => { /* ... */ });
   ```

5. **Structured handoff data** - Their HandoffInputData pattern
   ```typescript
   // Enhanced spawn with structured context
   relay.spawn({
     name: 'Worker',
     cli: 'claude',
     context: {
       task: 'Implement auth',
       files: ['src/auth.ts'],
       decisions: [{ choice: 'JWT', reason: 'Stateless' }]
     }
   });
   ```

### Emphasize Our Unique Value

1. **"Works with what you have"** - No code required
2. **"True process isolation"** - Crash resistance
3. **"Any AI, any terminal"** - Heterogeneous support
4. **"Observable by default"** - Dashboard included

---

## Competitive Threat Assessment

### Short-term (6-12 months): Low Direct Threat

OpenAI SDK targets **Python developers building new applications**. agent-relay targets **teams using existing CLI AI tools**. Different buyers, different use cases.

### Medium-term (1-2 years): Moderate Threat

If OpenAI SDK adds:
- **Process spawning** - Ability to run agents as separate processes
- **CLI wrappers** - Integrate with Claude Code, Codex directly
- **Cross-language support** - TypeScript/Rust SDKs

Then the "complementary" positioning weakens.

### Long-term (2+ years): Platform Risk

Both projects face existential risk if:
- **Claude Code adds native multi-agent** - Anthropic builds this in
- **VS Code/IDEs integrate agent coordination** - Becomes IDE feature
- **OS-level agent orchestration** - Apple/Microsoft build it

### Defensive Moats

**OpenAI SDK moats**:
- OpenAI brand and distribution
- 18.4k stars, community momentum
- MCP integration, voice/realtime features
- First-party tracing dashboard

**agent-relay moats**:
- CLI-agnostic (works with anything)
- True process isolation (crash resilience)
- Rust PTY wrapper (performance)
- Shadow agents (unique feature)
- Multi-project bridge (unique feature)

### Strategic Response

1. **Double down on CLI integration** - This is our unique value
2. **Add OpenAI SDK adapter** - Let their agents join our networks
3. **Emphasize heterogeneous teams** - Claude + Codex + Gemini story
4. **Build enterprise features** - RBAC, audit logs, compliance

---

## Conclusion

The OpenAI Agents SDK is a **legitimate, well-designed framework** for building multi-agent applications in Python. It's not making inflated claims like claude-flow.

**Key insight**: We're solving different problems:
- **OpenAI SDK**: "How do I build agents that work together?"
- **agent-relay**: "How do I make existing agents work together?"

The OpenAI SDK is for developers building new agent applications. agent-relay is for teams wanting to coordinate AI tools they already use.

**Recommendation**: Position agent-relay as complementary infrastructure, not a competitor. Consider building bridges that let SDK-built agents participate in relay networks.

---

## Appendix: Repository Statistics

| Metric | OpenAI Agents SDK | agent-relay |
|--------|-------------------|-------------|
| Version | 0.6.6 | 1.5.0 |
| Language | Python (99.4%) | TypeScript + Rust |
| Stars | 18.4k | - |
| Forks | 3.1k | - |
| Created | March 2025 | - |
| License | MIT | - |
| Python | 3.9-3.14 | N/A |
| Node.js | N/A | 20+ |
| Key Deps | openai, pydantic, mcp | better-sqlite3, commander |

---

## Appendix: Code Quality Comparison

Both projects demonstrate good engineering practices:

**OpenAI Agents SDK**:
- Type hints throughout (py.typed)
- Comprehensive test suite
- Clean separation of concerns
- Well-documented APIs
- Async-first design

**agent-relay**:
- TypeScript strict mode
- Rust for performance-critical paths
- Binary protocol with clear framing
- Session continuity for reliability
- Observable architecture
