import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getProjectPaths } from '@agent-relay/config';

import { resolveActiveWorkspaceKey } from './workspace-store.js';

const PROJECT_WORKSPACE_KEY_FILENAME = 'workspace-key.json';

interface ProjectWorkspaceKeyFile {
  workspaceKey: string;
}

export type WorkspaceKeySource = 'flag' | 'env' | 'project' | 'store';

export interface ResolveWorkspaceKeyOptions {
  workspaceKey?: string;
  env?: NodeJS.ProcessEnv;
  /** Project root whose local broker workspace should be preferred. Defaults to the current project. */
  projectRoot?: string;
  /** Explicit project Relay data directory. Takes precedence over projectRoot. */
  projectDataDir?: string;
}

/** Absolute path to the workspace key recorded by `agent-relay node up`. */
export function projectWorkspaceKeyPath(dataDir: string): string {
  return path.join(dataDir, PROJECT_WORKSPACE_KEY_FILENAME);
}

/** Read a project broker's workspace key, falling through on absent or malformed state. */
export function readProjectWorkspaceKey(dataDir: string): string | undefined {
  try {
    const raw = fs.readFileSync(projectWorkspaceKeyPath(dataDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ProjectWorkspaceKeyFile>;
    return trimOrUndefined(parsed.workspaceKey);
  } catch {
    return undefined;
  }
}

/**
 * Persist the project broker's workspace key atomically with owner-only permissions.
 * A blank key never clobbers a previously recorded workspace.
 */
export function writeProjectWorkspaceKey(dataDir: string, workspaceKey: string | undefined): void {
  const key = trimOrUndefined(workspaceKey);
  if (!key) return;
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = projectWorkspaceKeyPath(dataDir);
  // Worker threads share a PID, so include a per-write nonce as well as the PID.
  const tmp = `${file}.tmp.${process.pid}.${randomUUID()}`;
  const data = `${JSON.stringify({ workspaceKey: key } satisfies ProjectWorkspaceKeyFile, null, 2)}\n`;

  let fd: number;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    fs.rmSync(tmp, { force: true });
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
 * Resolve the Relay workspace used by SDK clients. The project-local key comes
 * before the machine-global active workspace so a process addresses the same
 * workspace as the broker and fleet node running in that checkout.
 */
export function resolveWorkspaceKeyWithSource(
  options: ResolveWorkspaceKeyOptions = {}
): { key: string; source: WorkspaceKeySource } | undefined {
  const env = options.env ?? process.env;
  const flag = trimOrUndefined(options.workspaceKey);
  if (flag) return { key: flag, source: 'flag' };

  const envKey =
    trimOrUndefined(env.RELAY_WORKSPACE_KEY) ??
    trimOrUndefined(env.AGENT_RELAY_WORKSPACE_KEY) ??
    trimOrUndefined(env.RELAY_API_KEY);
  if (envKey) return { key: envKey, source: 'env' };

  const dataDir = options.projectDataDir ?? projectDataDir(options.projectRoot);
  const project = dataDir ? readProjectWorkspaceKey(dataDir) : undefined;
  if (project) return { key: project, source: 'project' };

  const store = trimOrUndefined(resolveActiveWorkspaceKey(env));
  return store ? { key: store, source: 'store' } : undefined;
}

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
