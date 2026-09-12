import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getProjectPaths } from '@agent-relay/config';

import {
  readRelaycastCredential,
  readWorkspaceStore,
  relaycastCredentialRef,
  relaycastCredentialStorePath,
  writeRelaycastCredential,
  workspaceStorePath,
} from './workspace-store.js';

const PROJECT_WORKSPACE_KEY_FILENAME = 'workspace-key.json';
const PROJECT_WORKSPACE_LOCK_SUFFIX = '.lock';
const PROJECT_WORKSPACE_LOCK_TIMEOUT_MS = 2_000;
const PROJECT_WORKSPACE_LOCK_STALE_MS = 30_000;
const PROJECT_WORKSPACE_LOCK_RETRY_MS = 10;
const PROJECT_WORKSPACE_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const PROJECT_WORKSPACE_LOCK_OWNER_VERSION = 1;

interface ProjectWorkspaceLockOwner {
  version: number;
  pid: number;
  token: string;
}

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
  /** Reference to a machine-local route credential; never contains key material. */
  relaycastApiKeyRef?: string;
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
  relaycastApiKeyRef?: string;
  /** Project session directory that can durably carry a server-selected target. */
  projectDataDir?: string;
  /** Whether that project session existed when this selection was captured. */
  projectSessionPresent?: boolean;
  /** Machine credential home used for route credentials; never contains key material. */
  credentialHome?: string;
}

/** Absolute path to the workspace key recorded by `agent-relay node up`. */
export function projectWorkspaceKeyPath(dataDir: string): string {
  return path.join(dataDir, PROJECT_WORKSPACE_KEY_FILENAME);
}

/** Read a project broker's workspace key, falling through on absent or malformed state. */
export function readProjectWorkspaceKey(
  dataDir: string,
  fileSystem: WorkspaceKeyFileSystem = fs,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return readProjectWorkspaceSession(dataDir, fileSystem, env)?.workspaceKey;
}

