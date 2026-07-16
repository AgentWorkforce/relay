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
 *
 * The write is atomic and symlink-safe: the payload is written to a fresh,
 * exclusively-created temp file (so a pre-planted symlink at the temp path
 * cannot redirect it) and then `rename`d over the destination. `rename` never
 * follows a symlink at the destination and is atomic on POSIX, so a concurrent
 * reader sees either the old or the new complete file — never a truncated one,
 * and never an attacker-chosen target.
 */
export function writeProjectWorkspaceKey(dataDir: string, workspaceKey: string | undefined): void {
  const key = workspaceKey?.trim();
  if (!key) return;
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = projectWorkspaceKeyPath(dataDir);
  const tmp = `${file}.tmp.${process.pid}`;
  const payload: ProjectWorkspaceKeyFile = { workspaceKey: key };
  const data = `${JSON.stringify(payload, null, 2)}\n`;

  // 'wx' == O_CREAT | O_EXCL: create a brand-new regular file, failing (rather
  // than following a symlink or truncating an existing file) if anything is
  // already at the temp path. A stale temp from a crashed run is removed first.
  let fd: number;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    fs.rmSync(tmp, { force: true });
    fd = fs.openSync(tmp, 'wx', 0o600);
  }
  try {
    try {
      fs.writeSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    // openSync's mode is masked by umask; enforce owner-only before publishing.
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    // Never leave a partial temp file behind, whichever step failed.
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
