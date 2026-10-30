import { getProjectPaths, isRelayHomeDir, RelayHomeProjectError } from '@agent-relay/config';
import { resolveWorkspaceKeyWithSource } from '@agent-relay/cloud/workspace-key';

import {
  readProjectWorkspaceSession,
  writeProjectWorkspaceKey,
  writeProjectWorkspaceKeyPreservingSession,
} from './project-workspace-key.js';
import {
  readWorkspaceStore,
  setWorkspaceKey,
  switchWorkspace,
  validateWorkspaceName,
} from './workspace-store.js';

export interface WorkspaceSessionOptions {
  env?: NodeJS.ProcessEnv;
  projectRoot?: string;
  projectDataDir?: string;
}

export interface PersistWorkspaceSessionOptions extends WorkspaceSessionOptions {
  workspaceKey: string;
  /** Canonical Relaycast workspace id, when the credential issuer supplies it. */
  workspaceId?: string;
  relaycastRoute?: 'canonical' | 'agent37-isolated';
  relaycastBaseUrl?: string;
  /** Route-scoped Relaycast credential paired with the persisted route. */
  relaycastApiKey?: string;
  /** Named sessions are also stored and selected in the machine-global workspace store. */
  name?: string;
  /**
   * When a named session becomes the machine-global active workspace.
   * `always` (the default) selects it, as `relay workspace switch/join/create` do.
   * `if-none` selects it only when no other saved workspace is active, so a
   * project-scoped setup such as `relay init` never moves the whole machine off
   * a workspace something else already relies on.
   */
  activate?: 'always' | 'if-none';
}

export interface PinProjectWorkspaceSessionOptions extends WorkspaceSessionOptions {
  workspaceKey: string;
}

/** Validate and normalize a workspace session name before local or remote writes. */
export function validateWorkspaceSessionName(name: string): string {
  return validateWorkspaceName(name);
}

/**
 * Resolve the workspace session for this process. Explicit/env selection still
 * wins, then the project pin, then the machine-global active workspace.
 */
export function resolveWorkspaceSessionKey(options: WorkspaceSessionOptions = {}): string | undefined {
  return resolveWorkspaceKeyWithSource(options)?.key;
}

export interface PersistWorkspaceSessionResult {
  /**
   * Enrolled node association dropped because the project moved to a different
   * workspace. Present only when there was one to drop.
   */
  clearedEnrolledNodeId?: string;
  /**
   * The machine-global active workspace left in place because `activate` was
   * `if-none` and a different saved workspace was already active.
   */
  keptActiveWorkspace?: string;
  /**
   * No project pin was written: the project folder resolved to the relay home
   * (`~`), so only the machine-wide workspace store changed.
   */
  projectPinSkipped?: boolean;
}

/**
 * Operator-facing explanation of a dropped enrollment association.
 *
 * Shared by every caller that changes the pin — CLI and MCP alike — so none of
 * them can report success while the clearing goes unmentioned.
 *
 * @param result - What {@link persistWorkspaceSession} reported.
 * @returns The message, or `undefined` when nothing was cleared.
 */
export function describeClearedEnrollment(result: PersistWorkspaceSessionResult): string | undefined {
  if (!result.clearedEnrolledNodeId) {
    return undefined;
  }
  return (
    `Cleared this project's enrolled fleet node (${result.clearedEnrolledNodeId}): it belongs to the ` +
    "workspace you moved away from. Run 'relay cloud enroll' from this project to serve a node in the " +
    'new workspace.'
  );
}

/**
 * Pin a workspace to the current project so later CLI and MCP processes resume
 * the same collaboration session. A named selection also becomes the
 * machine-global active workspace; a bare shared key only changes this project.
 *
 * @returns What the write changed beyond the key itself.
 */
