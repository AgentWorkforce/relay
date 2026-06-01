import type { Command } from 'commander';

import { AgentRelay, type AgentRelayAgent } from '@agent-relay/sdk';

import { defaultExit } from './exit.js';
import { createAgentRelay, createWorkspaceRelay, type SdkClientOptions } from './sdk-client.js';

type ExitFn = (code: number) => never;

/** Shared dependencies for the SDK-backed (Relaycast) command groups. */
export interface SdkCommandDeps {
  createAgentRelay: (options?: SdkClientOptions) => AgentRelayAgent;
  createWorkspaceRelay: (options?: SdkClientOptions) => AgentRelayAgent;
  createWorkspace: (name: string, baseUrl?: string) => Promise<AgentRelay>;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

export function withSdkDefaults(overrides: Partial<SdkCommandDeps> = {}): SdkCommandDeps {
  return {
    createAgentRelay,
    createWorkspaceRelay,
    createWorkspace: (name, baseUrl) => AgentRelay.createWorkspace({ name, baseUrl }),
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    ...overrides,
  };
}

/** Add the common workspace/token/base-url options to a command. */
export function addSdkOptions(command: Command): Command {
  return command
    .option(
      '--workspace-key <key>',
      'Workspace key (defaults to RELAY_WORKSPACE_KEY or the active workspace)'
    )
    .option('--token <token>', 'Agent token (defaults to RELAY_AGENT_TOKEN)')
    .option('--base-url <url>', 'Override the API base URL (defaults to RELAY_BASE_URL)');
}

export function sdkOptionsFromOpts(opts: Record<string, unknown>): SdkClientOptions {
  return {
    workspaceKey: opts.workspaceKey as string | undefined,
    token: opts.token as string | undefined,
    baseUrl: opts.baseUrl as string | undefined,
  };
}

export function printJson(deps: SdkCommandDeps, value: unknown): void {
  deps.log(JSON.stringify(value, null, 2));
}

/** Run an SDK command body, formatting errors consistently and exiting non-zero. */
export async function runSdk(deps: SdkCommandDeps, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    deps.exit(1);
  }
}
