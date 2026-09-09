import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getProjectPaths } from '@agent-relay/config';

import { readWorkspaceStore, workspaceStorePath } from './workspace-store.js';

const PROJECT_WORKSPACE_KEY_FILENAME = 'workspace-key.json';

/** Workspace-key environment aliases, highest precedence first. */
const WORKSPACE_KEY_ENV_VARS = ['RELAY_WORKSPACE_KEY', 'AGENT_RELAY_WORKSPACE_KEY', 'RELAY_API_KEY'] as const;

export interface ProjectWorkspaceSession {
  workspaceKey: string;
  /** Enrolled Fleet node associated with this project session, when one started the broker. */
  enrolledNodeId?: string;
  /**
   * Relay workspace id the pinned key resolved to on a previous start. Recorded
   * so a later start can detect — before the broker comes up — that another
   * source (a stored Fleet enrollment, say) points at a different workspace.
   */
  workspaceId?: string;
  /** Last server-selected Relaycast route for follow-up commands in this session. */
  relaycastRoute?: 'canonical' | 'agent37-isolated';
  relaycastBaseUrl?: string;
  /** Route-scoped transport credential; the canonical Cloud workspace key remains `workspaceKey`. */
  relaycastApiKey?: string;
}

export type ProjectWorkspaceSessionMetadata = Omit<ProjectWorkspaceSession, 'workspaceKey'>;

export type WorkspaceKeySource = 'flag' | 'env' | 'project' | 'store';

export interface ResolveWorkspaceKeyOptions {
  workspaceKey?: string;
  env?: NodeJS.ProcessEnv;
  /** Project root whose local broker workspace should be preferred. Defaults to the current project. */
  projectRoot?: string;
  /** Explicit project Relay data directory. Takes precedence over projectRoot. */
  projectDataDir?: string;
  /** Optional filesystem adapter for reading the repository pin. */
  fileSystem?: WorkspaceKeyFileSystem;
}

export interface WorkspaceKeyFileSystem {
  readFileSync(filePath: string, encoding: BufferEncoding): string;
}

/**
 * A resolved workspace selection plus where it came from.
 *
 * `origin` is safe to print: it names a flag, an environment variable, or a
 * file path — never key material.
 */
export interface WorkspaceSelection {
  key: string;
  source: WorkspaceKeySource;
  /** Human-readable origin for diagnostics. Never contains key material. */
  origin: string;
  /** Workspace id this selection is known to address, when previously recorded. */
  workspaceId?: string;
  relaycastRoute?: 'canonical' | 'agent37-isolated';
  relaycastBaseUrl?: string;
  relaycastApiKey?: string;
  /** Project session directory that can durably carry a server-selected target. */
  projectDataDir?: string;
  /** Whether that project session existed when this selection was captured. */
  projectSessionPresent?: boolean;
}

/** Absolute path to the workspace key recorded by `agent-relay node up`. */
export function projectWorkspaceKeyPath(dataDir: string): string {
  return path.join(dataDir, PROJECT_WORKSPACE_KEY_FILENAME);
}

/** Read a project broker's workspace key, falling through on absent or malformed state. */
export function readProjectWorkspaceKey(
  dataDir: string,
  fileSystem: WorkspaceKeyFileSystem = fs
): string | undefined {
  return readProjectWorkspaceSession(dataDir, fileSystem)?.workspaceKey;
}

