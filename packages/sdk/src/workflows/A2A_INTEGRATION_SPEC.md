# A2A Protocol Integration Spec

> Integrate [Google's A2A (Agent-to-Agent) Protocol](https://github.com/google/A2A) with the agent-relay SDK, enabling workflows to orchestrate external A2A-compatible agents alongside local CLI agents.

**Status:** Draft
**Date:** 2026-02-28

---

## Problem

The relay SDK currently only supports agents that run as local CLI processes (PTY or headless). This means:

- External agents (LangChain, CrewAI, n8n, custom Python agents) can't participate in relay workflows
- There's no standard protocol for relay to talk to remote agents over HTTP
- Users must wrap everything as a CLI tool even when an HTTP service already exists

The A2A protocol solves this. It defines a standard JSON-RPC 2.0 interface for agent-to-agent communication over HTTP, with agent discovery via `/.well-known/agent.json`. The [a2a-adapter](https://github.com/hybroai/a2a-adapter) SDK makes any Python agent A2A-compatible with 3 lines of code.

## Goals

1. Relay workflows can orchestrate A2A agents as first-class step participants
2. A2A agents are discoverable — the runner fetches their `AgentCard` before execution
3. Streaming support — A2A agents that support SSE streaming report incremental progress
4. Zero changes to existing PTY/headless workflows — purely additive
5. Relay agents can be exposed as A2A servers (outbound direction)

## Non-Goals

- Building a general-purpose A2A SDK in TypeScript (use the existing one)
- Replacing Relaycast messaging — A2A agents are request/response, not pub/sub
- Multi-turn conversation state management (A2A `contextId` support is Phase 2)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   WorkflowRunner                            │
│                                                             │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │ Agent     │  │ Deterministic│  │ A2A Step              │ │
│  │ Step      │  │ Step         │  │ (NEW)                 │ │
│  │           │  │              │  │                       │ │
│  │ spawn PTY │  │ exec shell   │  │ HTTP POST to          │ │
│  │ wait idle │  │ capture out  │  │ A2A server             │ │
│  └──────────┘  └──────────────┘  └───────┬───────────────┘ │
│                                          │                  │
└──────────────────────────────────────────┼──────────────────┘
                                           │
                              ┌─────────────▼──────────────┐
                              │       A2AClient            │
                              │  (packages/sdk/src/a2a/)   │
                              │                            │
                              │  getAgentCard()            │
                              │  sendMessage()             │
                              │  streamMessage()           │
                              └─────────────┬──────────────┘
                                            │ HTTP
                              ┌─────────────▼──────────────┐
                              │   External A2A Server      │
                              │   /.well-known/agent.json  │
                              │   JSON-RPC 2.0 endpoint    │
                              │                            │
                              │   (a2a-adapter, ADK, etc.) │
                              └────────────────────────────┘
```

### Integration with existing step types

The runner already dispatches on `step.type`:

| `step.type` | Runtime | Communication |
|---|---|---|
| `agent` (default) | PTY process | Relay messages via Relaycast MCP |
| `deterministic` | Shell subprocess | stdin/stdout |
| `worktree` | Git worktree setup | Filesystem |
| **`a2a`** (new) | **HTTP client** | **JSON-RPC 2.0 / SSE** |

A2A steps are conceptually similar to deterministic steps — fire a request, get a response — but the "executor" is a remote HTTP agent instead of a local shell command.

---

## Detailed Design

### 1. A2A Client (`packages/sdk/src/a2a/client.ts`)

Thin HTTP client that speaks the A2A JSON-RPC 2.0 protocol.

```typescript
export interface A2AClientOptions {
  /** Base URL of the A2A server (e.g. "http://localhost:9000") */
  url: string;
  /** Request timeout in ms. Default: 60_000. */
  timeoutMs?: number;
  /** Optional auth headers (e.g. Bearer token). */
  headers?: Record<string, string>;
}

export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications?: boolean;
  };
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags?: string[];
  }>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
}

export interface A2ATaskResult {
  taskId: string;
  status: 'completed' | 'failed' | 'canceled';
  text: string;
  /** Raw A2A Task object for callers that need full fidelity. */
  raw: unknown;
}

export class A2AClient {
  constructor(private opts: A2AClientOptions) {}

  /** Fetch the agent's capabilities from /.well-known/agent.json */
  async getAgentCard(): Promise<A2AAgentCard>;

