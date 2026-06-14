import { z } from 'zod';
import { definePtyHarness } from '@agent-relay/harnesses';
import { action, defineNode, spawn } from '@agent-relay/fleet';

/**
 * E2E fleet node B. Distinct capability set from node A:
 *   - spawn:codex  (stub PTY harness — see node-a for why `sleep`)
 *   - ping         (a node-native action handler used to prove cross-node
 *     dispatch lands on THIS node's control connection)
 *
 * Deliberately has NO `echo` and NO `spawn:claude`, so capability-filtered
 * roster queries and capability-targeted placement have an unambiguous answer.
 */
const stubCodex = definePtyHarness({ runtime: 'pty', command: 'sleep', args: ['86400'] });

export default defineNode({
  name: 'node-b',
  maxAgents: 8,
  capabilities: {
    'spawn:codex': spawn(stubCodex),
    ping: action({ input: z.object({ nonce: z.string() }) }, async (input, ctx) => {
      return { pong: input.nonce, node: ctx.node.name };
    }),
  },
});
