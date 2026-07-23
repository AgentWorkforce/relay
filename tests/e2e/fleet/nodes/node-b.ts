import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { definePtyHarness } from '@agent-relay/harnesses';
import { action, defineNode, spawn } from '@agent-relay/fleet';

/**
 * E2E fleet node B.
 *   - spawn:codex   distinct stub spawn
 *   - spawn:pool    SHARED stub spawn (both nodes) → least-loaded scheduling
 *   - ping          distinct node action → cross-node dispatch
 *   - work          SHARED slow node action (both nodes) → reschedule-on-death
 *
 * No `echo` and no `spawn:claude`, so capability-filtered queries and
 * capability-targeted placement have an unambiguous answer. The stub spawn
 * harness (`stub-agent.cjs`) is a launchable PTY child that idles.
 */
const stubPath = fileURLToPath(new URL('./stub-agent.cjs', import.meta.url));
const stub = definePtyHarness({ runtime: 'pty', command: process.execPath, args: [stubPath] });
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default defineNode({
  name: 'node-b',
  maxAgents: 8,
  capabilities: {
    'spawn:codex': spawn(stub),
    'spawn:pool': spawn(stub),
    ping: action({ input: z.object({ nonce: z.string() }) }, async (input, ctx) => ({
      pong: input.nonce,
      node: ctx.node.name,
    })),
    work: action(
      { input: z.object({ nonce: z.string(), delayMs: z.number().optional() }) },
      async (input, ctx) => {
        await sleepMs(input.delayMs ?? 0);
        return { worked: input.nonce, node: ctx.node.name };
      }
    ),
  },
});
