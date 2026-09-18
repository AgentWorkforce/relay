import path from 'node:path';

import { AgentRelay, type AgentRelayAgent } from '@agent-relay/sdk';
import {
  resolveBaseUrl,
  resolveWorkspaceSelection,
  resolveWorkspaceTransport,
} from '@agent-relay/cloud/workspace-transport';
export {
  resolveBaseUrl,
  resolveWorkspaceSelection,
  resolveWorkspaceTransport,
  type WorkspaceTransport,
} from '@agent-relay/cloud/workspace-transport';
import {
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
  /** Explicit project root for nested invocations such as packages/web. */
  projectRoot?: string;
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
  if (trimOrUndefined(options.workspaceKey)) {
    if (trimOrUndefined(options.token)) {
      throw new Error('Pass either --workspace-key or --token, not both.');
    }
    // A deliberate workspace credential wins over an ambient participant token.
    // Inferred project/store credentials must still never elevate a participant.
    return createWorkspaceRelay(options);
  }
  const token = resolveAgentToken(options);
  // Agent tokens are valid Relaycast transport credentials and already bind
  // the caller to exactly one workspace. Prefer the scoped token itself over
  // every ambient workspace-key source so invited humans cannot accidentally
  // inherit the local owner's rk_live credential from this project or machine.
  if (token) {
    return new AgentRelay({
      agentToken: token,
      // An agent token is already scoped by the caller, whether supplied by a
      // flag or RELAY_AGENT_TOKEN. Do not let a persisted project route
      // silently select a different gateway; only an explicit/ambient base URL
      // may choose the token's origin.
      baseUrl: resolveBaseUrl({
        ...options,
        ignorePersistedRelaycastTarget: true,
      }),
    });
  }
  const { workspaceKey, baseUrl } = resolveWorkspaceTransport(options);
  return new AgentRelay({ workspaceKey, baseUrl });
}
