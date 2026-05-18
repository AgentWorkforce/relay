#!/usr/bin/env node
// scripts/verify-bundled-deps.mjs
//
// Post-prepack sanity check: every @agent-relay/* entry in bundledDependencies
// must have a real directory at node_modules/<name>/package.json. Run from
// prepublishOnly to fail the publish if anything is off.

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const bundled = (pkg.bundledDependencies || pkg.bundleDependencies || []).filter((name) =>
  name.startsWith('@agent-relay/'),
);

let failed = 0;

for (const name of bundled) {
  const dir = join(ROOT, 'node_modules', name);
  const pkgJson = join(dir, 'package.json');

  if (!existsSync(pkgJson)) {
    console.error('[verify-bundled] MISSING package.json: ' + pkgJson);
    failed += 1;
    continue;
  }

  if (lstatSync(dir).isSymbolicLink()) {
    console.error(
      '[verify-bundled] STILL A SYMLINK: ' + dir + ' - prepack materializer did not run',
    );
    failed += 1;
    continue;
  }

  console.log('[verify-bundled] OK: ' + name);
}

if (failed > 0) {
  console.error('[verify-bundled] FAIL - ' + failed + ' package(s) not ready for npm pack');
  process.exit(1);
}

console.log('[verify-bundled] all bundled @agent-relay/* packages ready');
