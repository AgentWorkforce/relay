import { AgentRelay, type AgentRelayAgent } from '@agent-relay/sdk';

import { activeWorkspaceKey } from './workspace-store.js';

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
    trimOrUndefined(activeWorkspaceKey(e));
  if (!key) {
    throw new Error(
      'No workspace key found. Pass --workspace-key, set RELAY_WORKSPACE_KEY, or run `relay workspace set_key <name> <key>`.'
    );
  }
  return key;
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
  const relay = createWorkspaceRelay(options);
  const token = resolveAgentToken(options);
  return token ? relay.as(token) : relay;
}
