# `@agent-relay/sdk`

TypeScript SDK for driving `agent-relay-broker init` over stdio.

## Status

- Broker lifecycle + request/response protocol client implemented.
- Spawn/list/release/shutdown APIs implemented.
- Event subscription for broker `event` frames implemented.
- Agent idle detection — configurable silence threshold with `onAgentIdle` hook and `waitForIdle()`.

## Bundled binary

- The SDK package bundles `agent-relay-broker` inside `bin/` during `npm run build` and `npm pack`.
- By default, `AgentRelayClient` uses the bundled binary path when present.
- You can still override with `binaryPath` in `AgentRelayClient.start(...)`.

## Quick example

```ts
import { AgentRelayClient } from '@agent-relay/sdk';

const client = await AgentRelayClient.start({
  binaryPath: '/absolute/path/to/agent-relay-broker',
  env: process.env,
});

await client.spawnPty({
  name: 'Worker1',
  cli: 'codex',
  args: ['--model', 'gpt-5'],
  channels: ['general'],
});

const agents = await client.listAgents();
console.log(agents);

await client.release('Worker1');
await client.shutdown();
```

### High-level API with idle detection

```ts
import { AgentRelay } from '@agent-relay/sdk';

const relay = new AgentRelay();

// Listen for idle events
relay.onAgentIdle = ({ name, idleSecs }) => {
  console.log(`${name} has been idle for ${idleSecs}s`);
};

const agent = await relay.spawnPty({
  name: 'Worker1',
  cli: 'claude',
  channels: ['general'],
  idleThresholdSecs: 30, // emit agent_idle after 30s of silence (default), 0 to disable
});

// Wait for the agent to go idle (e.g. after finishing its task)
const result = await agent.waitForIdle(120_000); // 2 min timeout
if (result === 'idle') {
  console.log('Agent finished work');
} else if (result === 'exited') {
  console.log('Agent exited');
} else {
  console.log('Timed out waiting for idle');
}

await relay.shutdown();
```

## Tic-tac-toe demo script

After build, run:

```bash
npm --prefix packages/sdk run example
```

Optional env:

- `CODEX_CMD` (default: `codex`)
- `CODEX_ARGS` (space-separated CLI args)
- `AGENT_X_NAME` / `AGENT_O_NAME`
- `RELAY_CHANNEL` (default: `general`)
- `AGENT_RELAY_BIN` (override bundled binary path)

## Integration test

```bash
cargo build
npm --prefix packages/sdk install
npm --prefix packages/sdk run build
AGENT_RELAY_BIN="$(pwd)/target/debug/agent-relay-broker" npm --prefix packages/sdk run test:integration
```

Integration tests require Relaycast credentials in environment (`RELAY_API_KEY`).

## Package tarball

```bash
npm --prefix packages/sdk pack
```

The generated tarball includes `dist/` and `bin/agent-relay-broker` (or `bin/agent-relay-broker.exe` on Windows).