/** Read the project workspace and its optional enrolled Fleet identity. */
export function readProjectWorkspaceSession(
  dataDir: string,
  fileSystem: WorkspaceKeyFileSystem = fs,
  env: NodeJS.ProcessEnv = process.env
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
    const relaycastApiKeyRef = trimOrUndefined(parsed.relaycastApiKeyRef);
    const legacyApiKey = trimOrUndefined(parsed.relaycastApiKey);
    const expectedRef =
      workspaceId && relaycastRoute && relaycastBaseUrl
        ? relaycastCredentialRef(dataDir, workspaceId, relaycastRoute, relaycastBaseUrl)
        : undefined;
    const storedCredential =
      relaycastApiKeyRef && expectedRef === relaycastApiKeyRef
        ? readRelaycastCredential(relaycastApiKeyRef, env)
        : undefined;
    const relaycastApiKey = relaycastApiKeyRef
      ? storedCredential &&
        storedCredential.workspaceId === workspaceId &&
        storedCredential.route === relaycastRoute &&
        storedCredential.baseUrl === relaycastBaseUrl
        ? storedCredential.apiKey
        : undefined
      : legacyApiKey;
    return {
      workspaceKey,
      ...(enrolledNodeId ? { enrolledNodeId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(relaycastRoute ? { relaycastRoute } : {}),
      ...(relaycastBaseUrl ? { relaycastBaseUrl } : {}),
      ...(relaycastApiKey ? { relaycastApiKey } : {}),
      ...(relaycastApiKeyRef ? { relaycastApiKeyRef } : {}),
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
  options: ProjectWorkspaceSessionMetadata & { env?: NodeJS.ProcessEnv } = {}
): void {
  const key = trimOrUndefined(workspaceKey);
  if (!key) return;
  const { env, ...metadata } = options;
  withProjectWorkspaceKeyLock(dataDir, () => writeProjectWorkspaceKeyUnlocked(dataDir, key, metadata, env));
}

function writeProjectWorkspaceKeyUnlocked(
  dataDir: string,
  workspaceKey: string,
  options: ProjectWorkspaceSessionMetadata = {},
  credentialEnv: NodeJS.ProcessEnv = process.env
): void {
  const key = trimOrUndefined(workspaceKey);
  if (!key) return;
  const enrolledNodeId = trimOrUndefined(options.enrolledNodeId);
  const workspaceId = trimOrUndefined(options.workspaceId);
  const relaycastRoute = options.relaycastRoute;
  const relaycastBaseUrl = trimOrUndefined(options.relaycastBaseUrl);
  const relaycastApiKey = trimOrUndefined(options.relaycastApiKey);
  let relaycastApiKeyRef = trimOrUndefined(options.relaycastApiKeyRef);
  if (relaycastApiKey && workspaceId && relaycastRoute && relaycastBaseUrl) {
    relaycastApiKeyRef = relaycastCredentialRef(dataDir, workspaceId, relaycastRoute, relaycastBaseUrl);
    writeRelaycastCredential(
      relaycastApiKeyRef,
      {
        workspaceId,
        route: relaycastRoute,
        baseUrl: relaycastBaseUrl,
        apiKey: relaycastApiKey,
      },
      credentialEnv
    );
  }
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
      // Route credentials are always externalized above. Never serialize a
      // raw Relaycast key into repository metadata, even for incomplete input.
      ...(relaycastApiKeyRef ? { relaycastApiKeyRef } : {}),
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

function withProjectWorkspaceKeyLock<T>(dataDir: string, callback: () => T): T {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockDir = `${projectWorkspaceKeyPath(dataDir)}${PROJECT_WORKSPACE_LOCK_SUFFIX}`;
  const ownerToken = randomUUID();
  const ownerPath = path.join(lockDir, ownerToken);
  const startedAt = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      try {
        // The token is a child of this lock directory, so a stale holder can
        // release only its own marker even if another writer has already
        // removed and reacquired the directory.
        fs.writeFileSync(
          ownerPath,
          JSON.stringify({
            version: PROJECT_WORKSPACE_LOCK_OWNER_VERSION,
            pid: process.pid,
            token: ownerToken,
          }),
          { mode: 0o600, flag: 'wx' }
        );
      } catch (error) {
        // mkdir succeeded, but this invocation never acquired a usable lock.
        // Clean up only the directory it just created before propagating.
        fs.rmSync(ownerPath, { force: true });
        try {
          fs.rmdirSync(lockDir);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError;
        }
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    try {
      if (Date.now() - fs.statSync(lockDir).mtimeMs >= PROJECT_WORKSPACE_LOCK_STALE_MS) {
        const observedLock = inspectProjectWorkspaceLock(lockDir);
        if (!observedLock.ownerIsAlive) {
          // Reclaim only the exact marker entries observed in this lock. A
          // replacement writer can add a different marker concurrently; the
          // non-recursive rmdir then leaves that replacement lock untouched.
          for (const entry of observedLock.entries) {
            fs.rmSync(path.join(lockDir, entry), { force: true });
          }
          try {
            fs.rmdirSync(lockDir);
          } catch (error) {
            if (
              (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
              (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY'
            ) {
              throw error;
            }
          }
          continue;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (Date.now() - startedAt >= PROJECT_WORKSPACE_LOCK_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for the project workspace lock at ${lockDir}.`);
    }
    Atomics.wait(PROJECT_WORKSPACE_LOCK_WAIT, 0, 0, PROJECT_WORKSPACE_LOCK_RETRY_MS);
  }
  let callbackFailed = false;
  try {
    return callback();
  } catch (error) {
    callbackFailed = true;
    throw error;
  } finally {
    // Remove our marker first. If the lock was declared stale and replaced
    // while the callback was running, the replacement marker is different;
    // rmdir then safely leaves the replacement lock in place.
    if (fs.existsSync(ownerPath)) {
      fs.rmSync(ownerPath, { force: true });
      try {
        fs.rmdirSync(lockDir);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
          (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY'
        ) {
          if (callbackFailed) {
            console.error(`Failed to release the project workspace lock at ${lockDir}.`, error);
          } else {
            throw error;
          }
        }
      }
    }
  }
}

function inspectProjectWorkspaceLock(lockDir: string): {
  entries: string[];
  ownerIsAlive: boolean;
} {
  const entries = fs.readdirSync(lockDir);
  let sawLiveOwner = false;
  for (const entry of entries) {
    let owner: Partial<ProjectWorkspaceLockOwner>;
    try {
      owner = JSON.parse(
        fs.readFileSync(path.join(lockDir, entry), 'utf8')
      ) as Partial<ProjectWorkspaceLockOwner>;
    } catch {
      continue;
    }
    const pid = owner.pid;
    if (
      owner.version !== PROJECT_WORKSPACE_LOCK_OWNER_VERSION ||
      typeof pid !== 'number' ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      typeof owner.token !== 'string' ||
      owner.token !== entry
    ) {
      continue;
    }
    try {
      process.kill(pid, 0);
      sawLiveOwner = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // EPERM means the process exists but is not signalable. Treat all
      // errors other than ESRCH conservatively as alive.
      if (code !== 'ESRCH') sawLiveOwner = true;
    }
  }
  return { entries, ownerIsAlive: sawLiveOwner };
}

/** Atomically persist a Relaycast target only if the captured project selection is still current. */
export function writeProjectWorkspaceTargetIfSelectionCurrent(
  dataDir: string,
  selection: WorkspaceSelection,
  target: Required<
    Pick<ProjectWorkspaceSession, 'workspaceId' | 'relaycastRoute' | 'relaycastBaseUrl' | 'relaycastApiKey'>
  >
): boolean {
  const credentialEnv = selection.credentialHome
    ? { AGENT_RELAY_HOME: selection.credentialHome }
    : process.env;
  return withProjectWorkspaceKeyLock(dataDir, () => {
    const current = readProjectWorkspaceSession(dataDir, fs, credentialEnv);
    if (selection.projectSessionPresent === false && current) return false;
    if (
      current &&
      (current.workspaceKey !== selection.key ||
        current.workspaceId !== selection.workspaceId ||
        current.relaycastRoute !== selection.relaycastRoute ||
        current.relaycastBaseUrl !== selection.relaycastBaseUrl ||
        current.relaycastApiKey !== selection.relaycastApiKey ||
        current.relaycastApiKeyRef !== selection.relaycastApiKeyRef)
    ) {
      return false;
    }
    if (!current && (selection.projectSessionPresent === true || selection.source === 'project')) {
      return false;
    }
    const credentialRef = relaycastCredentialRef(
      dataDir,
      target.workspaceId,
      target.relaycastRoute,
      target.relaycastBaseUrl
    );
    writeRelaycastCredential(
      credentialRef,
      {
        workspaceId: target.workspaceId,
        route: target.relaycastRoute,
        baseUrl: target.relaycastBaseUrl,
        apiKey: target.relaycastApiKey,
      },
      credentialEnv
    );
    writeProjectWorkspaceKeyUnlocked(
      dataDir,
      selection.key,
      {
        ...(current?.enrolledNodeId ? { enrolledNodeId: current.enrolledNodeId } : {}),
        workspaceId: target.workspaceId,
        relaycastRoute: target.relaycastRoute,
        relaycastBaseUrl: target.relaycastBaseUrl,
        relaycastApiKeyRef: credentialRef,
      },
      credentialEnv
    );
    return true;
  });
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
  options: ProjectWorkspaceSessionMetadata & { env?: NodeJS.ProcessEnv } = {}
): void {
  const key = trimOrUndefined(workspaceKey);
  if (!key) return;

  const { env: credentialEnv, ...metadata } = options;
  withProjectWorkspaceKeyLock(dataDir, () => {
    const existing = readProjectWorkspaceSession(dataDir, fs, credentialEnv);
    const sameWorkspace = existing?.workspaceKey === key;
    const retained: ProjectWorkspaceSessionMetadata = sameWorkspace
      ? {
          ...(existing?.enrolledNodeId ? { enrolledNodeId: existing.enrolledNodeId } : {}),
          ...(existing?.workspaceId ? { workspaceId: existing.workspaceId } : {}),
          ...(existing?.relaycastRoute ? { relaycastRoute: existing.relaycastRoute } : {}),
          ...(existing?.relaycastBaseUrl ? { relaycastBaseUrl: existing.relaycastBaseUrl } : {}),
          ...(existing?.relaycastApiKey ? { relaycastApiKey: existing.relaycastApiKey } : {}),
          ...(existing?.relaycastApiKeyRef ? { relaycastApiKeyRef: existing.relaycastApiKeyRef } : {}),
        }
      : {};

    writeProjectWorkspaceKeyUnlocked(
      dataDir,
      key,
      {
        ...retained,
        ...(trimOrUndefined(metadata.enrolledNodeId)
          ? { enrolledNodeId: trimOrUndefined(metadata.enrolledNodeId) }
          : {}),
        ...(trimOrUndefined(metadata.workspaceId)
          ? { workspaceId: trimOrUndefined(metadata.workspaceId) }
          : {}),
        ...(metadata.relaycastRoute ? { relaycastRoute: metadata.relaycastRoute } : {}),
        ...(trimOrUndefined(metadata.relaycastBaseUrl)
          ? { relaycastBaseUrl: trimOrUndefined(metadata.relaycastBaseUrl) }
          : {}),
        ...(trimOrUndefined(metadata.relaycastApiKey)
          ? { relaycastApiKey: trimOrUndefined(metadata.relaycastApiKey) }
          : {}),
        ...(trimOrUndefined(metadata.relaycastApiKeyRef)
          ? { relaycastApiKeyRef: trimOrUndefined(metadata.relaycastApiKeyRef) }
          : {}),
      },
      credentialEnv
    );
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
  const credentialHome = path.resolve(path.dirname(relaycastCredentialStorePath(env)));
  const credentialHomeSelection = { credentialHome };
  const dataDir = options.projectDataDir ?? projectDataDir(options.projectRoot);
  const project = dataDir ? readProjectWorkspaceSession(dataDir, options.fileSystem ?? fs, env) : undefined;
  const flag = trimOrUndefined(options.workspaceKey);
  if (flag) {
    return {
      key: flag,
      source: 'flag',
      origin: '--workspace-key',
      ...credentialHomeSelection,
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
      ...(project?.workspaceKey === flag && project.relaycastApiKeyRef
        ? { relaycastApiKeyRef: project.relaycastApiKeyRef }
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
        ...credentialHomeSelection,
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
        ...(project?.workspaceKey === envKey && project.relaycastApiKeyRef
          ? { relaycastApiKeyRef: project.relaycastApiKeyRef }
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
      ...credentialHomeSelection,
      ...(project.workspaceId ? { workspaceId: project.workspaceId } : {}),
      ...(project.relaycastRoute ? { relaycastRoute: project.relaycastRoute } : {}),
      ...(project.relaycastBaseUrl ? { relaycastBaseUrl: project.relaycastBaseUrl } : {}),
      ...(project.relaycastApiKey ? { relaycastApiKey: project.relaycastApiKey } : {}),
      ...(project.relaycastApiKeyRef ? { relaycastApiKeyRef: project.relaycastApiKeyRef } : {}),
      ...(dataDir ? { projectDataDir: dataDir, projectSessionPresent: true } : {}),
    };
  }

  return resolveActiveWorkspaceSelection(env, dataDir);
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
  env: NodeJS.ProcessEnv = process.env,
  projectDataDir?: string
): WorkspaceSelection | undefined {
  const store = readWorkspaceStore(env);
  const activeName = trimOrUndefined(store.active);
  const storeKey = activeName ? trimOrUndefined(store.workspaces[activeName]?.key) : undefined;
  return storeKey
    ? {
        key: storeKey,
        source: 'store',
        origin: `${workspaceStorePath(env)} (active: "${activeName}")`,
        credentialHome: path.resolve(path.dirname(relaycastCredentialStorePath(env))),
        ...(projectDataDir ? { projectDataDir, projectSessionPresent: false } : {}),
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
