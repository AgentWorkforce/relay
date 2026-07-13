import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Local store of named workspace keys plus which one is active. This is the
 * canonical Agent Relay workspace pin consumed by cloud, workforce, and
 * relayfile integrations.
 */
export interface WorkspaceStore {
  active?: string;
  workspaces: Record<string, { key: string }>;
}

const RESERVED_WORKSPACE_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

export function workspaceStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.AGENT_RELAY_HOME ?? path.join(os.homedir(), '.agentworkforce/relay');
  return path.join(dir, 'workspaces.json');
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
    return { active: parsed.active, workspaces: parsed.workspaces ?? {} };
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
