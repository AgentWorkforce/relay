import { openai } from '@ai-sdk/openai';
import { streamText, wrapLanguageModel } from 'ai';
import { Relay } from '@agent-relay/sdk/communicate';
import { onRelay } from '@agent-relay/sdk/communicate/adapters/ai-sdk';
import { runWorkflow } from '@agent-relay/sdk/workflows';

const ESCALATE_PREFIX = 'please escalate:';

export async function POST(request: Request) {
  const { prompt } = (await request.json()) as { prompt?: string };
  const text = prompt?.trim() ?? '';

  if (text.length === 0) {
    return Response.json({ error: 'prompt is required' }, { status: 400 });
  }

  const relay = new Relay('HelpdeskLead');
  const relaySession = onRelay(
    {
      name: 'HelpdeskLead',
      instructions:
        'You are the customer-facing lead. Answer directly when you can. When work needs specialists, use Relay tools, keep the user updated, and escalate to a workflow when the task is clearly multi-step.',
    },
    relay,
  );

  const model = wrapLanguageModel({
    model: openai('gpt-4o-mini'),
    middleware: relaySession.middleware,
  });

  try {
    if (text.toLowerCase().startsWith(ESCALATE_PREFIX)) {
      const workflow = await runWorkflow('workflows/helpdesk-escalation.yaml', {
        vars: {
          request: text.slice(ESCALATE_PREFIX.length).trim(),
        },
      });

      return Response.json({ mode: 'workflow', status: workflow.status, runId: workflow.runId });
    }

    const result = await streamText({
      model,
      tools: relaySession.tools,
      system:
        'You are the point person for the user. Coordinate through Relay when needed, but keep the final answer concise and user-facing.',
      messages: [{ role: 'user', content: text }],
    });

    return Response.json({ mode: 'chat', text: await result.text });
  } finally {
    relaySession.cleanup();
    await relay.close();
  }
}
