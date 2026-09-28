import type { Command } from 'commander';

import type { AgentRelayAgent } from '@agent-relay/sdk';

import { detectOrchestratorHarness } from '../telemetry/orchestrator-harness.js';
import {
  addSdkOptions,
  runSdk,
  sdkOptionsFromOpts,
  withSdkDefaults,
  type SdkCommandDeps,
} from '../lib/sdk-command.js';
import { resolveAgentToken, resolveBaseUrl } from '../lib/sdk-client.js';
import {
  asDeliveryRelay,
  normalizeAgentName,
  resolveOnRelayTarget,
  runOnRelayListener,
  validateOnRelayBaseUrl,
  type OnRelayIdentity,
  type OnRelayTarget,
} from '../lib/on-relay.js';

export interface OnRelayCommandDependencies extends SdkCommandDeps {
  env: NodeJS.ProcessEnv;
  version: string;
  detectHarness: () => string;
  listen: typeof runOnRelayListener;
}

function withDefaults(overrides: Partial<OnRelayCommandDependencies> = {}): OnRelayCommandDependencies {
  return {
    ...withSdkDefaults(overrides),
    env: process.env,
    version: process.env.AGENT_RELAY_CLI_VERSION ?? 'unknown',
    detectHarness: () => detectOrchestratorHarness(),
    listen: runOnRelayListener,
    ...overrides,
  };
}

function option(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function envValue(env: NodeJS.ProcessEnv, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

async function prepareIdentity(
  name: string,
  target: OnRelayTarget,
  options: Record<string, unknown>,
  deps: OnRelayCommandDependencies
): Promise<{ identity: OnRelayIdentity; baseUrl: string }> {
  const sdkOptions = sdkOptionsFromOpts(options);
  sdkOptions.env = deps.env;
  const token = resolveAgentToken(sdkOptions);
  if (token && option(options, 'workspaceKey')) {
    throw new Error('Pass either --workspace-key or --token, not both.');
  }
  const baseUrl = validateOnRelayBaseUrl(
    resolveBaseUrl({ ...sdkOptions, ignorePersistedRelaycastTarget: Boolean(token) })
  );

  if (token) {
    const relay = deps.createAgentRelay(sdkOptions);
    const me = await relay.agents.me();
    if (normalizeAgentName(me.name) !== name) {
      throw new Error(`The supplied agent token belongs to @${me.name}, not @${name}.`);
    }
    return {
      baseUrl,
      identity: { id: me.id, name, token, relay: asDeliveryRelay(relay) },
    };
  }

  const workspaceRelay = deps.createWorkspaceRelay(sdkOptions);
  const registered = await workspaceRelay.workspace.register(
    {
      name,
      type: 'agent',
      metadata: {
        harness: target.harness,
        session_id: target.sessionId,
        runtime: 'headless',
        surface: 'agent-relay-on-relay',
      },
    },
    { strict: false }
  );
  if (Array.isArray(registered) || !registered.token) {
    throw new Error('Relaycast did not return an agent token.');
  }
  return {
    baseUrl,
    identity: {
      id: registered.id,
      name: normalizeAgentName(registered.name),
      token: registered.token,
      relay: asDeliveryRelay(registered as unknown as AgentRelayAgent),
    },
  };
}

export function registerOnRelayCommand(
  program: Command,
  overrides: Partial<OnRelayCommandDependencies> = {}
): void {
  const deps = withDefaults(overrides);
  addSdkOptions(
    program
      .command('on-relay')
      .description('Register this coding session on Relaycast and listen for incoming deliveries')
      .option('--name <name>', 'Agent name (or RELAY_AGENT_NAME)')
      .option('--harness <harness>', 'auto, codex, or claude (defaults to detection)')
      .option('--session-id <id>', 'Codex thread or Claude Code session UUID')
      .option('--state-file <path>', 'Durable delivery ledger path (advanced)')
  ).action(async (options: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const rawName =
        option(options, 'name') ?? envValue(deps.env, 'RELAY_AGENT_NAME', 'AGENT_RELAY_AGENT_NAME');
      if (!rawName) throw new Error('Agent name is required. Pass --name <name> or set RELAY_AGENT_NAME.');
      const name = normalizeAgentName(rawName);
      const target = await resolveOnRelayTarget({
        harness: option(options, 'harness'),
        sessionId: option(options, 'sessionId'),
        env: deps.env,
        detectedHarness: deps.detectHarness(),
      });
      const { identity, baseUrl } = await prepareIdentity(name, target, options, deps);
      const controller = new AbortController();
      const shutdown = () => controller.abort();
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      deps.log(`On relay as @${identity.name} (${target.harness} session ${target.sessionId}).`);
      try {
        await deps.listen({
          identity,
          target,
          baseUrl,
          stateFile: option(options, 'stateFile') ?? envValue(deps.env, 'RELAY_ON_RELAY_STATE_FILE'),
          version: deps.version,
          signal: controller.signal,
          log: (message) => deps.log(message),
          warn: (message) => deps.error(message),
        });
      } finally {
        process.removeListener('SIGINT', shutdown);
        process.removeListener('SIGTERM', shutdown);
      }
      deps.log(`Off relay as @${identity.name}.`);
    });
  });
}
