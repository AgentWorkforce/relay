import { AgentRelay, type AgentRelayAgent } from '@agent-relay/sdk';
import { getProjectPaths } from '@agent-relay/config';

import { activeWorkspaceKey } from './workspace-store.js';
import { readProjectWorkspaceKey } from './project-workspace-key.js';

/** Options shared by the SDK-backed (Relaycast) CLI command groups. */
export interface SdkClientOptions {
  workspaceKey?: string;
  token?: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}

function env(options: SdkClientOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveWorkspaceKey(options: SdkClientOptions = {}): string {
  const e = env(options);
  const key =
    trimOrUndefined(options.workspaceKey) ??
    trimOrUndefined(e.RELAY_WORKSPACE_KEY) ??
    trimOrUndefined(e.RELAY_API_KEY) ??
    // The workspace the local broker in this CWD was started with (`relay up
    // --workspace-key/--wk`), so commands run alongside a project broker resolve
    // its workspace rather than the machine-global active workspace. Ranked
    // above the global store but below an explicit flag/env override.
    trimOrUndefined(projectWorkspaceKey()) ??
    trimOrUndefined(activeWorkspaceKey(e));
  if (!key) {
    throw new Error(
      'No workspace key found. Pass --workspace-key, set RELAY_WORKSPACE_KEY, or run `relay workspace set_key <name> <key>`.'
    );
  }
  return key;
}

/**
 * Read the workspace key recorded by `relay up` for the current project
 * directory, or `undefined` when there is none / the project root cannot be
 * resolved. Never throws — a resolution failure just falls through.
 */
function projectWorkspaceKey(): string | undefined {
  try {
    return readProjectWorkspaceKey(getProjectPaths().dataDir);
  } catch {
    return undefined;
  }
}

export function resolveBaseUrl(options: SdkClientOptions = {}): string | undefined {
  return trimOrUndefined(options.baseUrl) ?? trimOrUndefined(env(options).RELAY_BASE_URL);
}

export function resolveAgentToken(options: SdkClientOptions = {}): string | undefined {
  return trimOrUndefined(options.token) ?? trimOrUndefined(env(options).RELAY_AGENT_TOKEN);
}

/** Workspace-scoped client (no agent token). */
export function createWorkspaceRelay(options: SdkClientOptions = {}): AgentRelay {
  return new AgentRelay({ workspaceKey: resolveWorkspaceKey(options), baseUrl: resolveBaseUrl(options) });
}

/**
 * Agent-scoped client. When an agent token is available (flag or
 * `RELAY_AGENT_TOKEN`), operations are attributed to that agent; otherwise the
 * workspace-scoped client is returned.
 */
export function createAgentRelay(options: SdkClientOptions = {}): AgentRelayAgent {
  const token = resolveAgentToken(options);
  return new AgentRelay({
    workspaceKey: resolveWorkspaceKey(options),
    baseUrl: resolveBaseUrl(options),
    ...(token ? { agentToken: token } : {}),
  });
}
