import { z } from 'zod';
import { definePtyHarness } from '@agent-relay/harnesses';
import { action, defineNode, onMessage, spawn } from '@agent-relay/fleet';

/**
 * E2E fleet node A. Distinct capability set from node B:
 *   - spawn:claude  (stub PTY harness — `sleep`, so spawn is launchable in CI
 *     without a real AI CLI; the broker still mints the agent token and binds
 *     the agent via-node, which is what placement asserts)
 *   - echo          (a node-native action handler, dispatched over the control
 *     connection; used for cross-node messaging + the declarative trigger)
 *
 * The `onMessage` trigger fires `echo` for any #general message matching
 * /deploy/. The echo action re-broadcasts the text, so the loop guard
 * (action-generated messages must not re-trigger) is exercised end-to-end.
 */
const stubClaude = definePtyHarness({ runtime: 'pty', command: 'sleep', args: ['86400'] });

export default defineNode({
  name: 'node-a',
  maxAgents: 8,
  capabilities: {
    'spawn:claude': spawn(stubClaude),
    echo: action(
      // Accept both a direct `{ text }` invocation and the declarative-trigger
      // payload `{ trigger_id, message: { text, ... } }`.
      { input: z.object({ text: z.string().optional(), message: z.object({ text: z.string() }).passthrough().optional() }).passthrough() },
      async (input, ctx) => {
        const text = (input.text ?? input.message?.text ?? '') as string;
        // Re-broadcast — the text contains the trigger keyword on purpose, but
        // the message is flagged `action_generated` so the engine's loop guard
        // does NOT re-fire the trigger. (Convention: action handlers stamp their
        // own emissions; the sidecar does not auto-stamp yet.)
        await ctx.relay.sendMessage({ to: '#general', text: `echo:${text}`, data: { action_generated: true } });
        return { echoed: text, node: ctx.node.name };
      },
    ),
  },
  triggers: [onMessage({ channel: '#general', match: /deploy/ }, 'echo')],
});
