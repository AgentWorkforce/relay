import { z } from 'zod';
import { claude, codex, gemini } from '@agent-relay/harnesses';
import { action, defineNode, onMessage, spawn } from '@agent-relay/fleet';

export default defineNode({
  name: 'local-builder',
  maxAgents: 8,
  capabilities: {
    'spawn:claude': spawn(claude),
    'spawn:codex': spawn(codex),
    'spawn:gemini': spawn(gemini),
    echo: action({ input: z.object({ text: z.string() }) }, async (input, ctx) => {
      await ctx.relay.sendMessage({
        to: 'general',
        text: input.text,
      });
      return { echoed: input.text };
    }),
  },
  triggers: [onMessage({ channel: '#general', match: /echo:/ }, 'echo')],
});
