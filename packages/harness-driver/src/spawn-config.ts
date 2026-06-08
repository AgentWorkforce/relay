import path from 'node:path';

import type { EventBus } from './event-bus.js';
import type { HarnessDriverEvents } from './lifecycle-hooks.js';

export interface BrokerInitArgs {
  /** Optional HTTP API port for dashboard proxy (0 = disabled). */
  apiPort?: number;
  /** Bind address for the HTTP API. Defaults to 127.0.0.1 in the broker. */
  apiBind?: string;
  /** Enable persistence for broker state under the working directory. */
  persist?: boolean;
  /** Override the directory used for broker state files. */
  stateDir?: string;
}

export interface RuntimeSpawnOptions {
  /** Path to the agent-relay-broker binary. Auto-resolved if omitted. */
  binaryPath?: string;
  /** Structured options mapped to the broker's Rust `init` CLI flags. */
  binaryArgs?: BrokerInitArgs;
  /** Existing Relay workspace key to join. Defaults to env when omitted. */
  workspaceKey?: string;
  /** Broker name. Defaults to cwd basename. */
  brokerName?: string;
  /** Default channels for spawned agents. */
  channels?: string[];
  /** Working directory for the broker process. */
  cwd?: string;
  /** Environment variables for the broker process. */
  env?: NodeJS.ProcessEnv;
  /** Forward broker stderr to this callback. */
  onStderr?: (line: string) => void;
  /** Timeout in ms to wait for broker to become ready. Default: 45000. */
  startupTimeoutMs?: number;
  /** Timeout in ms for HTTP requests to the broker. Default: 30000. */
  requestTimeoutMs?: number;
  /** Optional shared event bus — see {@link HarnessDriverClientOptions.eventBus}. */
  eventBus?: EventBus<HarnessDriverEvents>;
}

/** @internal */
export interface BrokerSpawnConfig {
  cwd: string;
  brokerName: string;
  workspaceKey?: string;
  channels: string[];
  timeoutMs: number;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function buildBrokerInitArgs(args?: BrokerInitArgs): string[] {
  if (!args) {
    return [];
  }

  const cliArgs: string[] = [];

  if (args.persist) {
    cliArgs.push('--persist');
  }
  if (args.apiPort !== undefined) {
    cliArgs.push('--api-port', String(args.apiPort));
  }
  if (args.apiBind !== undefined) {
    cliArgs.push('--api-bind', args.apiBind);
  }
  if (args.stateDir !== undefined) {
    cliArgs.push('--state-dir', args.stateDir);
  }

  return cliArgs;
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** @internal */
export function buildBrokerSpawnConfig(
  options: RuntimeSpawnOptions | undefined,
  apiKey: string,
  parentEnv: NodeJS.ProcessEnv = process.env
): BrokerSpawnConfig {
  const cwd = options?.cwd ?? process.cwd();
  const brokerName =
    nonEmptyString(options?.brokerName) ??
    nonEmptyString(options?.env?.AGENT_RELAY_BROKER_NAME) ??
    nonEmptyString(parentEnv.AGENT_RELAY_BROKER_NAME) ??
    (path.basename(cwd) || 'project');
  const workspaceKey =
    nonEmptyString(options?.workspaceKey) ??
    nonEmptyString(options?.env?.AGENT_RELAY_WORKSPACE_KEY) ??
    nonEmptyString(options?.env?.RELAY_WORKSPACE_KEY) ??
    nonEmptyString(parentEnv.AGENT_RELAY_WORKSPACE_KEY) ??
    nonEmptyString(parentEnv.RELAY_WORKSPACE_KEY);
  const channels = options?.channels ?? ['general'];
  const timeoutMs = options?.startupTimeoutMs ?? 45_000;
  const userArgs = buildBrokerInitArgs(options?.binaryArgs);

  const env = {
    ...parentEnv,
    ...options?.env,
    AGENT_RELAY_STARTUP_DEBUG:
      options?.env?.AGENT_RELAY_STARTUP_DEBUG ?? parentEnv.AGENT_RELAY_STARTUP_DEBUG ?? '1',
    RELAY_BROKER_API_KEY: apiKey,
    ...(workspaceKey
      ? {
          AGENT_RELAY_WORKSPACE_KEY: workspaceKey,
          RELAY_WORKSPACE_KEY: workspaceKey,
          RELAY_API_KEY: workspaceKey,
        }
      : {}),
    AGENT_RELAY_BROKER_NAME: brokerName,
  };

  const args = [
    'init',
    '--instance-name',
    brokerName,
    ...(workspaceKey ? ['--workspace-key', workspaceKey] : []),
    '--channels',
    channels.join(','),
    ...userArgs,
  ];

  return { cwd, brokerName, workspaceKey, channels, timeoutMs, args, env };
}
