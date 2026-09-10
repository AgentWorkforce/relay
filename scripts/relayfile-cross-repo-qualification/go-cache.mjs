import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function withTemporaryGoModuleCache(run) {
  const goModCache = await mkdtemp(path.join(os.tmpdir(), 'relayfile-qualification-go-mod-'));
  try {
    return await run(goModCache);
  } finally {
    await rm(goModCache, { recursive: true, force: true });
  }
}
