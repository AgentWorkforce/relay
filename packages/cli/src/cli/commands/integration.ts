import type { Command } from 'commander';
import { getProjectPaths } from '@agent-relay/config';
import type { AgentRelayAgent } from '@agent-relay/sdk';

import {
  addSdkOptions,
  printJson,
  runSdk,
  sdkOptionsFromOpts,
  withSdkDefaults,
  type SdkCommandDeps,
} from '../lib/sdk-command.js';
import { connectProjectBrokerClient } from '../lib/project-broker-client.js';
import type { SdkClientOptions } from '../lib/sdk-client.js';

export interface LocalRelayOptions {
  workspaceKey: string;
  baseUrl?: string;
}

export type IntegrationCommandDependencies = SdkCommandDeps & {
  resolveLocalRelayOptions: () => Promise<LocalRelayOptions | undefined>;
};

async function resolveLocalBrokerRelayOptions(): Promise<LocalRelayOptions | undefined> {
  let client:
    | {
        getSession: () => Promise<{ workspace_key?: string; relay_base_url?: string }>;
        disconnect?: () => void;
      }
    | undefined;
  try {
    client = connectProjectBrokerClient(getProjectPaths().projectRoot);
    const session = await client.getSession();
    const workspaceKey = session.workspace_key?.trim();
    if (!workspaceKey) {
      return undefined;
    }
    const baseUrl = session.relay_base_url?.trim();
    return {
      workspaceKey,
      ...(baseUrl ? { baseUrl } : {}),
    };
  } catch {
    return undefined;
  } finally {
    client?.disconnect?.();
  }
}

function withIntegrationDefaults(
  overrides: Partial<IntegrationCommandDependencies> = {}
): IntegrationCommandDependencies {
  return {
    ...withSdkDefaults(overrides),
    resolveLocalRelayOptions: resolveLocalBrokerRelayOptions,
    ...overrides,
  };
}

function explicitWorkspaceKey(opts: Record<string, unknown>): boolean {
  return typeof opts.workspaceKey === 'string' && opts.workspaceKey.trim() !== '';
}

function shouldRetryWithLocalWorkspaceKey(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /invalid (api|workspace) key/i.test(message) ||
    /no workspace key found/i.test(message) ||
    /unauthorized/i.test(message)
  );
}

function localRetryOptions(options: SdkClientOptions, local: LocalRelayOptions): SdkClientOptions {
  return {
    ...options,
    workspaceKey: local.workspaceKey,
    baseUrl: options.baseUrl ?? local.baseUrl,
  };
}

async function runIntegrationOperation<T>(
  deps: IntegrationCommandDependencies,
  commandOpts: Record<string, unknown>,
  operation: (relay: AgentRelayAgent) => Promise<T>
): Promise<T> {
  const options = sdkOptionsFromOpts(commandOpts);
  try {
    return await operation(deps.createAgentRelay(options));
  } catch (error) {
    if (explicitWorkspaceKey(commandOpts) || !shouldRetryWithLocalWorkspaceKey(error)) {
      throw error;
    }

    const local = await deps.resolveLocalRelayOptions();
    if (!local) {
      throw error;
    }

    return await operation(deps.createAgentRelay(localRetryOptions(options, local)));
  }
}

export function registerIntegrationCommands(
  program: Command,
  overrides: Partial<IntegrationCommandDependencies> = {}
): void {
  const deps = withIntegrationDefaults(overrides);
  const group = program.command('integration').description('Webhooks and event subscriptions');

  const webhook = group.command('webhook').description('Webhooks');

  addSdkOptions(
    webhook
      .command('create')
      .description('Register a webhook')
      .argument('<url>', 'Webhook URL')
      .option('--event <event>', 'Event to deliver')
  ).action(async (url: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(
        deps,
        await runIntegrationOperation(deps, o, (relay) =>
          relay.integrations.webhooks.create({
            url,
            event: o.event as string | undefined,
          })
        )
      );
    });
  });

  addSdkOptions(webhook.command('list').description('List registered webhooks')).action(
    async (o: Record<string, unknown>) => {
      await runSdk(deps, async () => {
        printJson(
          deps,
          await runIntegrationOperation(deps, o, (relay) => relay.integrations.webhooks.list())
        );
      });
    }
  );

  addSdkOptions(
    webhook.command('delete').description('Delete a webhook').argument('<id>', 'Webhook id')
  ).action(async (id: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      await runIntegrationOperation(deps, o, (relay) => relay.integrations.webhooks.delete(id));
      deps.log(`Deleted webhook ${id}.`);
    });
  });

  addSdkOptions(
    webhook
      .command('trigger')
      .description('Manually trigger a webhook')
      .argument('<id>', 'Webhook id')
      .option('--payload <json>', 'JSON payload', '{}')
  ).action(async (id: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const payload = JSON.parse((o.payload as string) ?? '{}') as Record<string, unknown>;
      printJson(
        deps,
        await runIntegrationOperation(deps, o, (relay) =>
          relay.integrations.webhooks.trigger(id, payload)
        )
      );
    });
  });

  // ── inbound webhooks (external services POST in → message into a channel) ──
  addSdkOptions(
    webhook
      .command('create-inbound')
      .description('Create an inbound webhook external services POST to, delivering messages into a channel')
      .argument('<channel>', 'Target channel the webhook posts into')
      .option('--name <name>', 'Human-readable webhook name (e.g. "GitHub Alerts")')
  ).action(async (channel: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(
        deps,
        await runIntegrationOperation(deps, o, (relay) =>
          relay.webhooks.createInbound({
            channel,
            name: o.name as string | undefined,
          })
        )
      );
    });
  });

  addSdkOptions(webhook.command('list-inbound').description('List inbound webhooks')).action(
    async (o: Record<string, unknown>) => {
      await runSdk(deps, async () => {
        printJson(deps, await runIntegrationOperation(deps, o, (relay) => relay.webhooks.list()));
      });
    }
  );

  addSdkOptions(
    webhook
      .command('delete-inbound')
      .description('Delete an inbound webhook')
      .argument('<webhookId>', 'Inbound webhook id')
  ).action(async (webhookId: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      await runIntegrationOperation(deps, o, (relay) => relay.webhooks.delete(webhookId));
      deps.log(`Deleted inbound webhook ${webhookId}.`);
    });
  });

  const subscription = group.command('subscription').description('Event subscriptions');

  addSdkOptions(
    subscription
      .command('create')
      .description('Create a subscription to events')
      .argument('<event>', 'Event name')
  ).action(async (event: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(
        deps,
        await runIntegrationOperation(deps, o, (relay) =>
          relay.integrations.subscriptions.create({ event })
        )
      );
    });
  });

  addSdkOptions(subscription.command('list').description('List created subscriptions')).action(
    async (o: Record<string, unknown>) => {
      await runSdk(deps, async () => {
        printJson(
          deps,
          await runIntegrationOperation(deps, o, (relay) => relay.integrations.subscriptions.list())
        );
      });
    }
  );

  addSdkOptions(
    subscription.command('get').description('Get subscription details').argument('<id>', 'Subscription id')
  ).action(async (id: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(
        deps,
        await runIntegrationOperation(deps, o, (relay) => relay.integrations.subscriptions.get(id))
      );
    });
  });

  addSdkOptions(
    subscription.command('delete').description('Delete a subscription').argument('<id>', 'Subscription id')
  ).action(async (id: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      await runIntegrationOperation(deps, o, (relay) => relay.integrations.subscriptions.delete(id));
      deps.log(`Deleted subscription ${id}.`);
    });
  });
}
