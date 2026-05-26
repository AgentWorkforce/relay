#!/usr/bin/env node
// scripts/prepack-materialize-workspaces.mjs
//
// npm pack's bundledDependencies mechanism only ships real directories under
// node_modules/. In a workspace, node_modules/@agent-relay/<pkg> is typically
// a symlink to packages/<pkg>, and npm pack does not follow symlinks out of
// the package root. Result: bundledDependencies silently ships nothing.
//
// This script runs in prepack, detects any symlinked workspace packages, and
// replaces them with real directories containing dist/, package.json, and
// README.md (if present). The replacement is scoped to a .materialized marker
// so it is idempotent and safe to re-run.

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const bundled = pkg.bundledDependencies || pkg.bundleDependencies || [];
const targets = bundled.filter((name) => name.startsWith('@agent-relay/'));

if (targets.length === 0) {
  console.log(
    '[prepack-materialize] no @agent-relay/* entries in bundledDependencies - nothing to do',
  );
  process.exit(0);
}

let materialized = 0;

for (const name of targets) {
  const dst = join(ROOT, 'node_modules', name);

  if (!existsSync(dst)) {
    console.error('[prepack-materialize] MISSING: ' + dst + ' - run npm install first');
    process.exit(1);
  }

  const stat = lstatSync(dst);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    const marker = join(dst, '.materialized');
    if (existsSync(marker)) {
      console.log('[prepack-materialize] already materialized: ' + name);
      continue;
    }

    console.log('[prepack-materialize] real dir (unmarked): ' + name);
    continue;
  }

  if (!stat.isSymbolicLink()) {
    console.error('[prepack-materialize] unsupported node_modules entry: ' + dst);
    process.exit(1);
  }

  const realPath = realpathSync(dst);
  console.log('[prepack-materialize] ' + name + ' -> symlink -> ' + realPath);

  rmSync(dst, { force: true, recursive: true });
  mkdirSync(dst, { recursive: true });

  const pkgJsonSrc = join(realPath, 'package.json');
  if (!existsSync(pkgJsonSrc)) {
    console.error('[prepack-materialize] ' + name + ' missing package.json at ' + pkgJsonSrc);
    process.exit(1);
  }

  cpSync(pkgJsonSrc, join(dst, 'package.json'));

  const distSrc = join(realPath, 'dist');
  if (existsSync(distSrc)) {
    cpSync(distSrc, join(dst, 'dist'), { recursive: true });
  }

  const readmeSrc = join(realPath, 'README.md');
  if (existsSync(readmeSrc)) {
    cpSync(readmeSrc, join(dst, 'README.md'));
  }

  writeFileSync(join(dst, '.materialized'), 'materialized-by-prepack\n');
  materialized += 1;
}

console.log('[prepack-materialize] done - materialized ' + materialized + ' package(s)');
