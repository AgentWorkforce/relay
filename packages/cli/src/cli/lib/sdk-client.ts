import { AgentRelay, type AgentRelayAgent } from '@agent-relay/sdk';
import {
  resolveWorkspaceKeyWithSource as resolveCloudWorkspaceKeyWithSource,
  type WorkspaceKeySource,
} from '@agent-relay/cloud/workspace-key';

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

/** Where a resolved workspace key came from, in precedence order. */
export type { WorkspaceKeySource };

/**
 * Resolve the workspace key and report which source it came from. Precedence:
 * explicit flag → `RELAY_WORKSPACE_KEY`/`RELAY_API_KEY` env → the key the local
 * broker in this CWD was started with (`relay up`) → the machine-global active
 * workspace. Callers use the source to warn when the key was inferred from the
 * project broker rather than named explicitly.
 */
export function resolveWorkspaceKeyWithSource(options: SdkClientOptions = {}): {
  key: string;
  source: WorkspaceKeySource;
} {
  const resolved = resolveCloudWorkspaceKeyWithSource({
    workspaceKey: options.workspaceKey,
    env: env(options),
  });
  if (resolved) return resolved;
  throw new Error(
    'No workspace key found. Pass --workspace-key, set RELAY_WORKSPACE_KEY, or run `relay workspace set_key <name> <key>`.'
  );
}

export function resolveWorkspaceKey(options: SdkClientOptions = {}): string {
  return resolveWorkspaceKeyWithSource(options).key;
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