  /**
   * Send a message and wait for the full response (message/send).
   * Returns the completed task with extracted text output.
   */
  async sendMessage(text: string, contextId?: string): Promise<A2ATaskResult>;

  /**
   * Send a message and stream the response via SSE (message/stream).
   * Yields text chunks as they arrive.
   * Falls back to sendMessage() if the agent doesn't support streaming.
   */
  async *streamMessage(text: string, contextId?: string): AsyncGenerator<string>;

  /**
   * Cancel an in-flight task.
   */
  async cancelTask(taskId: string): Promise<void>;
}
```

**JSON-RPC wire format** (what A2AClient sends):

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [{ "type": "text", "text": "<task description>" }],
      "messageId": "<uuid>"
    }
  }
}
```

**Response parsing:** Extract text from `result.artifacts[0].parts[0].text` (the standard A2A response shape). Handle `result.status.state === "failed"` as a step failure.

### 2. Type Extensions (`packages/sdk/src/workflows/types.ts`)

Extend `WorkflowStepType` and `AgentDefinition` to support A2A:

```typescript
// Extend step types
export type WorkflowStepType = 'agent' | 'deterministic' | 'worktree' | 'a2a';

// New: A2A-specific agent definition (optional, agents can also be inline on steps)
export interface A2AAgentDefinition {
  name: string;
  /** Must be 'a2a' to distinguish from CLI agents. */
  runtime: 'a2a';
  /** URL of the A2A server. */
  url: string;
  /** Optional auth headers. */
  headers?: Record<string, string>;
  /** Role description (same as CLI agents). */
  role?: string;
  /** Request timeout in ms. Default: 60_000. */
  timeoutMs?: number;
  /** Prefer streaming if the agent supports it. Default: true. */
  streaming?: boolean;
}

// Extend WorkflowStep with A2A fields
export interface WorkflowStep {
  // ... existing fields ...

  // ── A2A step fields ────────────────────────────────────────
  /** URL of the A2A server (shorthand when no agent definition is used). */
  url?: string;
  /** Auth headers for the A2A request. */
  headers?: Record<string, string>;
  /** Prefer streaming if available. Default: true. */
  streaming?: boolean;
}

// Type guard
export function isA2AStep(step: WorkflowStep): boolean {
  return step.type === 'a2a';
}
```

### 3. Workflow Runner Changes (`packages/sdk/src/workflows/runner.ts`)

Add A2A step execution alongside existing deterministic/agent/worktree handling.

```typescript
// In the step dispatch logic (around line 964):
if (isA2AStep(step)) {
  return this.executeA2AStep(step, resolvedTask);
}

private async executeA2AStep(
  step: WorkflowStep,
  task: string
): Promise<StepResult> {
  // 1. Resolve A2A agent URL from step or agent definition
  const url = step.url ?? this.getA2AAgentUrl(step.agent);
  const client = new A2AClient({ url, headers: step.headers });

  // 2. Optional: fetch AgentCard for validation/logging
  try {
    const card = await client.getAgentCard();
    this.log(`  A2A agent: ${card.name} (${card.description})`);
  } catch {
    this.log(`  A2A agent at ${url} (no agent card available)`);
  }

  // 3. Execute: stream or send
  const useStreaming = step.streaming !== false;
  let output: string;

  if (useStreaming) {
    const chunks: string[] = [];
    try {
      for await (const chunk of client.streamMessage(task)) {
        chunks.push(chunk);
        // Post incremental progress to channel
        if (chunks.length % 10 === 0) {
          this.postToChannel(`**[${step.name}]** A2A streaming... (${chunks.length} chunks)`);
        }
      }
      output = chunks.join('');
    } catch {
      // Fall back to non-streaming
      const result = await client.sendMessage(task);
      if (result.status === 'failed') {
        throw new Error(`A2A agent failed: ${result.text}`);
      }
      output = result.text;
    }
  } else {
    const result = await client.sendMessage(task);
    if (result.status === 'failed') {
      throw new Error(`A2A agent failed: ${result.text}`);
    }
    output = result.text;
  }

  // 4. Store output for downstream {{steps.X.output}} interpolation
  this.postToChannel(
    `**[${step.name}]** Completed (a2a)\n${output.slice(0, 500)}${output.length > 500 ? '\n...(truncated)' : ''}`
  );

  return { output, exitCode: 0 };
}
```

### 4. Schema Updates (`packages/sdk/src/workflows/schema.json`)

Add `a2a` to the step type enum and add A2A-specific fields:

