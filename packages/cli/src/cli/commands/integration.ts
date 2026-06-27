import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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

export interface RelayfileBinding {
  provider: string;
  resource: string;
  channel: string;
  webhookId: string;
  subscriptionId: string;
}

export interface RelayfileBridge {
  isConnected(provider: string): Promise<boolean>;
  connect(provider: string): Promise<void>;
  bind(input: {
    provider: string;
    resource: string;
    channel: string;
    webhookId: string;
    webhookToken: string;
    subscriptionId: string;
  }): Promise<void>;
  listBindings(): Promise<RelayfileBinding[]>;
  unbind(provider: string, resource: string): Promise<void>;
}

export type IntegrationCommandDependencies = SdkCommandDeps & {
  resolveLocalRelayOptions: () => Promise<LocalRelayOptions | undefined>;
  relayfile: RelayfileBridge;
  isInteractive: () => boolean;
  prompt: (question: string) => Promise<string>;
};

function runRelayfile(args: string[], options: { inherit?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('relayfile', args, {
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `relayfile ${args.join(' ')} exited with code ${code ?? 'unknown'}`));
    });
  });
}

function readProviderConnected(payload: unknown, provider: string): boolean {
  const normalizedProvider = provider.trim().toLowerCase();
  const values = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? Object.values(payload as Record<string, unknown>)
      : [];
  return values.some((entry) => {
    if (!entry || typeof entry !== 'object') {
      return false;
    }
    const record = entry as Record<string, unknown>;
    const name = String(record.provider ?? record.name ?? record.id ?? '')
      .trim()
      .toLowerCase();
    const state = String(record.state ?? record.status ?? '')
      .trim()
      .toLowerCase();
    return name === normalizedProvider && ['connected', 'ready', 'active', 'ok'].includes(state);
  });
}

function defaultRelayfileBridge(): RelayfileBridge {
  return {
    async isConnected(provider) {
      const output = await runRelayfile(['integration', 'list', '--json']);
      return readProviderConnected(JSON.parse(output), provider);
    },
    async connect(provider) {
      await runRelayfile(['integration', 'connect', provider], { inherit: true });
    },
    async bind(input) {
      await runRelayfile([
        'integration',
        'bind',
        input.provider,
        input.resource,
        '--channel',
        input.channel,
        '--webhook',
        input.webhookId,
        '--webhook-token',
        input.webhookToken,
        '--subscription',
        input.subscriptionId,
      ]);
    },
    async listBindings() {
      const output = await runRelayfile(['integration', 'bind', '--list', '--json']);
      const parsed = JSON.parse(output) as unknown;
      return Array.isArray(parsed) ? (parsed as RelayfileBinding[]) : [];
    },
    async unbind(provider, resource) {
      await runRelayfile(['integration', 'unbind', provider, resource]);
    },
  };
}

