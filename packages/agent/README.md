![Agent Relay](../../readme-banner.png)

<div align="center">

# @agent-relay/agent

The proactive agent runtime — one handler, three triggers, one workspace.

[![npm](https://img.shields.io/npm/v/@agent-relay/agent)](https://www.npmjs.com/package/@agent-relay/agent)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](../../LICENSE)

**Website:** [agentrelay.com](https://agentrelay.com) · **Docs:** [agentrelay.com/docs](https://agentrelay.com/docs)

</div>

## What it does

`@agent-relay/agent` lets a developer ship a proactive agent in under 10 minutes and ~30 lines of code. One `agent({ ... })` call, one `onEvent` handler, and the runtime wires up cron schedules, file watches, and inbox messages into a single normalized stream — with shared workspace + `ctx`, policy gating, retry, dedup, and tracing.

It is built on [`@agent-relay/events`](../events) (Layer 2 — the transport-agnostic event stream) and exposes the workspace-aware Layer 3 surface developers actually want to call.

## Install

```bash
npm install @agent-relay/agent
```

## Quick start

```ts
import { agent } from '@agent-relay/agent';

const handle = agent({
  workspace: 'support',
  schedule: { every: '5m' },
  watch: ['/linear/issues/**'],
  onEvent: async (event, ctx) => {
    switch (event.type) {
      case 'cron.tick':
        await ctx.messages.post({ channel: '#triage', text: 'tick' });
        return;

      case 'relayfile.changed':
        const issue = await event.expand('full');
        await ctx.once(`triage:${event.id}`, async () => {
          // dedup-safe work
        });
        return;
    }
  },
});

// ... later
await handle.stop();
```

## The handler contract

Every handler receives `(event, ctx)`:

- `event` — a normalized [`AgentEvent`](../events) envelope (lightweight; call `event.expand('full')` to materialize the resource)
- `ctx` — workspace-aware context: `ctx.workspace`, `ctx.agentId`, `ctx.logger`, `ctx.signal` (AbortSignal), `ctx.schedule.{at,every,cancel}`, `ctx.once(key, fn)`, `ctx.files`, `ctx.messages`

## Policy enforcement

```ts
agent({
  workspace: 'support',
  policy: { mode: 'approval-required', approvals: ['#triage-leads'] },
  onEvent: async (event, ctx) => {
    // each side-effect is gated through policy
    await ctx.messages.post({ channel: '#triage', text: 'ack' });
  },
});
```

| Mode                | Behavior                                         |
| ------------------- | ------------------------------------------------ |
| `suggest`           | Surface intent to ctx; do not execute            |
| `auto`              | Execute immediately (default)                    |
| `approval-required` | Block on human approval via `approvals` channels |

## Hosted Agent deployment

```ts
import { deployAgent } from '@agent-relay/agent';

await deployAgent({
  name: 'support-triage',
  workspace: 'support',
  source: './agent.ts',
  provider: { mode: 'byok' },
});
```

(See the [Proactive Agent Runtime spec §7](https://github.com/AgentWorkforce/cloud/blob/main/docs/proactive-runtime/spec.md) for Hosted Agent semantics.)

## Burn (LLM call tagging)

LLM calls inside `ctx.*` are auto-tagged with `(workspace, agentId, event.type, event.id)` for observability via `burn`. Wrap any code path explicitly with `withBurnTags({...}, fn)` if you need to add custom dimensions.

## Related

- [`@agent-relay/events`](../events) — Layer 2 normalized event stream that this builds on
- [`@agent-relay/sdk`](../sdk) — broker control + workflow orchestration
- [Proactive Agent Runtime spec](https://github.com/AgentWorkforce/cloud/blob/main/docs/proactive-runtime/spec.md) — the design this implements

## License

Apache-2.0 — see [LICENSE](../../LICENSE).
