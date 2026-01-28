#!/usr/bin/env node
/**
 * Audit bundled package dependencies
 *
 * Ensures all external dependencies used by bundled packages are hoisted
 * to the root package.json. This is required because npm's bundledDependencies
 * includes the packages but NOT their transitive dependencies.
 *
 * Run: node scripts/audit-bundled-deps.mjs
 * Exit code: 0 if all deps hoisted, 1 if missing deps found
 */

import fs from 'fs';
import path from 'path';

const rootPkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
const rootDeps = rootPkg.dependencies || {};
const bundledPackages = new Set(
  (rootPkg.bundledDependencies || rootPkg.bundleDependencies || [])
    .map(name => name.replace('@agent-relay/', ''))
);

// Get all workspace packages
const packages = fs.readdirSync('packages').filter(d => {
  try {
    return fs.existsSync(path.join('packages', d, 'package.json'));
  } catch { return false; }
});

// Collect external deps from bundled packages only
const externalDeps = new Map();

packages.forEach(pkg => {
  // Skip if not bundled
  if (!bundledPackages.has(pkg)) return;

  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join('packages', pkg, 'package.json'), 'utf-8'));
    const deps = pkgJson.dependencies || {};

    Object.entries(deps).forEach(([name, version]) => {
      // Skip internal workspace packages
      if (name.startsWith('@agent-relay')) return;

      if (!externalDeps.has(name)) {
        externalDeps.set(name, { version, from: [pkg] });
      } else {
        externalDeps.get(name).from.push(pkg);
      }
    });
  } catch (err) {
    console.error(`Error reading packages/${pkg}/package.json:`, err.message);
  }
});

// Check which are missing from root
const missing = [];
const found = [];

for (const [name, info] of [...externalDeps.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (rootDeps[name]) {
    found.push({ name, version: info.version, from: info.from });
  } else {
    missing.push({ name, version: info.version, from: info.from });
  }
}

// Output results
console.log('Bundled Dependency Audit');
console.log('========================\n');
console.log(`Bundled packages: ${bundledPackages.size}`);
console.log(`External dependencies found: ${externalDeps.size}`);
console.log(`Hoisted to root: ${found.length}`);
console.log(`Missing from root: ${missing.length}\n`);

if (missing.length > 0) {
  console.log('❌ MISSING DEPENDENCIES\n');
  console.log('The following dependencies are used by bundled packages but not');
  console.log('listed in the root package.json dependencies:\n');

  missing.forEach(d => {
    console.log(`  "${d.name}": "${d.version}",`);
    console.log(`    // used by: ${d.from.join(', ')}\n`);
  });

  console.log('Add these to the root package.json "dependencies" section.');
  console.log('Without them, `npm install -g agent-relay` will fail at runtime.\n');

  process.exit(1);
} else {
  console.log('✅ All bundled package dependencies are properly hoisted.\n');
  process.exit(0);
}
