import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { definePtyHarness } from '@agent-relay/harnesses';
import { action, defineNode, spawn } from '@agent-relay/fleet';

/**
 * E2E node for the worker-environment regression. Its only spawn harness runs
 * `env-probe.cjs`, which records which relay credential variable names the
 * spawned worker can see. `envprobe:ready` is a sidecar-only action: once it
 * is in the roster, the sidecar (and therefore this probe harness) owns
 * `spawn:claude` rather than the broker's native provider.
 */
const probe = definePtyHarness({
  runtime: 'pty',
  command: process.execPath,
  args: [fileURLToPath(new URL('./env-probe.cjs', import.meta.url))],
  env: { RELAY_E2E_NODE_NAME: 'env-probe', RELAY_INJECT_RATE_MS: '0' },
});

export default defineNode({
  name: 'env-probe',
  maxAgents: 2,
  capabilities: {
    'spawn:claude': spawn(probe),
    'envprobe:ready': action({ input: z.object({}) }, async () => ({ ok: true })),
  },
});
