# `@agent-relay/broker-sdk`

TypeScript SDK for driving `agent-relay init` over stdio.

## Status
- Broker lifecycle + request/response protocol client implemented.
- Spawn/list/release/shutdown APIs implemented.
- Event subscription for broker `event` frames implemented.

## Bundled binary
- The SDK package bundles `agent-relay` inside `bin/` during `npm run build` and `npm pack`.
- By default, `AgentRelayClient` uses the bundled binary path when present.
- You can still override with `binaryPath` in `AgentRelayClient.start(...)`.

## Quick example
```ts
import { AgentRelayClient } from "@agent-relay/broker-sdk";

const client = await AgentRelayClient.start({
  binaryPath: "/absolute/path/to/agent-relay",
  env: process.env,
});

await client.spawnPty({
  name: "Worker1",
  cli: "codex",
  args: ["--model", "gpt-5"],
  channels: ["general"],
});

const agents = await client.listAgents();
console.log(agents);

await client.release("Worker1");
await client.shutdown();
```

## Tic-tac-toe demo script
After build, run:
```bash
npm --prefix packages/sdk-ts run example
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
npm --prefix packages/sdk-ts install
npm --prefix packages/sdk-ts run build
AGENT_RELAY_BIN="$(pwd)/target/debug/agent-relay" npm --prefix packages/sdk-ts run test:integration
```

Integration tests require Relaycast credentials in environment (`RELAY_API_KEY`).

## Package tarball
```bash
npm --prefix packages/sdk-ts pack
```
The generated tarball includes `dist/` and `bin/agent-relay` (or `bin/agent-relay.exe` on Windows).
