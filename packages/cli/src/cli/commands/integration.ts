import type { Command } from 'commander';

import {
  addSdkOptions,
  printJson,
  runSdk,
  sdkOptionsFromOpts,
  withSdkDefaults,
  type SdkCommandDeps,
} from '../lib/sdk-command.js';

export type IntegrationCommandDependencies = SdkCommandDeps;

export function registerIntegrationCommands(
  program: Command,
  overrides: Partial<IntegrationCommandDependencies> = {}
): void {
  const deps = withSdkDefaults(overrides);
  const opts = (o: Record<string, unknown>) => sdkOptionsFromOpts(o);
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
        await deps.createAgentRelay(opts(o)).integrations.webhooks.create({
          url,
          event: o.event as string | undefined,
        })
      );
    });
  });

  addSdkOptions(webhook.command('list').description('List registered webhooks')).action(
    async (o: Record<string, unknown>) => {
      await runSdk(deps, async () => {
        printJson(deps, await deps.createAgentRelay(opts(o)).integrations.webhooks.list());
      });
    }
  );

  addSdkOptions(
    webhook.command('delete').description('Delete a webhook').argument('<id>', 'Webhook id')
  ).action(async (id: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      await deps.createAgentRelay(opts(o)).integrations.webhooks.delete(id);
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
      printJson(deps, await deps.createAgentRelay(opts(o)).integrations.webhooks.trigger(id, payload));
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
        await deps.createAgentRelay(opts(o)).webhooks.createInbound({
          channel,
          name: o.name as string | undefined,
        })
      );
    });
  });

  addSdkOptions(webhook.command('list-inbound').description('List inbound webhooks')).action(
    async (o: Record<string, unknown>) => {
      await runSdk(deps, async () => {
        printJson(deps, await deps.createAgentRelay(opts(o)).webhooks.list());
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
      await deps.createAgentRelay(opts(o)).webhooks.delete(webhookId);
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
      printJson(deps, await deps.createAgentRelay(opts(o)).integrations.subscriptions.create({ event }));
    });
  });

  addSdkOptions(subscription.command('list').description('List created subscriptions')).action(
    async (o: Record<string, unknown>) => {
      await runSdk(deps, async () => {
        printJson(deps, await deps.createAgentRelay(opts(o)).integrations.subscriptions.list());
      });
    }
  );

  addSdkOptions(
    subscription.command('get').description('Get subscription details').argument('<id>', 'Subscription id')
  ).action(async (id: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(deps, await deps.createAgentRelay(opts(o)).integrations.subscriptions.get(id));
    });
  });

  addSdkOptions(
    subscription.command('delete').description('Delete a subscription').argument('<id>', 'Subscription id')
  ).action(async (id: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      await deps.createAgentRelay(opts(o)).integrations.subscriptions.delete(id);
      deps.log(`Deleted subscription ${id}.`);
    });
  });
}
