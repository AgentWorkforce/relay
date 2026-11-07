import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerIntegrationCommands, type IntegrationCommandDependencies } from './integration.js';

/**
 * `relay integration webhook create` posts to `POST /v1/webhooks`, whose request
 * schema is `{ channel, name? }` — the URL is part of the *response*.
 *
 * The command previously took a `<url>` argument and sent `{ url, event }`, so
 * every invocation was rejected with "channel is required" and the required
 * channel was never sent at all. A live verification run caught it. These tests
 * pin the corrected contract so the argument order cannot silently regress.
 */
function makeProgram() {
  const relay = {
    integrations: {
      webhooks: {
        create: vi.fn(async (input: unknown) => ({ webhookId: 'wh_1', ...(input as object) })),
      },
    },
  };
  const log = vi.fn();
  const error = vi.fn();
  const exit = vi.fn();
  const program = new Command();
  program.exitOverride();
  registerIntegrationCommands(program, {
    createAgentRelay: () => relay as never,
    resolveLocalRelayOptions: async () => ({ workspaceKey: 'rk_live_test' }),
    isInteractive: () => false,
    log,
    error,
    exit: exit as never,
  } satisfies Partial<IntegrationCommandDependencies> as IntegrationCommandDependencies);
  return { program, relay, log, error, exit };
}

describe('integration webhook create', () => {
  it('sends the channel the API requires', async () => {
    const { program, relay } = makeProgram();

    await program.parseAsync(['integration', 'webhook', 'create', 'deploy-status'], {
      from: 'user',
    });

    expect(relay.integrations.webhooks.create).toHaveBeenCalledWith({
      channel: 'deploy-status',
      name: undefined,
    });
  });

  it('passes an optional name through', async () => {
    const { program, relay } = makeProgram();

    await program.parseAsync(
      ['integration', 'webhook', 'create', 'deploy-status', '--name', 'GitHub Alerts'],
      { from: 'user' }
    );

    expect(relay.integrations.webhooks.create).toHaveBeenCalledWith({
      channel: 'deploy-status',
      name: 'GitHub Alerts',
    });
  });

  it('never sends url or event, which the endpoint rejects', async () => {
    const { program, relay } = makeProgram();

    await program.parseAsync(['integration', 'webhook', 'create', 'ops'], { from: 'user' });

    const payload = relay.integrations.webhooks.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty('url');
    expect(payload).not.toHaveProperty('event');
  });
});
