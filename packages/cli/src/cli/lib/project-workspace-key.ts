import fs from 'node:fs';
import path from 'node:path';

/**
 * Project-local record of the workspace key the broker in this directory was
 * started with. `agent-relay up` writes it into the project data dir
 * (`.agentworkforce/relay/`, the same git-excluded directory that holds
 * `connection.json`) so that later SDK-backed commands run in the same CWD
 * (`fleet nodes`, `node …`, etc.) resolve the workspace the local broker
 * actually joined — rather than falling through to the machine-global active
 * workspace, which may point at a different workspace.
 */
const PROJECT_WORKSPACE_KEY_FILENAME = 'workspace-key.json';

interface ProjectWorkspaceKeyFile {
  workspaceKey: string;
}

/** Absolute path to the project-local workspace-key file within `dataDir`. */
export function projectWorkspaceKeyPath(dataDir: string): string {
  return path.join(dataDir, PROJECT_WORKSPACE_KEY_FILENAME);
}

/**
 * Read the workspace key recorded for this project's data dir. A missing or
 * malformed file (or a blank key) reads as `undefined` — the caller falls
 * through to the next resolution source rather than failing.
 */
export function readProjectWorkspaceKey(dataDir: string): string | undefined {
  try {
    const raw = fs.readFileSync(projectWorkspaceKeyPath(dataDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ProjectWorkspaceKeyFile>;
    const key = typeof parsed.workspaceKey === 'string' ? parsed.workspaceKey.trim() : '';
    return key || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist the workspace key for this project's data dir with owner-only
 * permissions (matching `connection.json`). A blank key is ignored so a broker
 * that never resolved a key does not clobber a previously recorded one.
 */
export function writeProjectWorkspaceKey(dataDir: string, workspaceKey: string | undefined): void {
  const key = workspaceKey?.trim();
  if (!key) return;
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = projectWorkspaceKeyPath(dataDir);
  const payload: ProjectWorkspaceKeyFile = { workspaceKey: key };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
