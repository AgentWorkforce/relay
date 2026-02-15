# Case Study: agent-relay-trading-floor SDK Usage Analysis

**Repository:** https://github.com/zachisit/agent-relay-trading-floor
**SDK Version:** `@agent-relay/sdk@^2.1.14`
**Date:** 2026-02-15

## Overview

A 3-stage trading pipeline (Scanner → Risk Manager → Executor) where each agent is an independent Node.js process communicating through `@agent-relay/sdk`. The project exposes several SDK friction points that, if addressed, would significantly lower the barrier to entry.

---

## Friction Points & SDK Improvement Opportunities

### 1. Constructor: `name` vs `agentName`

**What the user wrote:**
```js
const client = new RelayClient({ name: 'Scanner' });
```

**What the SDK expects:**
```js
const client = new RelayClient({ agentName: 'Scanner' });
```

The user's code passes `{ name: 'Scanner' }`, but `ClientConfig` only recognizes `agentName`. Since the constructor spreads `Partial<ClientConfig>`, the `name` key is silently ignored and the agent defaults to `'agent'`. This is the single most common source of confusion — every new user will try `name` first.

**Recommendation:** Accept `name` as an alias for `agentName`, or better yet, accept a string shorthand:

```ts
// Option A: string shorthand
const client = new RelayClient('Scanner');

// Option B: accept `name` as alias
const client = new RelayClient({ name: 'Scanner' });

// Existing form still works
const client = new RelayClient({ agentName: 'Scanner' });
```

Implementation sketch for the constructor:
```ts
constructor(config: string | Partial<ClientConfig & { name?: string }> = {}) {
  const normalized = typeof config === 'string'
    ? { agentName: config }
    : { ...config, agentName: config.agentName ?? config.name ?? 'agent' };
  this.config = { ...DEFAULT_CLIENT_CONFIG, ...normalized };
  // ...
}
```

This is a ~5-line change with zero breaking impact.

---

### 2. `onMessage` Callback Signature Is Not Discoverable

**What the user wrote:**
```js
client.onMessage = async (msg) => {
  if (msg.source === 'Scanner' || msg.from === 'Scanner') {
    const data = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
    // ...
  }
};
```

**Actual SDK signature:**
```ts
onMessage?: (from: string, payload: SendPayload, messageId: string, meta?: SendMeta, originalTo?: string) => void
```

The user assumed a single message object with `.from`, `.source`, `.data`, `.text`, `.content` fields. The SDK actually passes 5 positional arguments. This is a hard-to-debug mismatch — the code doesn't crash, it just silently misbehaves because `msg` receives the `from` string, then `msg.source` and `msg.from` are both `undefined` on a string.

**Recommendation A — Deliver a message object:** Change `onMessage` to pass a single structured object:

```ts
interface IncomingMessage {
  from: string;
  body: string;
  kind: PayloadKind;
  data?: Record<string, unknown>;
  thread?: string;
  messageId: string;
  meta?: SendMeta;
  originalTo?: string;
}

client.onMessage = (msg: IncomingMessage) => {
  if (msg.from === 'Scanner') {
    console.log(msg.data.symbol); // directly accessible
  }
};
```

This is what every user expects. The current 5-argument signature forces memorization of argument order.

**Recommendation B — If keeping positional args, add `.on()` method as alternative:**

```ts
client.on('message', (msg: IncomingMessage) => { ... });
client.on('message:from:Scanner', (msg) => { ... }); // filtered
client.on('channel:#general', (msg) => { ... });
```

---

### 3. Users Shouldn't Have to `JSON.stringify` Message Bodies

**What the user wrote:**
```js
await client.sendMessage('Risk', JSON.stringify({
  symbol: stock.symbol,
  price: stock.close,
  rsi: stock.rsi,
}));
```

Then on the receiving side:
```js
const data = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
```

**What the SDK already supports but is not obvious:**
```js
// The SDK has a `data` parameter for structured payloads:
client.sendMessage('Risk', 'Oversold alert', 'message', {
  symbol: stock.symbol,
  price: stock.close,
  rsi: stock.rsi,
});

// Receiver gets it pre-parsed:
client.onMessage = (from, payload) => {
  console.log(payload.data.symbol); // already an object
};
```

The user didn't discover the `data` parameter because:
1. It's the 4th positional argument behind `kind` (which they don't care about)
2. `sendMessage(to, body)` is the only example most users see

**Recommendation:** Accept an options object for `sendMessage`:

```ts
// Current (positional — hard to discover optional params)
client.sendMessage('Risk', 'alert', 'message', { symbol: 'AAPL' }, 'thread-1', meta);

// Proposed (object — self-documenting)
client.sendMessage('Risk', 'alert', {
  data: { symbol: 'AAPL', price: 142.50 },
  thread: 'thread-1',
  kind: 'action',
});

// Or even simpler: auto-detect when body is an object
client.sendMessage('Risk', { symbol: 'AAPL', price: 142.50 });
// → body = '', data = { symbol: 'AAPL', price: 142.50 }
```

