#!/usr/bin/env node
// packages/cli/scripts/prepack-materialize-workspaces.mjs
//
// npm pack's bundledDependencies mechanism only ships real directories under
// the packing package's own node_modules/. With npm workspaces, those deps
// are usually hoisted to the repo root and may not exist at all in
// packages/cli/node_modules/. Result: bundledDependencies silently ship
// nothing.
//
// This script runs in prepack. For each bundledDependency:
//   - Workspace @agent-relay/* packages get a minimal publish-shaped copy
//     (package.json + dist/ + README.md) from packages/<name>/.
//   - Everything else (e.g. @relaycast/sdk) is copied wholesale from
//     wherever npm placed it (hoisted root or nested) — preserves the
//     package's own nested node_modules/ for unhoistable deps.
//
// Materialized directories carry a `.materialized` marker so re-runs are
// idempotent.

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
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..'); // packages/cli/
const REPO_ROOT = resolve(PKG_ROOT, '..', '..'); // monorepo root
const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));

// Locate an installed package by walking node_modules dirs up from PKG_ROOT,
// the same way Node's CJS resolver does. Avoids the `exports` field gotcha
// where modern packages don't expose `./package.json` (so require.resolve
// can't find them) but the directory itself is plainly there on disk.
function findInstalledPackageDir(name) {
  let cur = PKG_ROOT;
  while (true) {
    const candidate = join(cur, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) {
      return candidate;
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

const bundled = pkg.bundledDependencies || pkg.bundleDependencies || [];

if (bundled.length === 0) {
  console.log('[prepack-materialize] no bundledDependencies declared - nothing to do');
  process.exit(0);
}

const workspacePackagesDir = join(REPO_ROOT, 'packages') + sep;
let materialized = 0;

for (const name of bundled) {
  const dst = join(PKG_ROOT, 'node_modules', name);

  // The resolved path may be a symlink (workspace packages typically are).
  // Don't dereference yet — we want to know it's a symlink so we can choose
  // the workspace materialization path below.
  const installedDir = findInstalledPackageDir(name);
  if (!installedDir) {
    console.error(
      `[prepack-materialize] cannot find ${name} in any node_modules ancestor of ${PKG_ROOT} - run npm install first`
    );
    process.exit(1);
  }

  // realpath so we copy the real files, not the symlink itself.
  const realPath = realpathSync(installedDir);

  if (existsSync(dst)) {
    const stat = lstatSync(dst);
    const isRealDir = stat.isDirectory() && !stat.isSymbolicLink();
    if (isRealDir && existsSync(join(dst, '.materialized'))) {
      console.log(`[prepack-materialize] already materialized: ${name}`);
      continue;
    }
    rmSync(dst, { force: true, recursive: true });
  }

  mkdirSync(dst, { recursive: true });

  const isWorkspacePackage = realPath.startsWith(workspacePackagesDir);

  if (isWorkspacePackage) {
    cpSync(join(realPath, 'package.json'), join(dst, 'package.json'));

    const distSrc = join(realPath, 'dist');
    if (existsSync(distSrc)) {
      cpSync(distSrc, join(dst, 'dist'), { recursive: true });
    }

    const readmeSrc = join(realPath, 'README.md');
    if (existsSync(readmeSrc)) {
      cpSync(readmeSrc, join(dst, 'README.md'));
    }

    console.log(`[prepack-materialize] ${name} <- workspace ${relative(REPO_ROOT, realPath)}`);
  } else {
    cpSync(realPath, dst, { recursive: true });
    console.log(`[prepack-materialize] ${name} <- ${relative(REPO_ROOT, realPath)} (wholesale)`);
  }

  writeFileSync(join(dst, '.materialized'), 'materialized-by-prepack\n');
  materialized += 1;
}

console.log(`[prepack-materialize] done - materialized ${materialized} package(s)`);
