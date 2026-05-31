import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Local store of named workspace keys plus which one is active. Backs the
 * `relay workspace set_key/switch/list` commands and provides a fallback key
 * for SDK-backed commands when no env var or flag is supplied.
 */
export interface WorkspaceStore {
  active?: string;
  workspaces: Record<string, { key: string }>;
}

export function workspaceStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.AGENT_RELAY_HOME ?? path.join(os.homedir(), '.agentworkforce');
  return path.join(dir, 'workspaces.json');
}

export function readWorkspaceStore(env: NodeJS.ProcessEnv = process.env): WorkspaceStore {
  const file = workspaceStorePath(env);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<WorkspaceStore>;
    return { active: parsed.active, workspaces: parsed.workspaces ?? {} };
  } catch {
    return { workspaces: {} };
  }
}

export function writeWorkspaceStore(store: WorkspaceStore, env: NodeJS.ProcessEnv = process.env): void {
  const file = workspaceStorePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
}

export function setWorkspaceKey(
  name: string,
  key: string,
  env: NodeJS.ProcessEnv = process.env
): WorkspaceStore {
  const store = readWorkspaceStore(env);
  store.workspaces[name] = { key };
  store.active ??= name;
  writeWorkspaceStore(store, env);
  return store;
}

export function switchWorkspace(name: string, env: NodeJS.ProcessEnv = process.env): WorkspaceStore {
  const store = readWorkspaceStore(env);
  if (!store.workspaces[name]) {
    throw new Error(`Unknown workspace "${name}". Add it with \`relay workspace set_key ${name} <key>\`.`);
  }
  store.active = name;
  writeWorkspaceStore(store, env);
  return store;
}

export function activeWorkspaceKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const store = readWorkspaceStore(env);
  return store.active ? store.workspaces[store.active]?.key : undefined;
}
