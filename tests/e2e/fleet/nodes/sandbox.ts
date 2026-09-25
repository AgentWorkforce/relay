import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { definePtyHarness } from '@agent-relay/harnesses';
import { action, defineNode, spawn } from '@agent-relay/fleet';

/**
 * A node shaped like a Cloud fleet sandbox: `relay fleet spawn --sandbox`
 * names it `fleet-sandbox-<uuid>` (the uuid of its `sbx_<uuid>` id).
 * Keep in sync with SANDBOX_NODE_NAME in address-e2e.test.ts.
 */
const SANDBOX_NODE_NAME = 'fleet-sandbox-0b7c2f4e-5d1a-4c3b-9e8f-7a6b5c4d3e2f';

const stub = definePtyHarness({
  runtime: 'pty',
  command: process.execPath,
  args: [fileURLToPath(new URL('./stub-agent.cjs', import.meta.url))],
  env: { RELAY_E2E_NODE_NAME: SANDBOX_NODE_NAME, RELAY_INJECT_RATE_MS: '0' },
});

export default defineNode({
  name: SANDBOX_NODE_NAME,
  maxAgents: 1,
  capabilities: {
    'spawn:claude': spawn(stub),
    // Served only by this node's sidecar provider. The broker's native provider
    // also advertises spawn:claude, so the roster showing this action is the
    // signal that the stub shadow is registered and will win the spawn.
    'sandbox:ping': action({ input: z.object({}) }, async () => ({ pong: true })),
  },
});
