import fs from 'node:fs';
import path from 'node:path';

/**
 * Owner-only token files for handing an existing agent identity to another
 * command without printing it. The token never appears in stdout, stderr, or
 * process arguments; only the path does.
 */

const OWNER_ONLY_MODE = 0o600;

export interface WriteAgentTokenFileOptions {
  /** Replace an existing regular file. Symlinks and non-files are always refused. */
  force?: boolean;
}

/** Write `token` to a new `0600` file. Returns the absolute path written. */
export function writeAgentTokenFile(
  filePath: string,
  token: string,
  options: WriteAgentTokenFileOptions = {}
): string {
  const target = path.resolve(filePath);
  let existing: fs.Stats | undefined;
  try {
    existing = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing) {
    if (!existing.isFile()) {
      throw new Error(`Refusing to write the agent token to ${target}: it exists and is not a regular file.`);
    }
    if (!options.force) {
      throw new Error(
        `Refusing to overwrite ${target}: it already exists. Pass --force to replace it, or choose a new path.`
      );
    }
    fs.unlinkSync(target);
  }

  // `wx` fails if something re-created the path after the unlink above, so a
  // raced symlink can never redirect the write.
  const fd = fs.openSync(target, 'wx', OWNER_ONLY_MODE);
  try {
    fs.writeSync(fd, `${token}\n`);
    // The create mode is filtered by the umask; set it explicitly as well.
    if (process.platform !== 'win32') fs.fchmodSync(fd, OWNER_ONLY_MODE);
  } finally {
    fs.closeSync(fd);
  }
  return target;
}

/** Read a token written by {@link writeAgentTokenFile}, refusing group/world-readable files. */
export function readAgentTokenFile(filePath: string): string {
  const target = path.resolve(filePath);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Agent token file ${target} does not exist.`, { cause: error });
    }
    throw error;
  }
  if (!stats.isFile()) {
    throw new Error(`Agent token file ${target} is not a regular file.`);
  }
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new Error(
      `Agent token file ${target} is readable by other users; run "chmod 600" on it before using it.`
    );
  }
  const token = fs.readFileSync(target, 'utf8').trim();
  if (!token) {
    throw new Error(`Agent token file ${target} is empty.`);
  }
  return token;
}
