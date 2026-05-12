![Agent Relay](../../readme-banner.png)

<div align="center">

# @agent-relay/events

Normalized event stream for proactive agents — Layer 2 of the Agent Relay runtime.

[![npm](https://img.shields.io/npm/v/@agent-relay/events)](https://www.npmjs.com/package/@agent-relay/events)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](../../LICENSE)

**Website:** [agentrelay.com](https://agentrelay.com) · **Docs:** [agentrelay.com/docs](https://agentrelay.com/docs)

</div>

## What it does

`@agent-relay/events` turns the three proactive primitives (cron, watch, inbox) into one normalized event stream. Subscribe with a single `onEvent` handler; receive lightweight envelopes that you can lazily `expand()` to full payloads.

It is the transport-agnostic core: no workspace concept, no scheduling, no cloud assumptions — pure event stream plus retry policy plus OpenTelemetry tracing. Compose it directly for hosted webhooks, or build a higher-level runtime on top (see [`@agent-relay/agent`](../agent)).

## Install

```bash
npm install @agent-relay/events
```

## Quick start

```ts
import { events } from '@agent-relay/events';

const handle = events({
  workspace: 'support',
  apiKey: process.env.RELAY_API_KEY!,
  onEvent: async (event) => {
    console.log(event.type, event.resource.path);

    const full = await event.expand('full');
    // ... act on full.data
  },
});

// ... later
await handle.stop();
```

## Event envelope shape

Every event arrives as a normalized `AgentEvent`:

```ts
type AgentEvent = {
  id: string;                           // stable event id
  workspace: string;
  type: 'cron.tick' | 'startup' | 'relayfile.changed' | 'relaycast.message' | ...;
  occurredAt: string;                   // ISO timestamp
  attempt: number;                      // delivery attempt count
  resource: { path: string; kind: string; id: string; provider: string };
  summary: EventSummary;                // <1KB, PII-stripped
  expand: (level: 'summary' | 'full' | 'diff' | 'thread') => Promise<Expansion>;
  digest?: string;
};
```

The envelope is the **shape your handler receives** — not the full provider payload. Call `event.expand('full')` to materialize the resource lazily.

## Expansion levels

| Level     | What you get                                            | Cost              |
| --------- | ------------------------------------------------------- | ----------------- |
| `summary` | Pre-included lightweight summary (already on the event) | free              |
| `full`    | Full canonical resource via gateway / relayfile VFS     | one read          |
| `diff`    | Changed fields vs prior state                           | one read          |
| `thread`  | Paginated comments / replies                            | one or more reads |

## Retry + NoRetry sentinel

```ts
import { events, NoRetry } from '@agent-relay/events';

events({
  workspace: 'support',
  apiKey: process.env.RELAY_API_KEY!,
  onEvent: async (event) => {
    try {
      // ... your work
    } catch (err) {
      if (isPermanent(err)) throw new NoRetry(err); // skip retry queue
      throw err; // 5-attempt exp backoff
    }
  },
});
```

## OpenTelemetry

Every dispatched event is wrapped in a `SpanKind.CONSUMER` span tagged with the event id, type, workspace, and attempt. Configure your exporter (e.g. `OTEL_EXPORTER_OTLP_ENDPOINT`) — `@agent-relay/events` plugs into the global tracer provider via `@opentelemetry/api`.

## Related

- [`@agent-relay/agent`](../agent) — Layer 3: workspace + ctx + `agent({...})` API on top of this stream
- [`@agent-relay/sdk`](../sdk) — broker control + workflow orchestration
- [Proactive Agent Runtime spec](https://github.com/AgentWorkforce/cloud/blob/main/docs/proactive-runtime/spec.md) — the design this implements

## License

Apache-2.0 — see [LICENSE](../../LICENSE).
