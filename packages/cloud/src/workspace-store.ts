import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { assertWindowsCredentialDirectory } from './credential-directory-windows.js';

/**
 * Local store of named workspace keys plus which one is active. This is the
 * canonical Agent Relay workspace pin consumed by cloud, workforce, and
 * relayfile integrations.
 */
export interface WorkspaceStore {
  active?: string;
  /** Workspace that was active before the most recent named selection. */
  previous?: string;
  workspaces: Record<string, { key: string }>;
}

export interface RelaycastCredential {
  workspaceId: string;
  route: 'canonical' | 'agent37-isolated';
  baseUrl: string;
  apiKey: string;
}

const RESERVED_WORKSPACE_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

export function workspaceStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.AGENT_RELAY_HOME ?? path.join(os.homedir(), '.agentworkforce/relay');
  return path.join(dir, 'workspaces.json');
}

export function relaycastCredentialStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.AGENT_RELAY_HOME ?? path.join(os.homedir(), '.agentworkforce/relay');
  return path.join(dir, 'relaycast-credentials.json');
}

export function relaycastCredentialRef(
  projectDataDir: string,
  workspaceId: string,
  route: string,
  baseUrl?: string
): string {
  let endpoint = baseUrl?.trim() ?? '';
  try {
    endpoint = new URL(endpoint).origin;
  } catch {
    // The caller performs route-origin validation; retain a deterministic
    // value here for malformed legacy metadata and let that validation fail
    // closed at read/transport time.
  }
  return createHash('sha256')
    .update(`${path.resolve(projectDataDir)}\0${workspaceId}\0${route}\0${endpoint}`)
    .digest('hex');
}

export function readRelaycastCredential(
  ref: string,
  env: NodeJS.ProcessEnv = process.env
): RelaycastCredential | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(relaycastCredentialStorePath(env), 'utf8')) as {
      credentials?: Record<string, RelaycastCredential>;
    };
    const value = parsed.credentials?.[ref];
    if (!value || typeof value.apiKey !== 'string') return undefined;
    return value;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    return undefined;
  }
}

export function writeRelaycastCredential(
  ref: string,
  credential: RelaycastCredential,
  env: NodeJS.ProcessEnv = process.env
): void {
  const file = relaycastCredentialStorePath(env);
  withRelaycastCredentialLock(file, () => {
    let store: { credentials: Record<string, RelaycastCredential> } = { credentials: {} };
    try {
      store = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof store;
    } catch (error) {
      if (!(isNodeError(error) && error.code === 'ENOENT')) throw error;
    }
    store.credentials ??= {};
    store.credentials[ref] = credential;
    writeRelaycastCredentialAtomically(file, store);
  });
}

const RELAYCAST_CREDENTIAL_LOCK_TIMEOUT_MS = 10_000;
const RELAYCAST_CREDENTIAL_LOCK_STALE_MS = 30_000;
const RELAYCAST_CREDENTIAL_LOCK_RETRY_MS = 10;
const RELAYCAST_CREDENTIAL_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const RELAYCAST_CREDENTIAL_LOCK_OWNER_VERSION = 1;

interface RelaycastCredentialLockOwner {
  version: number;
  pid: number;
  token: string;
}

function assertRelaycastCredentialLockDirectory(lock: string): fs.Stats {
  const info = fs.lstatSync(lock);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Refusing to operate on a Relaycast credential lock that is not a real directory.');
  }
  return info;
}

