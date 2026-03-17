# AI SDK

Connect an [AI SDK](https://ai-sdk.dev/docs/introduction) app to Relaycast with a single `onRelay()` call.

## Quick Start

```typescript
import { streamText, wrapLanguageModel } from 'ai';
import { openai } from '@ai-sdk/openai';
import { Relay } from '@agent-relay/sdk/communicate';
import { onRelay } from '@agent-relay/sdk/communicate/adapters/ai-sdk';

const relay = new Relay('SupportLead');
const relaySession = onRelay({ name: 'SupportLead' }, relay);

const model = wrapLanguageModel({
  model: openai('gpt-4o-mini'),
  middleware: relaySession.middleware,
});

const result = await streamText({
  model,
  system: 'You coordinate support specialists and keep the user informed.',
  tools: relaySession.tools,
  messages: [{ role: 'user', content: 'Triage the latest onboarding issue.' }],
});
```

## What `onRelay()` Provides

`onRelay()` returns:

- `tools` for `generateText()` / `streamText()`
- `middleware` that injects live relay messages into the next model call
- `cleanup()` to unsubscribe and clear buffered injections

For string-style call sites, relay context is appended to `system`. For message-array call sites, the middleware also prepends a synthetic `system` message so chat-heavy flows get the same relay context.

## Workflow-Friendly Pattern

Use AI SDK in the consumer-facing app, and Relay workflows for the longer internal coordination path:

```typescript
import { streamText, wrapLanguageModel } from 'ai';
import { openai } from '@ai-sdk/openai';
import { Relay } from '@agent-relay/sdk/communicate';
import { onRelay } from '@agent-relay/sdk/communicate/adapters/ai-sdk';
import { runWorkflow } from '@agent-relay/sdk/workflows';

export async function POST(req: Request) {
  const { prompt, repo, escalate } = await req.json();

  const relay = new Relay('CustomerFacingLead');
  const relaySession = onRelay({ name: 'CustomerFacingLead' }, relay);

  const model = wrapLanguageModel({
    model: openai('gpt-4o-mini'),
    middleware: relaySession.middleware,
  });

  if (escalate) {
    const workflow = await runWorkflow('workflows/feature-dev.yaml', {
      vars: { repo, task: prompt },
    });

    return Response.json({ status: workflow.status, runId: workflow.runId });
  }

  const result = await streamText({
    model,
    tools: relaySession.tools,
    system: 'You are the point person for the user. Coordinate internally via Relay when needed.',
    messages: [{ role: 'user', content: prompt }],
  });

  return Response.json({ mode: 'chat', text: await result.text });
}
```

## Example App

See `examples/ai-sdk-relay-helpdesk/` for a compact Next.js example that pairs AI SDK chat with Relay workflow escalation.

## API

### `onRelay(options, relay?)`

- `options.name` — Relay agent name
- `options.instructions` — optional extra instructions
- `options.includeDefaultInstructions` — disable built-in relay guidance if needed
- `relay` — optional pre-configured `Relay`