```json
{
  "properties": {
    "type": {
      "enum": ["agent", "deterministic", "worktree", "a2a"]
    },
    "url": {
      "type": "string",
      "format": "uri",
      "description": "URL of the A2A server (required for a2a steps)"
    },
    "headers": {
      "type": "object",
      "additionalProperties": { "type": "string" },
      "description": "Auth headers for the A2A request"
    },
    "streaming": {
      "type": "boolean",
      "default": true,
      "description": "Prefer streaming if the A2A agent supports it"
    }
  }
}
```

### 5. WorkflowBuilder API (`packages/sdk/src/workflows/builder.ts`)

Add fluent methods for A2A agents and steps:

```typescript
// New: define an A2A agent
workflow("my-flow")
  .a2aAgent("data-processor", {
    url: "http://localhost:9000",
    role: "Processes data via n8n",
  })
  .step("fetch-data", {
    type: "a2a",
    agent: "data-processor",
    task: "Pull latest dataset from warehouse",
  })
  .run();

// Shorthand: inline URL on the step (no separate agent definition)
workflow("quick")
  .step("summarize", {
    type: "a2a",
    url: "http://localhost:9001",
    task: "Summarize this document: {{steps.read.output}}",
  })
  .run();
```

---

## YAML Examples

### Hybrid workflow: CLI + A2A agents

```yaml
version: "1"
name: hybrid-data-pipeline
description: Mix local CLI agents with remote A2A agents
swarm:
  pattern: dag

agents:
  - name: planner
    cli: claude
    role: "Plans implementation approach"

  - name: data-processor
    runtime: a2a
    url: http://localhost:9000
    role: "n8n workflow that processes data"

  - name: summarizer
    runtime: a2a
    url: http://localhost:9001
    role: "LangChain summarization agent"
    streaming: true

  - name: developer
    cli: codex
    role: "Implements code changes"
    interactive: false

workflows:
  - name: main
    steps:
      - name: plan
        agent: planner
        task: "Analyze the feature request and create an implementation plan"
        verification:
          type: output_contains
          value: "PLAN_COMPLETE"

      - name: fetch-data
        type: a2a
        agent: data-processor
        task: "Pull dataset from warehouse and return as JSON"
        dependsOn: [plan]
        timeoutMs: 120000

      - name: summarize
        type: a2a
        agent: summarizer
        task: "Summarize the data: {{steps.fetch-data.output}}"
        dependsOn: [fetch-data]

      - name: implement
        agent: developer
        task: |
          Implement the plan using this data summary:
          {{steps.summarize.output}}
        dependsOn: [summarize]

      - name: test
        type: deterministic
        command: npm test
        dependsOn: [implement]
```

### A2A-only workflow (orchestrate external agents)

```yaml
version: "1"
name: a2a-pipeline
description: Orchestrate multiple A2A agents without any local CLI agents
swarm:
  pattern: pipeline

agents:
  - name: researcher
    runtime: a2a
    url: http://research-agent:9000

  - name: writer
    runtime: a2a
    url: http://writer-agent:9001
    streaming: true

  - name: reviewer
    runtime: a2a
    url: http://review-agent:9002

workflows:
  - name: main
    steps:
      - name: research
        type: a2a
        agent: researcher
        task: "Research the topic: {{input}}"

      - name: write
        type: a2a
        agent: writer
        task: "Write an article based on: {{steps.research.output}}"
        dependsOn: [research]

      - name: review
        type: a2a
        agent: reviewer
        task: "Review this article for accuracy: {{steps.write.output}}"
        dependsOn: [write]
```

---

## Phase 2: Expose Relay Agents as A2A Servers (Outbound)

The reverse direction: make relay agents callable by external A2A clients.

### `RelayA2AAdapter` (Python, for use with a2a-adapter)

