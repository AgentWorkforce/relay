import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function makeDirectoriesWritable(root) {
  try {
    await chmod(root, 0o700);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink())
      await makeDirectoriesWritable(path.join(root, entry.name));
  }
}

export async function withTemporaryGoModuleCache(run) {
  const goModCache = await mkdtemp(path.join(os.tmpdir(), 'relayfile-qualification-go-mod-'));
  try {
    return await run(goModCache);
  } finally {
    // Go module downloads are read-only by default. Restore owner write
    // permission before removal so cleanup works on both macOS and Linux.
    await makeDirectoriesWritable(goModCache);
    await rm(goModCache, { recursive: true, force: true });
  }
}
