import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';

function identity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameIdentity(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

async function openNoFollow(target, flags, label) {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== 'number' || noFollow === 0) {
    throw new Error(`${label} cannot be opened safely: this platform does not support O_NOFOLLOW`);
  }

  try {
    return await open(target, flags | noFollow);
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new Error(`${label} must not be a symbolic link`, { cause: error });
    }
    throw error;
  }
}

/**
 * Read one exact regular-file inode without following a final symlink.
 * Metadata is checked on the same descriptor before and after the read so a
 * path replacement or concurrent mutation fails closed.
 */
export async function readRegularFileNoFollow(
  target,
  { label = 'file', maxBytes, privateMode = false, currentUserOwned = false } = {}
) {
  const handle = await openNoFollow(target, fsConstants.O_RDONLY, label);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    const size = Number(before.size);
    const mode = Number(before.mode & 0o777n);
    const uid = Number(before.uid);
    if (!Number.isSafeInteger(size) || size < 0 || (maxBytes !== undefined && size > maxBytes)) {
      throw new Error(`${label} has an invalid or excessive size`);
    }
    if (privateMode && (mode & 0o077) !== 0) {
      throw new Error(`${label} must be a private regular file`);
    }
    if (currentUserOwned && typeof process.getuid === 'function' && uid !== process.getuid()) {
      throw new Error(`${label} must be owned by the current user`);
    }
    const beforeIdentity = identity(before);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(beforeIdentity, identity(after)) || BigInt(bytes.length) !== after.size) {
      throw new Error(`${label} changed while it was read`);
    }
    return { bytes, mode, uid, size };
  } finally {
    await handle.close();
  }
}

/** Overwrite an existing regular file through one no-follow descriptor. */
export async function overwriteRegularFileNoFollow(
  target,
  value,
  { label = 'file', mode = 0o600, currentUserOwned = false } = {}
) {
  const handle = await openNoFollow(target, fsConstants.O_WRONLY, label);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new Error(`${label} must be a regular file`);
    if (currentUserOwned && typeof process.getuid === 'function' && Number(info.uid) !== process.getuid()) {
      throw new Error(`${label} must be owned by the current user`);
    }
    await handle.truncate(0);
    await handle.writeFile(value);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
