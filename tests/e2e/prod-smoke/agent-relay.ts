import { z } from 'zod';
import { action, defineNode } from '@agent-relay/fleet';

/**
 * Node definition served by the production smoke's `node up`.
 *
 * A single `hello-prod` action so the smoke stays minimal — no `spawn:*` shadow
 * (the broker provider advertises native spawn capacity on its own). The action:
 *   - echoes its `echo` input verbatim (the byte-exact round-trip assertion), and
 *   - when given `notify`, posts a channel message through `ctx.relay.sendMessage`
 *     (the node-token message route), attributed to the `from` agent.
 */
export default defineNode({
  name: 'prod-smoke-node',
  capabilities: {
    'hello-prod': action(
      {
        input: z.looseObject({
          echo: z.unknown().optional(),
          notify: z.object({ channel: z.string(), from: z.string() }).optional(),
        }),
      },
      async (input, ctx) => {
        if (input.notify) {
          await ctx.relay.sendMessage({
            from: input.notify.from,
            to: `#${input.notify.channel}`,
            text: `hello-prod ran on node "${ctx.node.name}" (invocation ${ctx.invocationId ?? 'n/a'}); echo=${JSON.stringify(input.echo ?? null)}`,
          });
        }
        return { ok: true, echo: input.echo ?? null };
      }
    ),
  },
});
