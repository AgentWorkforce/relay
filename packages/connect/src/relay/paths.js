import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';

/** Where the Node relay keeps its state, socket, log and runtime copy. */
export function relayPaths(home = os.homedir()) {
  const root = join(home, '.agentworkforce/connect');
  return {
    root,
    state: join(root, 'state.json'),
    run: join(root, 'run'),
    socket: join(root, 'run/connect.sock'),
    lock: join(root, 'run/daemon.lock'),
    log: join(root, 'daemon.log'),
    runtime: join(root, 'runtime'),
  };
}

/** Creates `path` as a 0700 directory this user owns, or refuses. */
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  const uid = process.getuid?.();
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) {
    throw new Error(`${path} must be a directory this user owns.`);
  }
  if ((info.mode & 0o077) !== 0) await chmod(path, 0o700);
}

/** Writes `text` to `path` with mode 0600: temp file, fsync, rename, fsync the directory. */
export async function writeAtomic(path, text) {
  const directory = dirname(path);
  await privateDirectory(directory);
  const temporary = join(directory, `.${process.pid}.${Date.now()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const directoryHandle = await open(directory, constants.O_RDONLY).catch(() => null);
  if (directoryHandle) {
    await directoryHandle.sync().catch(() => {});
    await directoryHandle.close();
  }
}
