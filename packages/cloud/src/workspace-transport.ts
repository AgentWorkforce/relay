import path from 'node:path';
import { AGENT37_RELAYCAST_ORIGIN, CANONICAL_RELAYCAST_ORIGIN } from './fleet-sandbox.js';
import {
  resolveWorkspaceSelection as resolveCloudWorkspaceSelection,
  type WorkspaceSelection,
  type WorkspaceKeySource,
} from './workspace-key.js';
/** Options shared by the SDK-backed (Relaycast) CLI command groups. */
export interface WorkspaceTransportOptions {
  workspaceKey?: string;
  token?: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  /** Explicit project root for nested invocations such as packages/web. */
  projectRoot?: string;
  /** Use the canonical gateway instead of a persisted server-selected route. */
  ignorePersistedRelaycastTarget?: boolean;
}

function env(options: WorkspaceTransportOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export type WorkspaceTransport = {
  workspaceKey: string;
  baseUrl?: string;
  source: WorkspaceKeySource;
};

/** Resolve the selected key and any previously persisted Relay workspace identity. */
export function resolveWorkspaceSelection(
  options: WorkspaceTransportOptions = {}
): WorkspaceSelection | undefined {
  const explicitProject = trimOrUndefined(env(options).AGENT_RELAY_PROJECT);
  const projectRoot = explicitProject ? path.resolve(explicitProject) : options.projectRoot;
  return resolveCloudWorkspaceSelection({
    workspaceKey: options.workspaceKey,
    env: env(options),
    ...(projectRoot ? { projectRoot } : {}),
  });
}

export function resolveBaseUrl(options: WorkspaceTransportOptions = {}): string | undefined {
  const selection = selectionForTransport(options);
  return resolveBaseUrlForSelection(selection, options);
}

function selectionForTransport(options: WorkspaceTransportOptions): WorkspaceSelection | undefined {
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
  options: WorkspaceTransportOptions
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
export function resolveWorkspaceTransport(options: WorkspaceTransportOptions = {}): WorkspaceTransport {
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
