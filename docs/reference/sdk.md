
```bash
npm install @agent-relay/sdk
```


## Spawning Agents

### Shorthand Spawners

```typescript
// Spawn by CLI type
const agent = await relay.claude.spawn(options?)
const agent = await relay.codex.spawn(options?)
const agent = await relay.gemini.spawn(options?)
const agent = await relay.opencode.spawn(options?)
```

**Spawn options:**

| Property    | Type       | Description                                      |
| ----------- | ---------- | ------------------------------------------------ |
| `name`      | `string`   | Agent name (defaults to CLI name)                |
| `model`     | `string`   | Model to use (see Models below)                  |
| `task`      | `string`   | Initial task / prompt                            |
| `channels`  | `string[]` | Channels to join                                 |
| `args`      | `string[]` | Extra CLI arguments                              |
| `cwd`       | `string`   | Working directory override                       |
| `onStart`   | `function` | Sync/async callback before spawn request is sent |
| `onSuccess` | `function` | Sync/async callback after spawn succeeds         |
| `onError`   | `function` | Sync/async callback when spawn fails             |

### `relay.spawn(name, cli, task?, options?)`

Spawn any CLI by name:

```typescript
const agent = await relay.spawn('Worker', 'claude', 'Help with refactoring', {
  model: Models.Claude.SONNET,
  channels: ['team'],
});
```

### `relay.spawnAndWait(name, cli, task, options?)`

Spawn and wait for the agent to be ready before returning:

```typescript
const agent = await relay.spawnAndWait('Worker', 'claude', 'Analyze the codebase', {
  timeoutMs: 30000,
  waitForMessage: false, // true = wait for first message, false = wait for process ready
});
```


## Human Handles

Send messages from a named human or system identity (not a spawned CLI agent):

```typescript
// Named human
const human = relay.human({ name: 'Orchestrator' });
await human.sendMessage({ to: 'Worker', text: 'Start the task' });

// System identity (name: "system")
const sys = relay.system();
await sys.sendMessage({ to: 'Worker', text: 'Stop and report status' });

// Broadcast to all agents
await relay.broadcast('All hands: stand by for new task');
```


## Other Methods

```typescript
// List all known agents
const agents = await relay.listAgents(): Promise<Agent[]>

// Get broker status
const status = await relay.getStatus(): Promise<BrokerStatus>

// Read last N lines of an agent's log file
const logs = await relay.getLogs('Worker', { lines: 100 })
// logs.found: boolean, logs.content: string

// List agents that have log files
const names = await relay.listLoggedAgents(): Promise<string[]>

// Stream an agent's log file (returns handle with .unsubscribe())
const handle = relay.followLogs('Worker', {
  historyLines: 50,
  onEvent(event) {
    if (event.type === 'log') console.log(event.content);
  },
})
handle.unsubscribe();

// Wait for the first of many agents to exit
const { agent, result } = await AgentRelay.waitForAny([agent1, agent2], 60000)

// Shut down all agents and the broker
await relay.shutdown()
```


## Models

```typescript
import { Models } from '@agent-relay/sdk';

// Claude
Models.Claude.OPUS; // 'opus'
Models.Claude.SONNET; // 'sonnet'
Models.Claude.HAIKU; // 'haiku'

// Codex
Models.Codex.GPT_5_4; // 'gpt-5.4' (default)
Models.Codex.GPT_5_3_CODEX; // 'gpt-5.3-codex'

// Gemini
Models.Gemini.GEMINI_3_1_PRO_PREVIEW; // 'gemini-3.1-pro-preview' (default)
Models.Gemini.GEMINI_2_5_PRO; // 'gemini-2.5-pro'

// OpenCode
Models.Opencode.OPENAI_GPT_5_2; // 'openai/gpt-5.2' (default)
Models.Opencode.OPENCODE_GPT_5_NANO; // 'opencode/gpt-5-nano'
```


## See Also

- [Quickstart](/quickstart) — Spawn agents and exchange messages quickly
- [Python SDK Reference](/reference/sdk-py) — Python API reference