function assertCredentialAncestors(directory: string): void {
  if (process.platform === 'win32') {
    assertWindowsCredentialDirectory(directory);
    return;
  }
  const uid = process.getuid?.();
  // Check both the supplied path and its canonical target. System-owned
  // aliases such as macOS /var -> /private/var remain usable, while neither
  // a foreign-owned ancestor nor a writable non-sticky parent can be swapped.
  for (const start of new Set([path.resolve(directory), fs.realpathSync(directory)])) {
    let current = start;
    while (true) {
      const info = fs.lstatSync(current);
      const trustedOwner = info.uid === uid || info.uid === 0;
      const sticky = (info.mode & 0o1000) !== 0;
      if (!trustedOwner || (!info.isSymbolicLink() && (info.mode & 0o022) !== 0 && !sticky)) {
        throw new Error(
          'Relaycast credential storage has an unsafe ancestor; choose a directory under your private home.'
        );
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
}

function withRelaycastCredentialLock<T>(file: string, fn: () => T): T {
  const directory = path.dirname(file);
  const lock = `${file}.lock`;
  const ownerToken = randomUUID();
  const ownerPath = path.join(lock, ownerToken);
  const startedAt = Date.now();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // The parent is the credential boundary: other users must not be able to
  // replace lock entries between inspection and cleanup.
  const directoryInfo = fs.lstatSync(directory);
  if (
    !directoryInfo.isDirectory() ||
    directoryInfo.isSymbolicLink() ||
    (process.platform !== 'win32' &&
      (directoryInfo.uid !== process.getuid?.() || (directoryInfo.mode & 0o022) !== 0))
  ) {
    throw new Error(
      'Relaycast credential storage requires a directory owned by the current user without group or other write permissions.'
    );
  }
  assertCredentialAncestors(directory);
  while (true) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      try {
        fs.writeFileSync(
          ownerPath,
          JSON.stringify({
            version: RELAYCAST_CREDENTIAL_LOCK_OWNER_VERSION,
            pid: process.pid,
            token: ownerToken,
          }),
          { mode: 0o600, flag: 'wx' }
        );
      } catch (error) {
        fs.rmSync(ownerPath, { force: true });
        try {
          fs.rmdirSync(lock);
        } catch (cleanupError) {
          if (!(isNodeError(cleanupError) && cleanupError.code === 'ENOENT')) throw cleanupError;
        }
        throw error;
      }
      break;
    } catch (error) {
      if (!(isNodeError(error) && error.code === 'EEXIST')) throw error;
    }
    try {
      if (
        Date.now() - assertRelaycastCredentialLockDirectory(lock).mtimeMs >=
        RELAYCAST_CREDENTIAL_LOCK_STALE_MS
      ) {
        const observedLock = inspectRelaycastCredentialLock(lock);
        if (!observedLock.ownerIsAlive) {
          for (const entry of observedLock.entries) {
            assertRelaycastCredentialLockDirectory(lock);
            fs.rmSync(path.join(lock, entry), { force: true });
          }
          try {
            assertRelaycastCredentialLockDirectory(lock);
            fs.rmdirSync(lock);
          } catch (error) {
            if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTEMPTY')) {
              continue;
            }
            throw error;
          }
          continue;
        }
      }
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') continue;
      throw error;
    }
    if (Date.now() - startedAt >= RELAYCAST_CREDENTIAL_LOCK_TIMEOUT_MS) {
      throw new Error('Timed out waiting for the Relaycast credential store lock.');
    }
    Atomics.wait(RELAYCAST_CREDENTIAL_LOCK_WAIT, 0, 0, RELAYCAST_CREDENTIAL_LOCK_RETRY_MS);
  }
  let callbackFailed = false;
  try {
    return fn();
  } catch (error) {
    callbackFailed = true;
    throw error;
  } finally {
    if (fs.existsSync(ownerPath)) {
      let cleanupError: unknown;
      try {
        fs.rmSync(ownerPath, { force: true });
        try {
          fs.rmdirSync(lock);
        } catch (error) {
          if (!(isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTEMPTY'))) {
            cleanupError = error;
          }
        }
      } catch (error) {
        cleanupError = error;
      }
      if (cleanupError && !callbackFailed) {
        throw cleanupError;
      }
    }
  }
}

function inspectRelaycastCredentialLock(lock: string): {
  entries: string[];
  ownerIsAlive: boolean;
} {
  assertRelaycastCredentialLockDirectory(lock);
  const entries = fs.readdirSync(lock);
  let sawLiveOwner = false;
  for (const entry of entries) {
    let owner: Partial<RelaycastCredentialLockOwner>;
    try {
      owner = JSON.parse(
        fs.readFileSync(path.join(lock, entry), 'utf8')
      ) as Partial<RelaycastCredentialLockOwner>;
    } catch {
      continue;
    }
    const pid = owner.pid;
    if (
      owner.version !== RELAYCAST_CREDENTIAL_LOCK_OWNER_VERSION ||
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
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') sawLiveOwner = true;
    }
  }
  return { entries, ownerIsAlive: sawLiveOwner };
}

function writeRelaycastCredentialAtomically(
  file: string,
  store: { credentials: Record<string, RelaycastCredential> }
): void {
  const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeSync(descriptor, `${JSON.stringify(store, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if (!(isNodeError(cleanupError) && cleanupError.code === 'ENOENT')) throw cleanupError;
    }
    throw error;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

export function validateWorkspaceName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Workspace name is required.');
  }
  if (RESERVED_WORKSPACE_NAMES.has(trimmed)) {
    throw new Error(`Invalid workspace name "${trimmed}".`);
  }
  return trimmed;
}

export function readWorkspaceStore(env: NodeJS.ProcessEnv = process.env): WorkspaceStore {
  const file = workspaceStorePath(env);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<WorkspaceStore>;
    const previous = typeof parsed.previous === 'string' ? parsed.previous.trim() : '';
    return {
      active: parsed.active,
      ...(previous ? { previous } : {}),
      workspaces: parsed.workspaces ?? {},
    };
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return { workspaces: {} };
    }
    throw err;
  }
}

export function writeWorkspaceStore(store: WorkspaceStore, env: NodeJS.ProcessEnv = process.env): void {
  const file = workspaceStorePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function setWorkspaceKey(
  name: string,
  key: string,
  env: NodeJS.ProcessEnv = process.env
): WorkspaceStore {
  const workspaceName = validateWorkspaceName(name);
  const store = readWorkspaceStore(env);
  store.workspaces[workspaceName] = { key };
  store.active ??= workspaceName;
  writeWorkspaceStore(store, env);
  return store;
}

export function setActiveWorkspace(name: string, env: NodeJS.ProcessEnv = process.env): WorkspaceStore {
  const workspaceName = validateWorkspaceName(name);
  const store = readWorkspaceStore(env);
  if (!store.workspaces[workspaceName]) {
    throw new Error(
      `Unknown workspace "${workspaceName}". Add it with \`relay workspace set_key ${workspaceName} <key>\`.`
    );
  }
  if (store.active && store.active !== workspaceName) {
    store.previous = store.active;
  }
  store.active = workspaceName;
  writeWorkspaceStore(store, env);
  return store;
}

export const switchWorkspace = setActiveWorkspace;

export function resolveActiveWorkspaceKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const store = readWorkspaceStore(env);
  return store.active ? store.workspaces[store.active]?.key : undefined;
}

export const activeWorkspaceKey = resolveActiveWorkspaceKey;