async function promptLine(question: string): Promise<string> {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function resolveLocalBrokerRelayOptions(): Promise<LocalRelayOptions | undefined> {
  let client:
    | {
        getSession: () => Promise<{ workspace_key?: string; relay_base_url?: string }>;
        disconnect?: () => void;
      }
    | undefined;
  try {
    const brokerClient = connectProjectBrokerClient(getProjectPaths().projectRoot);
    client = brokerClient;
    const session = await brokerClient.getSession();
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
    relayfile: defaultRelayfileBridge(),
    isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompt: promptLine,
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

function parseFilter(raw: string): Record<string, string> {
  const [key, ...rest] = raw.split('=');
  const trimmedKey = key?.trim();
  if (!trimmedKey || rest.length === 0) {
    throw new Error('Invalid --filter value. Expected key=value, for example channel=#ops.');
  }
  return { [trimmedKey]: rest.join('=').trim() };
}

function commaList(raw: unknown): string[] {
  return String(raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function defaultBridgeUrl(commandOpts: Record<string, unknown>, local?: LocalRelayOptions): string {
  const explicit = typeof commandOpts.bridgeUrl === 'string' ? commandOpts.bridgeUrl.trim() : '';
  if (explicit) {
    return explicit;
  }
  const baseUrl =
    (typeof commandOpts.baseUrl === 'string' ? commandOpts.baseUrl.trim() : '') ||
    local?.baseUrl ||
    process.env.RELAY_BASE_URL?.trim() ||
    'https://agentrelay.com';
  return `${baseUrl.replace(/\/+$/, '')}/integrations/relayfile/writeback`;
}

function bridgeSecret(commandOpts: Record<string, unknown>): string {
  const explicit = typeof commandOpts.bridgeSecret === 'string' ? commandOpts.bridgeSecret.trim() : '';
  return explicit || randomBytes(24).toString('hex');
}

function targetChannel(target: string): string {
  const trimmed = target.trim();
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
}

function agentName(target: string): string | undefined {
  const trimmed = target.trim();
  return trimmed.startsWith('@') ? trimmed.slice(1).trim() : undefined;
}

async function ensureProviderConnected(
  deps: IntegrationCommandDependencies,
  provider: string,
  opts: Record<string, unknown>
): Promise<void> {
  if (await deps.relayfile.isConnected(provider)) {
    return;
  }

  if (opts.input === false || !deps.isInteractive()) {
    throw new Error(
      `${provider} isn't connected to this workspace yet.\nRun: relayfile integration connect ${provider} --workspace <ws>, then re-run.`
    );
  }

  deps.log(`${provider} isn't connected to this workspace yet.`);
  deps.log(`Opening browser to connect ${provider}...`);
  await deps.relayfile.connect(provider);
  if (!(await deps.relayfile.isConnected(provider))) {
    throw new Error(
      `${provider} is still not connected. Run: relayfile integration connect ${provider} --workspace <ws>, then re-run.`
    );
  }
}

async function ensureRecipient(
  relay: AgentRelayAgent,
  provider: string,
  target: string,
  opts: Record<string, unknown>
): Promise<void> {
  const name = agentName(target);
  if (!name) {
    return;
  }
  const agents = await relay.agents.list();
  if (agents.some((agent: { name: string }) => agent.name === name)) {
    return;
  }

  const spawnCli = typeof opts.spawn === 'string' ? opts.spawn.trim() : '';
  if (!spawnCli) {
    throw new Error(
      `Recipient agent ${target} does not exist. Run: agent-relay integration subscribe ${provider} --to ${target} --spawn <cli>`
    );
  }

  await relay.agents.register({
    name,
    type: 'agent',
    metadata: { requestedCli: spawnCli, source: 'integration.subscribe' },
  });
}

async function promptSubscribeOptions(
  deps: IntegrationCommandDependencies,
  provider: string | undefined,
  opts: Record<string, unknown>
): Promise<{ provider: string; resource: string; to: string }> {
  if (provider && typeof opts.resource === 'string' && typeof opts.to === 'string') {
    return { provider, resource: opts.resource, to: opts.to };
  }
  if (opts.input === false || !deps.isInteractive()) {
    throw new Error(
      'Non-interactive subscribe requires <provider>, --resource <value>, and --to <agent|#channel>.'
    );
  }
  const resolvedProvider = provider ?? (await deps.prompt('Integration provider: '));
  const resource =
    typeof opts.resource === 'string' && opts.resource.trim()
      ? opts.resource
      : await deps.prompt('Provider resource: ');
  const to = typeof opts.to === 'string' && opts.to.trim() ? opts.to : await deps.prompt('Relay recipient: ');
  return { provider: resolvedProvider, resource, to };
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

async function runSubscribe(
  deps: IntegrationCommandDependencies,
  providerArg: string | undefined,
  opts: Record<string, unknown>
): Promise<void> {
  if (opts.list) {
    const local = await deps.resolveLocalRelayOptions();
    const relayOptions = sdkOptionsFromOpts(opts);
    const relay = deps.createAgentRelay(
      local && !explicitWorkspaceKey(opts) ? localRetryOptions(relayOptions, local) : relayOptions
    );
    const [bindings, webhooks, subscriptions] = await Promise.all([
      deps.relayfile.listBindings(),
      relay.webhooks.list(),
      relay.webhooks.subscriptions(),
    ]);
    printJson(deps, { bindings, webhooks, subscriptions });
    return;
  }

  const { provider, resource, to } = await promptSubscribeOptions(deps, providerArg, opts);
  const local = await deps.resolveLocalRelayOptions();
  await ensureProviderConnected(deps, provider, opts);

  const relayOptions = sdkOptionsFromOpts(opts);
  const relay = deps.createAgentRelay(
    local && !explicitWorkspaceKey(opts) ? localRetryOptions(relayOptions, local) : relayOptions
  );
  await ensureRecipient(relay, provider, to, opts);
  const channel = targetChannel(to);
  const webhook = await relay.webhooks.createInbound({ channel, name: `relayfile:${provider}` });
  const events = commaList(opts.events);
  const subscription = await relay.integrations.subscriptions.create({
    event: events.length === 1 ? events[0]! : 'message.created',
    events: events.length ? events : ['message.created', 'thread.reply'],
    filter: { channel },
    url: defaultBridgeUrl(opts, local),
    secret: bridgeSecret(opts),
  });
  await deps.relayfile.bind({
    provider,
    resource,
    channel,
    webhookId: webhook.webhookId,
    webhookToken: webhook.token,
    subscriptionId: subscription.id,
  });
  deps.log(`✓ ${provider} ${resource} bound -> ${to}`);
  deps.log('✓ Listening. Replies will post back in-thread.');
}

async function runUnsubscribe(
  deps: IntegrationCommandDependencies,
  provider: string,
  opts: Record<string, unknown>
): Promise<void> {
  const resource = typeof opts.resource === 'string' ? opts.resource.trim() : '';
  if (!resource) {
    throw new Error('Missing --resource <value> for unsubscribe.');
  }
  const bindings = await deps.relayfile.listBindings();
  const binding = bindings.find((item) => item.provider === provider && item.resource === resource);
  if (!binding) {
    throw new Error(`No binding found for ${provider} ${resource}.`);
  }
  const local = await deps.resolveLocalRelayOptions();
  const relayOptions = sdkOptionsFromOpts(opts);
  const relay = deps.createAgentRelay(
    local && !explicitWorkspaceKey(opts) ? localRetryOptions(relayOptions, local) : relayOptions
  );
  await relay.webhooks.delete(binding.webhookId);
  await relay.webhooks.unsubscribe(binding.subscriptionId);
  await deps.relayfile.unbind(provider, resource);
  deps.log(`Unsubscribed ${provider} ${resource}.`);
}

export function registerIntegrationCommands(
  program: Command,
  overrides: Partial<IntegrationCommandDependencies> = {}
): void {
  const deps = withIntegrationDefaults(overrides);
  const group = program.command('integration').description('Webhooks and event subscriptions');

  addSdkOptions(
    group
      .command('subscribe [provider]')
      .description('Subscribe a relay recipient to a relayfile integration')
      .option('--resource <value>', 'Provider-native resource (channel, project, label, etc.)')
      .option('--to <target>', 'Relay recipient, e.g. @agent or #channel')
      .option('--spawn <cli>', 'Register the recipient agent when it is absent')
      .option('--events <list>', 'Comma-separated relay event names', 'message.created,thread.reply')
      .option('--bridge-url <url>', 'Writeback bridge URL')
      .option('--bridge-secret <secret>', 'HMAC signing secret for the writeback bridge')
      .option('--list', 'List active relayfile integration bindings')
      .option('--no-input', 'Do not prompt or launch browser-based connect flows')
  ).action(async (provider: string | undefined, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      await runSubscribe(deps, provider, o);
    });
  });

  addSdkOptions(
    group
      .command('unsubscribe')
      .description('Remove a relayfile integration subscription')
      .argument('<provider>', 'Integration provider')
      .option('--resource <value>', 'Provider-native resource used when subscribing')
  ).action(async (provider: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      await runUnsubscribe(deps, provider, o);
    });
  });

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
        await runIntegrationOperation(deps, o, (relay) => relay.integrations.webhooks.trigger(id, payload))
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
      .option('--filter <filter>', 'Filter expression, e.g. channel=#ops')
      .option('--url <url>', 'Delivery URL for subscription')
      .option('--secret <secret>', 'HMAC signing secret')
  ).action(async (event: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const filter = typeof o.filter === 'string' ? parseFilter(o.filter) : undefined;
      printJson(
        deps,
        await runIntegrationOperation(deps, o, (relay) =>
          relay.integrations.subscriptions.create({
            event,
            ...(filter ? { filter } : {}),
            ...(typeof o.url === 'string' ? { url: o.url } : {}),
            ...(typeof o.secret === 'string' ? { secret: o.secret } : {}),
          })
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
