#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');

if (process.env.CI === 'true') {
  console.log('[info] CI detected, skipping husky install');
  process.exit(0);
}

const huskyBin = path.join(
  rootDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'husky.cmd' : 'husky',
);

if (!existsSync(huskyBin)) {
  console.log('[info] husky not installed, skipping prepare hook');
  process.exit(0);
}

const result = spawnSync(huskyBin, {
  cwd: rootDir,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[error] failed to run husky: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
