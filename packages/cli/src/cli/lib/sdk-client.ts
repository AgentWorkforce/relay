import path from 'node:path';

import { AgentRelay, type AgentRelayAgent } from '@agent-relay/sdk';
import { AGENT37_RELAYCAST_ORIGIN, CANONICAL_RELAYCAST_ORIGIN } from '@agent-relay/cloud';
import {
  resolveWorkspaceSelection as resolveCloudWorkspaceSelection,
  writeProjectWorkspaceTargetIfSelectionCurrent,
  type WorkspaceSelection,
  type WorkspaceKeySource,
} from '@agent-relay/cloud/workspace-key';

/** Options shared by the SDK-backed (Relaycast) CLI command groups. */
export interface SdkClientOptions {
  workspaceKey?: string;
  token?: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  /** Use the canonical gateway instead of a persisted server-selected route. */
  ignorePersistedRelaycastTarget?: boolean;
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

export type WorkspaceTransport = {
  workspaceKey: string;
  baseUrl?: string;
  source: WorkspaceKeySource;
};

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
  const transport = resolveWorkspaceTransport(options);
  return { key: transport.workspaceKey, source: transport.source };
}

export function resolveWorkspaceKey(options: SdkClientOptions = {}): string {
  return resolveWorkspaceKeyWithSource(options).key;
}

export function resolveBaseUrl(options: SdkClientOptions = {}): string | undefined {
  const selection = selectionForTransport(options);
  return resolveBaseUrlForSelection(selection, options);
}

function selectionForTransport(options: SdkClientOptions): WorkspaceSelection | undefined {
  const selection = resolveWorkspaceSelection(options);
  if (!selection || !options.ignorePersistedRelaycastTarget) return selection;
  const {
    relaycastRoute: _relaycastRoute,
    relaycastBaseUrl: _relaycastBaseUrl,
    relaycastApiKey: _relaycastApiKey,
    ...canonicalSelection
  } = selection;
  return canonicalSelection;
}

function resolveBaseUrlForSelection(
  selection: WorkspaceSelection | undefined,
  options: SdkClientOptions
): string | undefined {
  const persisted = validatePersistedRelaycastBaseUrl(selection);
  const requested = trimOrUndefined(options.baseUrl) ?? trimOrUndefined(env(options).RELAY_BASE_URL);
  if (persisted && requested) {
    let parsed: URL;
    try {
      parsed = new URL(requested);
    } catch {
      throw new Error('The requested Relaycast base URL is invalid.');
    }
    const authority = /^https:\/\/([^/?#]+)/i.exec(requested)?.[1] ?? '';
    if (
      !/^https:\/\/[^/?#]+\/?$/i.test(requested) ||
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      /:\d+$/.test(authority) ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== '' && parsed.pathname !== '/')
    ) {
      throw new Error('The requested Relaycast base URL is not a trusted origin.');
    }
    if (parsed.origin !== persisted) {
      throw new Error('The requested Relaycast base URL does not match the persisted workspace route.');
    }
  }
  return persisted ?? requested;
}

/** Resolve one credential/origin pair from one workspace selection. */
export function resolveWorkspaceTransport(options: SdkClientOptions = {}): WorkspaceTransport {
  const selection = selectionForTransport(options);
  if (!selection) {
    throw new Error(
      'No workspace key found. Pass --workspace-key, set RELAY_WORKSPACE_KEY, or run `relay workspace set_key <name> <key>`.'
    );
  }
  const baseUrl = resolveBaseUrlForSelection(selection, options);
  return {
    workspaceKey: trimOrUndefined(selection.relaycastApiKey) ?? selection.key,
    ...(baseUrl ? { baseUrl } : {}),
    source: selection.source,
  };
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

/** Persist a server-selected target only while the captured project selection is still current. */
export function persistWorkspaceRelaycastTarget(
  selection: WorkspaceSelection | undefined,
  target: {
    route: 'canonical' | 'agent37-isolated';
    baseUrl: string;
    workspaceId: string;
    relaycastApiKey: string;
  }
): boolean {
  if (!selection) return false;
  const selectionWithProjectDir = selection as WorkspaceSelection & { projectDataDir?: string };
  const dataDir =
    selectionWithProjectDir?.projectDataDir ??
    (selection?.source === 'project' && selection.origin ? path.dirname(selection.origin) : undefined);
  if (!dataDir) return false;
  return writeProjectWorkspaceTargetIfSelectionCurrent(dataDir, selection, {
    workspaceId: target.workspaceId,
    relaycastRoute: target.route,
    relaycastBaseUrl: target.baseUrl,
    relaycastApiKey: target.relaycastApiKey,
  });
}

export function resolveAgentToken(options: SdkClientOptions = {}): string | undefined {
  return trimOrUndefined(options.token) ?? trimOrUndefined(env(options).RELAY_AGENT_TOKEN);
}

/** Workspace-scoped client (no agent token). */
export function createWorkspaceRelay(options: SdkClientOptions = {}): AgentRelay {
  const { workspaceKey, baseUrl } = resolveWorkspaceTransport(options);
  return new AgentRelay({ workspaceKey, baseUrl });
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
  const { workspaceKey, baseUrl } = resolveWorkspaceTransport(options);
  return new AgentRelay({ workspaceKey, baseUrl });
}
