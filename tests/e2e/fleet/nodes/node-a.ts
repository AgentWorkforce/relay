import { z } from 'zod';
import { definePtyHarness } from '@agent-relay/harnesses';
import { action, defineNode, onMessage, spawn } from '@agent-relay/fleet';

/**
 * E2E fleet node A.
 *   - spawn:claude   distinct stub spawn (sleep — launchable in CI without a real CLI)
 *   - spawn:pool     SHARED stub spawn (both nodes) → exercises least-loaded scheduling
 *   - echo           distinct node action → cross-node dispatch + declarative trigger
 *   - work           SHARED slow node action (both nodes) → exercises reschedule-on-death
 */
const stub = definePtyHarness({ runtime: 'pty', command: 'sleep', args: ['86400'] });
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default defineNode({
  name: 'node-a',
  maxAgents: 8,
  capabilities: {
    'spawn:claude': spawn(stub),
    'spawn:pool': spawn(stub),
    echo: action(
      {
        input: z
          .object({
            text: z.string().optional(),
            message: z.object({ text: z.string() }).passthrough().optional(),
          })
          .passthrough(),
      },
      async (input, ctx) => {
        const text = (input.text ?? input.message?.text ?? '') as string;
        // Re-broadcast — flagged action_generated so the engine loop guard does
        // NOT re-fire the trigger even though the text contains the keyword.
        await ctx.relay.sendMessage({
          to: '#general',
          text: `echo:${text}`,
          data: { action_generated: true },
        });
        return { echoed: text, node: ctx.node.name };
      }
    ),
    work: action(
      { input: z.object({ nonce: z.string(), delayMs: z.number().optional() }) },
      async (input, ctx) => {
        await sleepMs(input.delayMs ?? 0);
        return { worked: input.nonce, node: ctx.node.name };
      }
    ),
  },
  triggers: [onMessage({ channel: '#general', match: /deploy/ }, 'echo')],
});
