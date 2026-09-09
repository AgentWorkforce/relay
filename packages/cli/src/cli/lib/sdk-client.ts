import path from 'node:path';

import { AgentRelay, type AgentRelayAgent } from '@agent-relay/sdk';
import { AGENT37_RELAYCAST_ORIGIN, CANONICAL_RELAYCAST_ORIGIN } from '@agent-relay/cloud';
import {
  resolveWorkspaceSelection as resolveCloudWorkspaceSelection,
  readProjectWorkspaceSession,
  writeProjectWorkspaceKey,
  type WorkspaceSelection,
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
export type { WorkspaceSelection };

/** Resolve the selected key and any previously persisted Relay workspace identity. */
export function resolveWorkspaceSelection(options: SdkClientOptions = {}): WorkspaceSelection | undefined {
  return resolveCloudWorkspaceSelection({
    workspaceKey: options.workspaceKey,
    env: env(options),
  });
}

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
  const selection = resolveWorkspaceSelection(options);
  if (selection) {
    // A Cloud workspace key remains the durable selector and Cloud credential.
    // A persisted Relaycast target may carry a different route-scoped transport
    // credential for SDK traffic on the same workspace.
    validatePersistedRelaycastBaseUrl(selection);
    return {
      key: trimOrUndefined(selection.relaycastApiKey) ?? selection.key,
      source: selection.source,
    };
  }
  throw new Error(
    'No workspace key found. Pass --workspace-key, set RELAY_WORKSPACE_KEY, or run `relay workspace set_key <name> <key>`.'
  );
}

export function resolveWorkspaceKey(options: SdkClientOptions = {}): string {
  return resolveWorkspaceKeyWithSource(options).key;
}

export function resolveBaseUrl(options: SdkClientOptions = {}): string | undefined {
  const selection = resolveWorkspaceSelection(options);
  const persisted = validatePersistedRelaycastBaseUrl(selection);
  const requested = trimOrUndefined(options.baseUrl) ?? trimOrUndefined(env(options).RELAY_BASE_URL);
  if (persisted && requested && requested !== persisted) {
    throw new Error('The requested Relaycast base URL does not match the persisted workspace route.');
  }
  return persisted ?? requested;
}

function validatePersistedRelaycastBaseUrl(selection: WorkspaceSelection | undefined): string | undefined {
  const baseUrl = trimOrUndefined(selection?.relaycastBaseUrl);
  const route = selection?.relaycastRoute;
  const relaycastApiKey = trimOrUndefined(selection?.relaycastApiKey);
  if (!baseUrl && !route && !relaycastApiKey) return undefined;
  if (!baseUrl || !route) {
    throw new Error('The persisted Relaycast workspace route is incomplete.');
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('The persisted Relaycast workspace route is invalid.');
  }
  const expectedOrigin =
    route === 'canonical'
      ? CANONICAL_RELAYCAST_ORIGIN
      : route === 'agent37-isolated'
        ? AGENT37_RELAYCAST_ORIGIN
        : undefined;
  if (
    !expectedOrigin ||
    parsed.origin !== expectedOrigin ||
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    throw new Error('The persisted Relaycast workspace route is not trusted.');
  }
  return parsed.origin;
}

/** Persist a server-selected target only for an existing project session. */
export function persistWorkspaceRelaycastTarget(
  selection: WorkspaceSelection | undefined,
  target: {
    route: 'canonical' | 'agent37-isolated';
    baseUrl: string;
    workspaceId: string;
    relaycastApiKey: string;
  }
): boolean {
  const selectionWithProjectDir = selection as (WorkspaceSelection & { projectDataDir?: string }) | undefined;
  const dataDir =
    selectionWithProjectDir?.projectDataDir ??
    (selection?.source === 'project' && selection.origin ? path.dirname(selection.origin) : undefined);
  if (!dataDir) return false;
  const existing = readProjectWorkspaceSession(dataDir);
  if (!existing) return false;
  const restoreExisting = (): void => {
    writeProjectWorkspaceKey(dataDir, existing.workspaceKey, {
      ...(existing.enrolledNodeId ? { enrolledNodeId: existing.enrolledNodeId } : {}),
      ...(existing.workspaceId ? { workspaceId: existing.workspaceId } : {}),
      ...(existing.relaycastRoute ? { relaycastRoute: existing.relaycastRoute } : {}),
      ...(existing.relaycastBaseUrl ? { relaycastBaseUrl: existing.relaycastBaseUrl } : {}),
      ...(existing.relaycastApiKey ? { relaycastApiKey: existing.relaycastApiKey } : {}),
    });
  };
  try {
    writeProjectWorkspaceKey(dataDir, existing.workspaceKey, {
      ...(existing.enrolledNodeId ? { enrolledNodeId: existing.enrolledNodeId } : {}),
      workspaceId: target.workspaceId,
      relaycastRoute: target.route,
      relaycastBaseUrl: target.baseUrl,
      relaycastApiKey: target.relaycastApiKey,
    });
    const persisted = readProjectWorkspaceSession(dataDir);
    if (
      persisted?.workspaceKey === existing.workspaceKey &&
      persisted.relaycastApiKey === target.relaycastApiKey &&
      persisted.workspaceId === target.workspaceId &&
      persisted.relaycastRoute === target.route &&
      persisted.relaycastBaseUrl === target.baseUrl
    ) {
      return true;
    }
    restoreExisting();
    return false;
  } catch (error) {
    try {
      restoreExisting();
    } catch (restoreError) {
      throw new Error('Could not restore the prior Relaycast project session after persistence failed.', {
        cause: restoreError,
      });
    }
    throw error;
  }
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
  // Agent tokens are valid Relaycast transport credentials and already bind
  // the caller to exactly one workspace. Prefer the scoped token itself over
  // every ambient workspace-key source so invited humans cannot accidentally
  // inherit the local owner's rk_live credential from this project or machine.
  if (token) {
    return new AgentRelay({
      agentToken: token,
      baseUrl: resolveBaseUrl(options),
    });
  }
  return new AgentRelay({
    workspaceKey: resolveWorkspaceKey(options),
    baseUrl: resolveBaseUrl(options),
  });
}