export function persistWorkspaceSession(
  options: PersistWorkspaceSessionOptions
): PersistWorkspaceSessionResult {
  const workspaceKey = options.workspaceKey.trim();
  if (!workspaceKey) {
    throw new Error('Workspace key is required.');
  }

  const name = options.name === undefined ? undefined : validateWorkspaceSessionName(options.name);

  const projectDataDir = options.projectDataDir ?? getProjectPaths(options.projectRoot).dataDir;
  // Outside any project (in `~`, whose `.agentworkforce/relay` is the relay
  // home itself) there is no project to pin: a named selection still becomes
  // the machine-wide workspace, as `relay workspace switch` from `~` means;
  // a bare key, which only ever pins a project, is refused.
  if (isRelayHomeDir(projectDataDir, options.env ?? process.env)) {
    if (!name) throw new RelayHomeProjectError(projectDataDir);
    const otherActive = options.activate === 'if-none' ? otherActiveWorkspace(name, options.env) : undefined;
    setWorkspaceKey(name, workspaceKey, options.env);
    if (!otherActive) switchWorkspace(name, options.env);
    return { projectPinSkipped: true, ...(otherActive ? { keptActiveWorkspace: otherActive } : {}) };
  }
  const existing = readProjectWorkspaceSession(projectDataDir, undefined, options.env);
  // Re-selecting the same workspace must keep the enrolled node: dropping it
  // there manufactured the pin `node up` now warns about, where the next start
  // ignores the enrollment store entirely.
  //
  // Moving to a *different* workspace must not. The enrollment resolves by node
  // id alone, and `node up` applies its credentials without applying the pinned
  // key — so carrying the id across would run the broker in the old workspace
  // while every other command in this project reads the new one. That is the
  // split this whole change exists to remove, and the workspace ids the
  // enrollment store holds cannot be checked against the key the pin holds.
  //
  // This intentionally does NOT delegate to `pinProjectWorkspaceSession`
  // below, which always drops the enrolled-node association — that is correct
  // for an explicit `rebind` but would reintroduce the bug described above
  // for an ordinary switch/join/create that happens to stay on the same key.
  const keepsWorkspace = existing?.workspaceKey === workspaceKey;
  const enrolledNodeId = keepsWorkspace ? existing?.enrolledNodeId : undefined;
  if (keepsWorkspace) {
    writeProjectWorkspaceKeyPreservingSession(projectDataDir, workspaceKey, {
      ...(enrolledNodeId ? { enrolledNodeId } : {}),
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options.relaycastRoute ? { relaycastRoute: options.relaycastRoute } : {}),
      ...(options.relaycastBaseUrl ? { relaycastBaseUrl: options.relaycastBaseUrl } : {}),
      ...(options.relaycastApiKey ? { relaycastApiKey: options.relaycastApiKey } : {}),
      env: options.env,
    });
  } else {
    writeProjectWorkspaceKey(projectDataDir, workspaceKey, {
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options.relaycastRoute ? { relaycastRoute: options.relaycastRoute } : {}),
      ...(options.relaycastBaseUrl ? { relaycastBaseUrl: options.relaycastBaseUrl } : {}),
      ...(options.relaycastApiKey ? { relaycastApiKey: options.relaycastApiKey } : {}),
      env: options.env,
    });
  }

  let keptActiveWorkspace: string | undefined;
  if (name) {
    const otherActive = options.activate === 'if-none' ? otherActiveWorkspace(name, options.env) : undefined;
    setWorkspaceKey(name, workspaceKey, options.env);
    if (otherActive) {
      keptActiveWorkspace = otherActive;
    } else {
      switchWorkspace(name, options.env);
    }
  }

  return {
    ...(existing?.enrolledNodeId && !enrolledNodeId
      ? { clearedEnrolledNodeId: existing.enrolledNodeId }
      : {}),
    ...(keptActiveWorkspace ? { keptActiveWorkspace } : {}),
  };
}

/**
 * The saved workspace active machine-wide, when it is one other than `name`.
 * An active name with no saved entry resolves to nothing, so it is not kept.
 */
function otherActiveWorkspace(name: string, env: NodeJS.ProcessEnv | undefined): string | undefined {
  const store = readWorkspaceStore(env);
  const active = store.active;
  return active && active !== name && store.workspaces[active] ? active : undefined;
}

/**
 * Rebind only the current project to a workspace key. This intentionally drops
 * any enrolled-node association: a later `node up` must honor the newly pinned
 * messaging workspace instead of resuming credentials from the old binding.
 */
export function pinProjectWorkspaceSession(options: PinProjectWorkspaceSessionOptions): void {
  const workspaceKey = options.workspaceKey.trim();
  if (!workspaceKey) {
    throw new Error('Workspace key is required.');
  }
  const projectDataDir = options.projectDataDir ?? getProjectPaths(options.projectRoot).dataDir;
  writeProjectWorkspaceKey(projectDataDir, workspaceKey, { env: options.env });
}
