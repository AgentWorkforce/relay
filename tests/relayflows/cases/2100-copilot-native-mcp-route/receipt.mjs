import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { externalPath } from './guards.mjs';

/** Fresh, exclusive, handle-bound receipt in the wrapper's private single-writer directory. */
export async function createReceipt(resultPath, roots) {
  assert.equal(await externalPath(resultPath, roots, 'Receipt'), resultPath, 'Receipt destination changed.');
  const parent = path.dirname(resultPath);
  await mkdir(parent, { recursive: true });
  assert.equal(await realpath(parent), parent, 'Receipt parent changed.');
  const parentIdentity = await stat(parent, { bigint: true });
  const handle = await open(
    resultPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600
  );
  let identity;
  /** Refuse a moved parent or replaced file before accepting this handle's output. */
  async function requireBoundDestination() {
    assert.equal(
      await externalPath(resultPath, roots, 'Receipt'),
      resultPath,
      'Receipt destination changed.'
    );
    const currentParent = await stat(parent, { bigint: true }),
      currentFile = await lstat(resultPath, { bigint: true });
    assert(
      currentParent.dev === parentIdentity.dev && currentParent.ino === parentIdentity.ino,
      'Receipt parent changed.'
    );
    assert(
      currentFile.isFile() &&
        !currentFile.isSymbolicLink() &&
        currentFile.dev === identity.dev &&
        currentFile.ino === identity.ino,
      'Receipt file changed.'
    );
  }
  try {
    identity = await handle.stat({ bigint: true });
    assert(identity.isFile(), 'Receipt must be a regular file.');
    await requireBoundDestination();
  } catch (error) {
    await handle.close();
    throw error;
  }
  return {
    async write(text) {
      await requireBoundDestination();
      // The open inode stays the destination even if a parent pathname moves.
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      await requireBoundDestination();
    },
    close: () => handle.close(),
  };
}
