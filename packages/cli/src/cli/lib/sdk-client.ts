import { lstatSync } from 'node:fs';
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

export type WorkspaceTransport = {
  workspaceKey: string;
  baseUrl?: string;
  source: WorkspaceKeySource;
};

/** Resolve the selected key and any previously persisted Relay workspace identity. */
export function resolveWorkspaceSelection(options: SdkClientOptions = {}): WorkspaceSelection | undefined {
  const projectRoot = options.projectRoot ?? inferGitProjectRoot(env(options));
  return resolveCloudWorkspaceSelection({
    workspaceKey: options.workspaceKey,
    env: env(options),
    ...(projectRoot ? { projectRoot } : {}),
  });
}

/** Resolve the repository root for nested package invocations. */
function inferGitProjectRoot(environment: NodeJS.ProcessEnv): string | undefined {
  // The config package intentionally honours this override for worktrees and
  // subprojects. Do not replace an operator-selected namespace with Git's
  // answer.
  if (environment.AGENT_RELAY_PROJECT?.trim() || process.env.AGENT_RELAY_PROJECT?.trim()) return undefined;
  // Follow-up commands only need the project boundary, not Git execution.
  // Recognize both ordinary repositories and worktree .git files so a missing
  // Git binary or a Git subprocess failure cannot select a different workspace.
  let directory = process.cwd();
  while (true) {
    try {
      const marker = lstatSync(path.join(directory, '.git'));
      if (marker.isDirectory() || marker.isFile()) return directory;
      throw new Error('Invalid Git project marker.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Cannot resolve the repository workspace; check access to its Git project marker.');
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
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
    relaycastApiKeyRef: _relaycastApiKeyRef,
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
  // Project-session loading already validates the reference against the
  // project/workspace/route/base tuple. Never re-read a ref here: doing so
  // would let a tampered ref bypass that binding and pair an unrelated key
  // with this route.
  const routeCredential = trimOrUndefined(selection.relaycastApiKey);
  if (selection.relaycastRoute === 'agent37-isolated' && !routeCredential) {
    throw new Error(
      'The persisted isolated Relaycast credential is unavailable or mismatched; rerun the sandbox command to mint a fresh route.'
    );
  }
  return {
    workspaceKey: routeCredential ?? selection.key,
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