---

### 4. No Sender Filtering Built-In

Every handler in the trading floor does the same thing:

```js
// executor.js
if (msg.source === 'Risk' || msg.from === 'Risk') { ... }

// risk.js
if (msg.source === 'Scanner' || msg.from === 'Scanner') { ... }
```

This is boilerplate that every pipeline-style application will repeat.

**Recommendation:** Add `.onMessageFrom()` or a filter option:

```ts
// Option A: dedicated method
client.onMessageFrom('Scanner', (payload) => {
  console.log(payload.data.symbol);
});

// Option B: filter parameter
client.onMessage = (msg) => { ... };
client.onMessage.filter({ from: 'Scanner' });

// Option C: EventEmitter-style with namespacing
client.on('message:from:Scanner', (msg) => { ... });
```

Even Option A alone would eliminate the most common boilerplate pattern.

---

### 5. `createRelay()` Should Be the Default Getting-Started Path

The trading floor requires:
1. `npm install agent-relay` (the daemon CLI)
2. Running `agent-relay up` in a separate terminal
3. Then running each agent process separately

But the SDK already has `createRelay()` and `createPair()` which eliminate steps 1-2. The user built their own `MockRelay` class in `safe_demo.js` (~25 lines) to simulate this — not realizing the SDK provides it natively.

**Recommendation:** Make `createRelay` the primary documented path, not a secondary option. The README currently shows it, but the framing suggests "External Daemon Mode" is the normal way. For projects like this trading floor, standalone mode is strictly better.

Additionally, consider a `createSwarm()` helper for 3+ agents:

```ts
import { createSwarm } from '@agent-relay/sdk';

const { agents, stop } = await createSwarm(['Scanner', 'Risk', 'Executor']);
const [scanner, risk, executor] = agents;

// Ready to go — no daemon, no setup
```

---

### 6. Pipeline Pattern Has No First-Class Support

The Scanner → Risk → Executor flow is a textbook pipeline. Users shouldn't have to wire this up manually. The SDK documents pipeline as a pattern in SWARM_PATTERNS.md but provides no helper.

**Recommendation:** Add a pipeline builder:

```ts
import { createPipeline } from '@agent-relay/sdk';

const pipeline = await createPipeline({
  stages: [
    { name: 'Scanner', handler: async (input) => scanMarket(input) },
    { name: 'Risk',    handler: async (signal) => assessRisk(signal) },
    { name: 'Executor', handler: async (order) => executeOrder(order) },
  ],
});

// Push data into the pipeline
await pipeline.push(marketData);

// Or step-by-step with backpressure
pipeline.onComplete((result) => console.log('Trade executed:', result));
```

---

### 7. Graceful Shutdown Is Missing

The scanner does `process.exit(0)` when done. The executor and risk manager run forever with no way to stop. The SDK provides `disconnect()` and `destroy()`, but there's no guidance on lifecycle management.

**Recommendation:** Add `client.onceIdle()` or a `waitForDrain()` method, and document the shutdown pattern:

```ts
// Proposed
await client.waitForDrain(); // wait for outbound queue to flush
client.destroy();

// Or register a shutdown handler
client.onShutdown(() => {
  console.log('Cleaning up...');
});
```

Also consider a `relay.waitForAllIdle()` in standalone mode.

---

### 8. The Simulation Mode Shouldn't Need to Exist

The user built `safe_demo.js` with `MockRelay` because they couldn't reliably run the daemon in WSL2. The fact that `createRelay()` exists means this simulation file is unnecessary — but the user didn't know it existed.

**Recommendation:** Publish a zero-dependency quick-start example that uses `createRelay()` and works everywhere:

```js
// one-file-trading-demo.js — works on any OS, no daemon needed
import { createRelay } from '@agent-relay/sdk';

const relay = await createRelay();
const scanner = await relay.client('Scanner');
const risk = await relay.client('Risk');
const executor = await relay.client('Executor');

// Wire up the pipeline...
// (all in one process, no sockets to debug)
```

---

## Summary: Priority-Ordered Improvements

| # | Change | Effort | Impact |
|---|--------|--------|--------|
| 1 | Accept `name` as alias for `agentName` + string shorthand | Trivial | High — eliminates #1 beginner mistake |
| 2 | Pass a single message object to `onMessage` | Medium | High — matches every user's mental model |
| 3 | Accept options object in `sendMessage` overload | Small | Medium — makes `data` parameter discoverable |
| 4 | Add `onMessageFrom(agent, cb)` filter | Small | Medium — eliminates universal boilerplate |
| 5 | Promote `createRelay()` as primary quick-start | Docs only | High — prevents need for mock implementations |
| 6 | Add `createSwarm()` helper for 3+ agents | Small | Medium — natural next step after `createPair()` |
| 7 | Add pipeline builder pattern | Medium | Low-Medium — nice-to-have for a common pattern |
| 8 | Add graceful shutdown utilities | Small | Low — quality-of-life improvement |

The first five items would have prevented every SDK friction point visible in this project.