/** Read the project workspace and its optional enrolled Fleet identity. */
export function readProjectWorkspaceSession(
  dataDir: string,
  fileSystem: WorkspaceKeyFileSystem = fs
): ProjectWorkspaceSession | undefined {
  try {
    const raw = fileSystem.readFileSync(projectWorkspaceKeyPath(dataDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ProjectWorkspaceSession>;
    const workspaceKey = trimOrUndefined(parsed.workspaceKey);
    if (!workspaceKey) return undefined;
    const enrolledNodeId = trimOrUndefined(parsed.enrolledNodeId);
    const workspaceId = trimOrUndefined(parsed.workspaceId);
    const relaycastRoute =
      parsed.relaycastRoute === 'canonical' || parsed.relaycastRoute === 'agent37-isolated'
        ? parsed.relaycastRoute
        : undefined;
    const relaycastBaseUrl = trimOrUndefined(parsed.relaycastBaseUrl);
    const relaycastApiKey = trimOrUndefined(parsed.relaycastApiKey);
    return {
      workspaceKey,
      ...(enrolledNodeId ? { enrolledNodeId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(relaycastRoute ? { relaycastRoute } : {}),
      ...(relaycastBaseUrl ? { relaycastBaseUrl } : {}),
      ...(relaycastApiKey ? { relaycastApiKey } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Persist the project broker's workspace key atomically with owner-only permissions.
 * A blank key never clobbers a previously recorded workspace.
 */
export function writeProjectWorkspaceKey(
  dataDir: string,
  workspaceKey: string | undefined,
  options: {
    enrolledNodeId?: string;
    workspaceId?: string;
    relaycastRoute?: 'canonical' | 'agent37-isolated';
    relaycastBaseUrl?: string;
    relaycastApiKey?: string;
  } = {}
): void {
  const key = trimOrUndefined(workspaceKey);
  if (!key) return;
  const enrolledNodeId = trimOrUndefined(options.enrolledNodeId);
  const workspaceId = trimOrUndefined(options.workspaceId);
  const relaycastRoute = options.relaycastRoute;
  const relaycastBaseUrl = trimOrUndefined(options.relaycastBaseUrl);
  const relaycastApiKey = trimOrUndefined(options.relaycastApiKey);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = projectWorkspaceKeyPath(dataDir);
  // Worker threads share a PID, so include a per-write nonce as well as the PID.
  let tmp = `${file}.tmp.${process.pid}.${randomUUID()}`;
  const data = `${JSON.stringify(
    {
      workspaceKey: key,
      ...(enrolledNodeId ? { enrolledNodeId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(relaycastRoute ? { relaycastRoute } : {}),
      ...(relaycastBaseUrl ? { relaycastBaseUrl } : {}),
      ...(relaycastApiKey ? { relaycastApiKey } : {}),
    } satisfies ProjectWorkspaceSession,
    null,
    2
  )}\n`;

  let fd: number;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // The colliding path belongs to another writer. Never remove it; retry
    // exclusive creation with a new nonce so that writer can finish safely.
    tmp = `${file}.tmp.${process.pid}.${randomUUID()}`;
    fd = fs.openSync(tmp, 'wx', 0o600);
  }
  try {
    try {
      fs.writeSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Rewrite a project session while retaining server-selected metadata when the
 * workspace key is unchanged. A changed key is an intentional rebind, so no
 * metadata from the old workspace is carried across.
 *
 * The low-level writer above deliberately replaces the complete record. This
 * helper is for callers that update one part of an existing session (for
 * example, linking an enrolled node) and must not accidentally discard the
 * Relaycast target or workspace identity recorded alongside the key.
 */
export function writeProjectWorkspaceKeyPreservingSession(
  dataDir: string,
  workspaceKey: string | undefined,
  options: ProjectWorkspaceSessionMetadata = {}
): void {
  const key = trimOrUndefined(workspaceKey);
  if (!key) return;

  const existing = readProjectWorkspaceSession(dataDir);
  const sameWorkspace = existing?.workspaceKey === key;
  const retained: ProjectWorkspaceSessionMetadata = sameWorkspace
    ? {
        ...(existing?.enrolledNodeId ? { enrolledNodeId: existing.enrolledNodeId } : {}),
        ...(existing?.workspaceId ? { workspaceId: existing.workspaceId } : {}),
        ...(existing?.relaycastRoute ? { relaycastRoute: existing.relaycastRoute } : {}),
        ...(existing?.relaycastBaseUrl ? { relaycastBaseUrl: existing.relaycastBaseUrl } : {}),
        ...(existing?.relaycastApiKey ? { relaycastApiKey: existing.relaycastApiKey } : {}),
      }
    : {};

  writeProjectWorkspaceKey(dataDir, key, {
    ...retained,
    ...(trimOrUndefined(options.enrolledNodeId)
      ? { enrolledNodeId: trimOrUndefined(options.enrolledNodeId) }
      : {}),
    ...(trimOrUndefined(options.workspaceId) ? { workspaceId: trimOrUndefined(options.workspaceId) } : {}),
    ...(options.relaycastRoute ? { relaycastRoute: options.relaycastRoute } : {}),
    ...(trimOrUndefined(options.relaycastBaseUrl)
      ? { relaycastBaseUrl: trimOrUndefined(options.relaycastBaseUrl) }
      : {}),
    ...(trimOrUndefined(options.relaycastApiKey)
      ? { relaycastApiKey: trimOrUndefined(options.relaycastApiKey) }
      : {}),
  });
}

/**
 * Resolve which Relay workspace this process addresses.
 *
 * This is THE workspace precedence ladder — every caller (SDK clients, the CLI,
 * `agent-relay up` / `node up`) resolves through it so a repository cannot end
 * up in one workspace and its tooling in another:
 *
 * 1. `flag`    — an explicit `--workspace-key` / `--wk`.
 * 2. `env`     — `RELAY_WORKSPACE_KEY` > `AGENT_RELAY_WORKSPACE_KEY` > `RELAY_API_KEY`.
 * 3. `project` — the repository pin, `<project>/.agentworkforce/relay/workspace-key.json`.
 * 4. `store`   — the machine-global active entry in `~/.agentworkforce/relay/workspaces.json`.
 * 5. nothing resolves — the caller decides (the broker mints a new workspace).
 *
 * The repository pin always outranks the machine-global active entry: a global
 * selection must never silently re-home a checkout that pinned a workspace. A
 * Fleet enrollment / node token selects the node's *identity*, never its
 * workspace, so it does not appear on this ladder at all.
 */
export function resolveWorkspaceSelection(
  options: ResolveWorkspaceKeyOptions = {}
): WorkspaceSelection | undefined {
  const env = options.env ?? process.env;
  const dataDir = options.projectDataDir ?? projectDataDir(options.projectRoot);
  const project = dataDir ? readProjectWorkspaceSession(dataDir, options.fileSystem ?? fs) : undefined;
  const flag = trimOrUndefined(options.workspaceKey);
  if (flag) {
    return {
      key: flag,
      source: 'flag',
      origin: '--workspace-key',
      ...(project?.workspaceKey === flag && project.workspaceId ? { workspaceId: project.workspaceId } : {}),
      ...(project?.workspaceKey === flag && project.relaycastRoute
        ? { relaycastRoute: project.relaycastRoute }
        : {}),
      ...(project?.workspaceKey === flag && project.relaycastBaseUrl
        ? { relaycastBaseUrl: project.relaycastBaseUrl }
        : {}),
      ...(project?.workspaceKey === flag && project.relaycastApiKey
        ? { relaycastApiKey: project.relaycastApiKey }
        : {}),
      ...((!project || project.workspaceKey === flag) && dataDir
        ? { projectDataDir: dataDir, projectSessionPresent: project !== undefined }
        : {}),
    };
  }

  for (const name of WORKSPACE_KEY_ENV_VARS) {
    const envKey = trimOrUndefined(env[name]);
    if (envKey) {
      return {
        key: envKey,
        source: 'env',
        origin: `$${name}`,
        ...(project?.workspaceKey === envKey && project.workspaceId
          ? { workspaceId: project.workspaceId }
          : {}),
        ...(project?.workspaceKey === envKey && project.relaycastRoute
          ? { relaycastRoute: project.relaycastRoute }
          : {}),
        ...(project?.workspaceKey === envKey && project.relaycastBaseUrl
          ? { relaycastBaseUrl: project.relaycastBaseUrl }
          : {}),
        ...(project?.workspaceKey === envKey && project.relaycastApiKey
          ? { relaycastApiKey: project.relaycastApiKey }
          : {}),
        ...((!project || project.workspaceKey === envKey) && dataDir
          ? { projectDataDir: dataDir, projectSessionPresent: project !== undefined }
          : {}),
      };
    }
  }

  if (project) {
    return {
      key: project.workspaceKey,
      source: 'project',
      origin: projectWorkspaceKeyPath(dataDir as string),
      ...(project.workspaceId ? { workspaceId: project.workspaceId } : {}),
      ...(project.relaycastRoute ? { relaycastRoute: project.relaycastRoute } : {}),
      ...(project.relaycastBaseUrl ? { relaycastBaseUrl: project.relaycastBaseUrl } : {}),
      ...(project.relaycastApiKey ? { relaycastApiKey: project.relaycastApiKey } : {}),
      ...(dataDir ? { projectDataDir: dataDir, projectSessionPresent: true } : {}),
    };
  }

  return resolveActiveWorkspaceSelection(env);
}

/**
 * Step 4 of {@link resolveWorkspaceSelection} on its own: the machine-global
 * active workspace.
 *
 * Exposed separately for callers that inject their own file system for the
 * higher (repository-pin) steps and must not re-read the pin through `node:fs`.
 * It is never correct to consult this ahead of steps 1–3.
 */
export function resolveActiveWorkspaceSelection(
  env: NodeJS.ProcessEnv = process.env
): WorkspaceSelection | undefined {
  const store = readWorkspaceStore(env);
  const activeName = trimOrUndefined(store.active);
  const storeKey = activeName ? trimOrUndefined(store.workspaces[activeName]?.key) : undefined;
  return storeKey
    ? {
        key: storeKey,
        source: 'store',
        origin: `${workspaceStorePath(env)} (active: "${activeName}")`,
      }
    : undefined;
}

/** Resolve the selected workspace key and its source. See {@link resolveWorkspaceSelection}. */
export function resolveWorkspaceKeyWithSource(
  options: ResolveWorkspaceKeyOptions = {}
): { key: string; source: WorkspaceKeySource } | undefined {
  const selection = resolveWorkspaceSelection(options);
  return selection ? { key: selection.key, source: selection.source } : undefined;
}

/** Resolve only the selected workspace key while preserving the shared precedence rules. */
export function resolveWorkspaceKey(options: ResolveWorkspaceKeyOptions = {}): string | undefined {
  return resolveWorkspaceKeyWithSource(options)?.key;
}

function projectDataDir(projectRoot: string | undefined): string | undefined {
  try {
    return getProjectPaths(projectRoot).dataDir;
  } catch {
    return undefined;
  }
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
