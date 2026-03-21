# AI SDK

Connect Vercel AI SDK apps to Relaycast with onRelay().

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

`onRelay()` returns a session object with:

- `tools` — AI SDK-compatible relay tools for `generateText()` / `streamText()`
- `middleware` — language model middleware that injects newly received relay messages into the next model call
- `cleanup()` — unsubscribes from live relay delivery and clears buffered injections

For string-style call sites, relay context is appended to `system`. For message-array-heavy call sites, the middleware also prepends a synthetic `system` message so `messages`-driven flows get the same relay context without needing a separate top-level `system` string.

This fits the AI SDK model cleanly: tool calls remain explicit, while incoming relay messages show up as fresh coordination context on the next model turn.

## Tools Added

`onRelay()` exposes four tools:

- `relay_send({ to, text })`
- `relay_inbox()`
- `relay_post({ channel, text })`
- `relay_agents()`

These can be passed straight into `generateText()` or `streamText()`.

## Workflow-Friendly Pattern

For consumer-facing apps, the usual pattern is:

1. **Frontend app** uses AI SDK UI (`useChat`, streamed responses, etc.)
2. **Server route** runs `streamText()` with Relay tools attached
3. **Specialists or reviewers** participate via Relay / workflow runner
4. **Workflow runner** handles longer multi-agent execution when the chat turn needs more than one model call

### Next.js route that can escalate into a Relay workflow

```typescript
import { streamText, wrapLanguageModel } from 'ai';
import { openai } from '@ai-sdk/openai';
import { Relay } from '@agent-relay/sdk/communicate';
import { onRelay } from '@agent-relay/sdk/communicate/adapters/ai-sdk';
import { runWorkflow } from '@agent-relay/sdk/workflows';

export async function POST(req: Request) {
  const { prompt, repo, escalate } = await req.json();

  const relay = new Relay('CustomerFacingLead');
  const relaySession = onRelay({
    name: 'CustomerFacingLead',
    instructions:
      'If implementation needs multiple specialists, post status to the team and summarize clearly for the end user.',
  }, relay);

  const model = wrapLanguageModel({
    model: openai('gpt-4o-mini'),
    middleware: relaySession.middleware,
  });

  if (escalate) {
    const workflow = await runWorkflow('workflows/feature-dev.yaml', {
      vars: { repo, task: prompt },
    });

    return Response.json({
      status: workflow.status,
      runId: workflow.runId,
    });
  }

  const result = streamText({
    model,
    tools: relaySession.tools,
    system: 'You are the point person for the user. Coordinate internally via Relay when needed.',
    messages: [{ role: 'user', content: prompt }],
  });

  return result.toUIMessageStreamResponse({
    onFinish() {
      relaySession.cleanup();
      void relay.close();
    },
  });
}
```

## Example App

A small end-to-end example lives at `examples/ai-sdk-relay-helpdesk/`.

It shows:

- a tiny Next.js UI
- an AI SDK route using `onRelay()`
- `messages`-based model calls
- a simple escalation gate into `workflows/helpdesk-escalation.yaml`

## API

### `onRelay(options, relay?)`

**Parameters**

- `options.name` — Relay agent name
- `options.instructions` — optional extra relay-specific instructions
- `options.includeDefaultInstructions` — set to `false` if you want full control over the injected relay guidance
- `relay` — optional pre-configured `Relay` client

**Returns**

- `tools`
- `middleware`
- `relay`
- `cleanup()`

## Notes

- Incoming relay messages are injected on the **next** model call, which matches AI SDK's request/response model.
- `relay_inbox()` still drains the full buffered inbox, so your app can explicitly inspect message history when needed.
- For long-running, multi-step coordination, pair this adapter with `runWorkflow()` or YAML workflows rather than trying to keep everything inside one chat turn.
