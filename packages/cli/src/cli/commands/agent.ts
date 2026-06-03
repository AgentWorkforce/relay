import type { Command } from 'commander';
import type { HarnessDriverClient } from '@agent-relay/harness-driver';

import {
  addSdkOptions,
  printJson,
  runSdk,
  sdkOptionsFromOpts,
  withSdkDefaults,
  type SdkCommandDeps,
} from '../lib/sdk-command.js';
import { createBrokerClient } from '../lib/attach-broker.js';
import {
  defaultStateDir,
  readConnectionFileFromDisk,
  resolveBrokerConnection,
  type BrokerConnectionOptions,
} from '../lib/broker-connection.js';

export type AgentMessageBrokerOptions = BrokerConnectionOptions;

export interface AgentCommandDependencies extends SdkCommandDeps {
  connectLocal: (cwd: string, options: AgentMessageBrokerOptions) => Promise<HarnessDriverClient>;
  cwd: () => string;
  readConnectionFile: (stateDir: string) => unknown;
  getDefaultStateDir: () => string;
  env: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
}

function withAgentDefaults(overrides: Partial<AgentCommandDependencies> = {}): AgentCommandDependencies {
  const deps = {
    ...withSdkDefaults(overrides),
    cwd: () => process.cwd(),
    readConnectionFile: readConnectionFileFromDisk,
    getDefaultStateDir: defaultStateDir,
    env: process.env,
    fetch: globalThis.fetch,
    ...overrides,
  } as AgentCommandDependencies;
  deps.connectLocal ??= async (_cwd: string, options: AgentMessageBrokerOptions) => {
    const connection = resolveBrokerConnection(options, {
      readConnectionFile: deps.readConnectionFile,
      getDefaultStateDir: deps.getDefaultStateDir,
      env: deps.env,
    });
    if (!connection) {
      throw new Error(
        'Error: could not locate broker connection. Pass --broker-url, set RELAY_BROKER_URL, ' +
          'or run from a directory containing .agentworkforce/relay/connection.json.'
      );
    }
    return createBrokerClient(connection, deps.fetch);
  };
  return deps;
}

async function runLocalBroker(
  deps: AgentCommandDependencies,
  options: AgentMessageBrokerOptions,
  fn: (client: HarnessDriverClient) => Promise<void>
): Promise<void> {
  try {
    await fn(await deps.connectLocal(deps.cwd(), options));
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    deps.exit(1);
  }
}

function addBrokerOptions(command: Command): Command {
  return command
    .option('--broker-url <url>', 'Broker base URL (overrides RELAY_BROKER_URL and connection.json)')
    .option('--api-key <key>', 'Broker API key (overrides RELAY_BROKER_API_KEY and connection.json)')
    .option('--state-dir <dir>', 'Directory containing connection.json (default: .agentworkforce/relay/)');
}

function brokerOptionsFromOpts(opts: Record<string, unknown>): AgentMessageBrokerOptions {
  return {
    brokerUrl: opts.brokerUrl as string | undefined,
    apiKey: opts.apiKey as string | undefined,
    stateDir: opts.stateDir as string | undefined,
  };
}

export function registerAgentCommands(
  program: Command,
  overrides: Partial<AgentCommandDependencies> = {}
): void {
  const deps = withAgentDefaults(overrides);
  const group = program.command('agent').description('Manage workspace agents and local delivery controls');

  addSdkOptions(
    group
      .command('register')
      .description('Register a new agent and print its token')
      .argument('<name>', 'Agent name')
      .option('--type <type>', 'Agent type (agent | human | system)')
      .option('--persona <persona>', 'Persona string')
  ).action(async (name: string, opts: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const relay = deps.createWorkspaceRelay(sdkOptionsFromOpts(opts));
      const registration = await relay.agents.register({
        name,
        type: opts.type as 'agent' | 'human' | 'system' | undefined,
        persona: opts.persona as string | undefined,
      });
      printJson(deps, registration);
    });
  });

  addSdkOptions(
    group.command('list').description('List agents').option('--status <status>', 'Filter by status')
  ).action(async (opts: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const relay = deps.createWorkspaceRelay(sdkOptionsFromOpts(opts));
      printJson(deps, await relay.agents.list({ status: opts.status as never }));
    });
  });

  addSdkOptions(
    group
      .command('add')
      .description('Add an agent to the workspace')
      .argument('<name>', 'Agent name')
      .option('--type <type>', 'Agent type (agent | human | system)')
  ).action(async (name: string, opts: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const relay = deps.createWorkspaceRelay(sdkOptionsFromOpts(opts));
      printJson(
        deps,
        await relay.agents.register({ name, type: opts.type as 'agent' | 'human' | 'system' | undefined })
      );
    });
  });

  addSdkOptions(
    group.command('remove').description('Remove an agent').argument('<name>', 'Agent name')
  ).action(async (name: string, opts: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const relay = deps.createWorkspaceRelay(sdkOptionsFromOpts(opts));
      await relay.agents.delete(name);
      deps.log(`Removed agent ${name}.`);
    });
  });

  const message = group.command('message').description('Control local broker message delivery for an agent');

  addBrokerOptions(
    message
      .command('flush')
      .description('Flush queued relay messages into a held local agent')
      .argument('<name>', 'Agent name')
  ).action(async (name: string, opts: Record<string, unknown>) => {
    await runLocalBroker(deps, brokerOptionsFromOpts(opts), async (client) => {
      printJson(deps, { name, ...(await client.flushPending(name)) });
    });
  });

  addBrokerOptions(
    message
      .command('hold')
      .description('Hold new relay messages for a local agent until flushed')
      .argument('<name>', 'Agent name')
  ).action(async (name: string, opts: Record<string, unknown>) => {
    await runLocalBroker(deps, brokerOptionsFromOpts(opts), async (client) => {
      printJson(deps, { name, ...(await client.setInboundDeliveryMode(name, 'manual_flush')) });
    });
  });

  addBrokerOptions(
    message
      .command('auto')
      .description('Resume automatic relay message injection for a local agent')
      .argument('<name>', 'Agent name')
  ).action(async (name: string, opts: Record<string, unknown>) => {
    await runLocalBroker(deps, brokerOptionsFromOpts(opts), async (client) => {
      printJson(deps, { name, ...(await client.setInboundDeliveryMode(name, 'auto_inject')) });
    });
  });
}
