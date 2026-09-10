import assert from 'node:assert/strict';
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { withTemporaryGoModuleCache } from './go-cache.mjs';

test('temporary Go module cache is removed when the build fails', async () => {
  let cachePath;
  await assert.rejects(
    withTemporaryGoModuleCache(async (createdPath) => {
      cachePath = createdPath;
      await access(createdPath);
      const moduleRoot = path.join(createdPath, 'example.invalid', 'module@v1.0.0');
      await mkdir(path.join(moduleRoot, '.github'), { recursive: true });
      await writeFile(path.join(moduleRoot, '.github', 'fixture'), 'read only module cache');
      await chmod(path.join(moduleRoot, '.github'), 0o500);
      await chmod(moduleRoot, 0o500);
      throw new Error('simulated Go build failure');
    }),
    /simulated Go build failure/
  );
  assert.equal(typeof cachePath, 'string');
  await assert.rejects(access(cachePath), { code: 'ENOENT' });
});
