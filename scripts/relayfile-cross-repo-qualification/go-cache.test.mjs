import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';
import { withTemporaryGoModuleCache } from './go-cache.mjs';

test('temporary Go module cache is removed when the build fails', async () => {
  let cachePath;
  await assert.rejects(
    withTemporaryGoModuleCache(async (createdPath) => {
      cachePath = createdPath;
      await access(createdPath);
      throw new Error('simulated Go build failure');
    }),
    /simulated Go build failure/
  );
  assert.equal(typeof cachePath, 'string');
  await assert.rejects(access(cachePath), { code: 'ENOENT' });
});
