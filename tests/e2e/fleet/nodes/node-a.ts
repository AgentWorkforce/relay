import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { definePtyHarness } from '@agent-relay/harnesses';
import { action, defineNode, spawn } from '@agent-relay/fleet';

/**
 * E2E fleet node A.
 *   - spawn:claude   distinct stub spawn → launchable in CI without a real CLI
 *   - spawn:pool     SHARED stub spawn (both nodes) → exercises least-loaded scheduling
 *   - echo           distinct node action → cross-node dispatch + declarative trigger
 *   - work           SHARED slow node action (both nodes) → exercises reschedule-on-death
 *
 * The stub spawn harness runs `stub-agent.cjs` — a launchable PTY child that
 * drains stdin and idles, so spawn completes without a real AI CLI.
 */
const stubPath = fileURLToPath(new URL('./stub-agent.cjs', import.meta.url));
const stub = definePtyHarness({ runtime: 'pty', command: process.execPath, args: [stubPath] });
const delayedReadyStub = definePtyHarness({
  runtime: 'pty',
  command: process.execPath,
  args: [stubPath],
  // Longer than the broker's historical 25s false-readiness fallback. The
  // stub discards startup input, so only a delivery after its real prompt can
  // produce the nonce observation asserted by the fleet E2E.
  env: {
    RELAY_E2E_STUB_READY_DELAY_MS: '27000',
    RELAY_E2E_NODE_NAME: 'node-a',
    // Keep the assertion focused on readiness ordering rather than the generic
    // harness's character pacing; real Codex tasks already use bulk injection.
    RELAY_INJECT_RATE_MS: '0',
  },
});
const releaseProbeStub = definePtyHarness({
  runtime: 'pty',
  command: process.execPath,
  args: [stubPath],
  env: {
    RELAY_E2E_NODE_NAME: 'node-a',
    RELAY_E2E_SPAWN_DESCENDANT: '1',
    RELAY_INJECT_RATE_MS: '0',
  },
});
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default defineNode({
  name: 'node-a',
  maxAgents: 8,
  capabilities: {
    'spawn:claude': spawn(delayedReadyStub),
    'spawn:pool': spawn(stub),
    'spawn:release-probe': spawn(releaseProbeStub),
    echo: action(
      {
        input: z.looseObject({
          text: z.string().optional(),
          message: z.looseObject({ text: z.string() }).optional(),
        }),
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
  // No node-file `triggers: [...]` fixture — the sidecar's trigger auto-sync is
  // not yet wired, so a declared trigger here would be dead. The declarative
  // trigger scenario registers `#general /deploy/ -> echo` via the engine API,
  // which exercises the identical firing + loop-guard path.
});
