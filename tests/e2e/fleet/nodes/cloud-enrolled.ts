import { z } from 'zod';
import { action, defineNode } from '@agent-relay/fleet';

/** Minimal definition for the Cloud enrollment -> node-up regression. */
export default defineNode({
  name: 'cloud-enrolled',
  tags: ['cloud-enrolled', 'e2e'],
  capabilities: {
    'cloud:ping': action({ input: z.object({ nonce: z.string() }) }, async (input) => ({
      pong: input.nonce,
    })),
  },
});