```python
from a2a_adapter import BaseA2AAdapter, AdapterMetadata, serve_agent
import httpx
import asyncio

class RelayA2AAdapter(BaseA2AAdapter):
    """Exposes an agent-relay workspace as an A2A-compatible server.

    Sends tasks to a relay channel, polls for DONE: response.
    """
    def __init__(
        self,
        relay_api_key: str,
        channel: str = "general",
        target_agent: str | None = None,
        base_url: str = "https://api.relaycast.dev",
        poll_interval: float = 2.0,
        timeout: float = 300.0,
    ):
        self.api_key = relay_api_key
        self.channel = channel
        self.target_agent = target_agent
        self.base_url = base_url
        self.poll_interval = poll_interval
        self.timeout = timeout

    async def invoke(self, user_input: str, context_id=None, **kwargs) -> str:
        headers = {"Authorization": f"Bearer {self.api_key}"}

        async with httpx.AsyncClient(base_url=self.base_url, headers=headers) as client:
            # Post task to relay channel
            await client.post("/channels/messages", json={
                "channel": self.channel,
                "text": user_input,
            })

            # Poll for DONE: response from the target agent
            deadline = asyncio.get_event_loop().time() + self.timeout
            while asyncio.get_event_loop().time() < deadline:
                resp = await client.get("/channels/messages", params={
                    "channel": self.channel,
                    "limit": 20,
                })
                messages = resp.json()
                for msg in messages:
                    if msg.get("text", "").startswith("DONE:"):
                        if self.target_agent and msg.get("from") != self.target_agent:
                            continue
                        return msg["text"].removeprefix("DONE:").strip()

                await asyncio.sleep(self.poll_interval)

            raise TimeoutError(f"No DONE response within {self.timeout}s")

    def get_metadata(self) -> AdapterMetadata:
        return AdapterMetadata(
            name="Agent Relay",
            description=f"Multi-agent workspace (channel: {self.channel})",
            streaming=False,
        )

# Usage:
# serve_agent(RelayA2AAdapter(relay_api_key="rk_live_..."), port=9000)
```

### `relay a2a serve` CLI command (TypeScript, native)

Alternative to the Python adapter — a CLI command that starts an A2A-compliant HTTP server backed by the relay broker:

```
relay a2a serve --port 9000 --channel general --agent Worker1
```

This would:
1. Start the broker
2. Spawn the target agent
3. Start an HTTP server with `/.well-known/agent.json` and JSON-RPC endpoint
4. Route incoming `message/send` requests to the agent via relay messaging
5. Wait for `DONE:` response and return it as the A2A task result

---

## File Inventory

| File | Change | Description |
|---|---|---|
| `packages/sdk/src/a2a/client.ts` | New | A2A JSON-RPC 2.0 HTTP client |
| `packages/sdk/src/a2a/types.ts` | New | A2A protocol types (AgentCard, Task, etc.) |
| `packages/sdk/src/a2a/index.ts` | New | Barrel export |
| `packages/sdk/src/workflows/types.ts` | Modify | Add `'a2a'` to `WorkflowStepType`, add A2A fields to `WorkflowStep`, add `A2AAgentDefinition` |
| `packages/sdk/src/workflows/runner.ts` | Modify | Add `executeA2AStep()`, update step dispatch, add AgentCard preflight |
| `packages/sdk/src/workflows/builder.ts` | Modify | Add `.a2aAgent()` method, support `type: 'a2a'` in `.step()` |
| `packages/sdk/src/workflows/schema.json` | Modify | Add `a2a` to step type enum, add `url`/`headers`/`streaming` fields |
| `packages/sdk/src/workflows/validator.ts` | Modify | Validate A2A steps have `url` (direct or via agent definition) |
| `packages/sdk/src/index.ts` | Modify | Re-export `@agent-relay/sdk/a2a` |
| `packages/sdk/package.json` | Modify | Add `./a2a` subpath export |
| `packages/sdk/src/a2a/__tests__/client.test.ts` | New | Unit tests for A2AClient |
| `packages/sdk/src/workflows/__tests__/a2a-step.test.ts` | New | Integration tests for A2A workflow steps |

---

## Open Questions

1. **Agent definition vs inline URL:** Should A2A agents always be defined in the `agents:` section, or should inline `url` on steps be sufficient? Current proposal: both are valid. Agent definitions enable reuse across steps; inline URLs are convenient for one-off calls.

2. **Multi-turn context:** The A2A protocol supports `contextId` for multi-turn conversations. Should relay pass a consistent `contextId` across steps that use the same A2A agent? This would enable stateful agents but adds complexity.

3. **A2A agent health checks:** Should the runner ping `/.well-known/agent.json` during preflight to verify A2A agents are reachable? This catches misconfiguration early but adds latency.

4. **Push notifications:** A2A supports push notifications for long-running tasks. Should relay subscribe to these instead of polling? This would require a callback URL, which complicates the broker's network requirements.

5. **Relaycast bridge:** Instead of direct HTTP, should A2A agents be registered as Relaycast agents so they appear in the observer dashboard? This would unify the monitoring story but requires Relaycast-side changes.
