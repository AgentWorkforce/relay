#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');
const MAX_PRINTED_VIOLATIONS = 50;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function normalizeTarPath(entryPath) {
  return entryPath.replaceAll('\\', '/').replace(/^\.\//, '');
}

function workspacePackageNameFromPath(entryPath) {
  const match = entryPath.match(/^package\/packages\/([^/]+)(?:\/|$)/);
  return match ? match[1] : null;
}

function nestedWorkspaceNodeModulesPackage(entryPath) {
  const match = entryPath.match(/^package\/packages\/([^/]+)\/node_modules(?:\/|$)/);
  return match ? match[1] : null;
}

function isHardLink(entry) {
  const type = entry.type ?? entry.header?.type ?? entry.header?.typeflag;
  const typeFlag = entry.header?.typeflag;
  return type === 'Link' || type === 'HardLink' || type === '1' || typeFlag === '1';
}

function getWorkspacePackageDirs() {
  const packagesDir = path.join(REPO_ROOT, 'packages');
  const byPackageName = new Map();

  if (!fs.existsSync(packagesDir)) {
    return byPackageName;
  }

  for (const dirent of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;

    const packageJsonPath = path.join(packagesDir, dirent.name, 'package.json');
    if (!fs.existsSync(packageJsonPath)) continue;

    try {
      const packageJson = readJson(packageJsonPath);
      if (typeof packageJson.name === 'string') {
        byPackageName.set(packageJson.name, dirent.name);
      }
    } catch {
      // Ignore malformed workspace manifests here; this validator only needs
      // known bundled package directory names from readable package manifests.
    }
  }

  return byPackageName;
}

function getBundledWorkspacePackageDirs() {
  const rootPackageJson = readJson(ROOT_PACKAGE_JSON);
  const bundledDependencies =
    rootPackageJson.bundledDependencies ?? rootPackageJson.bundleDependencies ?? [];
  const workspaceDirsByName = getWorkspacePackageDirs();
  const bundledPackageDirs = new Set();

  for (const dependencyName of bundledDependencies) {
    if (typeof dependencyName !== 'string') continue;

    const workspaceDir = workspaceDirsByName.get(dependencyName);
    if (workspaceDir) {
      bundledPackageDirs.add(workspaceDir);
      continue;
    }

    if (dependencyName.startsWith('@agent-relay/')) {
      bundledPackageDirs.add(dependencyName.slice('@agent-relay/'.length));
    }
  }

  return bundledPackageDirs;
}

function cleanNestedWorkspaceArtifacts() {
  const packagesDir = path.join(REPO_ROOT, 'packages');
  const artifactDirNames = new Set([
    'node_modules',
    '.npm',
    '.cache',
    '.parcel-cache',
    '.turbo',
  ]);

  if (!fs.existsSync(packagesDir)) {
    return [];
  }

  const removed = [];
  const stack = [packagesDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries = [];

    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const entryPath = path.join(currentDir, entry.name);
      if (artifactDirNames.has(entry.name)) {
        fs.rmSync(entryPath, { recursive: true, force: true });
        removed.push(path.relative(REPO_ROOT, entryPath).replaceAll(path.sep, '/'));
        continue;
      }

      stack.push(entryPath);
    }
  }

  return removed.sort();
}

function addViolation(violations, code, subject, detail) {
  const key = `${code}:${subject}`;

  if (!violations.has(key)) {
    violations.set(key, { code, subject, detail });
  }
}

async function validateTarball(tarballPath, bundledPackageDirs) {
  const absoluteTarballPath = path.resolve(tarballPath);

  if (!fs.existsSync(absoluteTarballPath)) {
    throw new Error(`Tarball not found: ${tarballPath}`);
  }

  if (!fs.statSync(absoluteTarballPath).isFile()) {
    throw new Error(`Tarball path is not a file: ${tarballPath}`);
  }

  if (!absoluteTarballPath.endsWith('.tgz') && !absoluteTarballPath.endsWith('.tar.gz')) {
    throw new Error(`Expected a .tgz or .tar.gz file: ${tarballPath}`);
  }

  const violations = new Map();
  const bundledPackagesFound = new Set();
  let entryCount = 0;
  let unpackedSize = 0;

  await tar.list({
    file: absoluteTarballPath,
    onentry(entry) {
      entryCount += 1;

      if (Number.isFinite(entry.size)) {
        unpackedSize += entry.size;
      }

      const entryPath = normalizeTarPath(entry.path);

      if (isHardLink(entry)) {
        addViolation(
          violations,
          'hard-link',
          entryPath,
          `hard link entry${entry.linkpath ? ` to ${entry.linkpath}` : ''}`
        );
      }

      const nodeModulesPackage = nestedWorkspaceNodeModulesPackage(entryPath);
      if (nodeModulesPackage) {
        addViolation(
          violations,
          'nested-node-modules',
          `package/packages/${nodeModulesPackage}/node_modules/`,
          `first seen at ${entryPath}`
        );
      }

      const workspacePackage = workspacePackageNameFromPath(entryPath);
      if (!workspacePackage) {
        return;
      }

      if (bundledPackageDirs.has(workspacePackage)) {
        bundledPackagesFound.add(workspacePackage);
      } else {
        addViolation(
          violations,
          'non-bundled-workspace-package',
          `package/packages/${workspacePackage}/`,
          `workspace package is not listed in bundledDependencies; first seen at ${entryPath}`
        );
      }
    },
  });

  return {
    path: tarballPath,
    absolutePath: absoluteTarballPath,
    entryCount,
    packageSize: fs.statSync(absoluteTarballPath).size,
    unpackedSize,
    bundledPackagesFound: [...bundledPackagesFound].sort(),
    violations: [...violations.values()],
  };
}

function printResult(result) {
  console.log(result.path);
  console.log(`  entries: ${result.entryCount}`);
  console.log(`  package size: ${formatBytes(result.packageSize)}`);
  console.log(`  unpacked size: ${formatBytes(result.unpackedSize)}`);
  console.log(
    `  bundled packages found: ${
      result.bundledPackagesFound.length > 0 ? result.bundledPackagesFound.join(', ') : '(none)'
    }`
  );
  console.log(`  violations: ${result.violations.length}`);

  for (const violation of result.violations.slice(0, MAX_PRINTED_VIOLATIONS)) {
    console.log(`    [${violation.code}] ${violation.subject} - ${violation.detail}`);
  }

  const hiddenCount = result.violations.length - MAX_PRINTED_VIOLATIONS;
  if (hiddenCount > 0) {
    console.log(`    ... ${hiddenCount} more violation(s) omitted`);
  }
}

function createTemporaryPack() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-pack-'));

  try {
    const removed = cleanNestedWorkspaceArtifacts();
    if (removed.length > 0) {
      console.log(`cleaned ${removed.length} nested workspace artifact(s) before packing`);
      for (const removedPath of removed.slice(0, 20)) {
        console.log(`  removed ${removedPath}`);
      }
      if (removed.length > 20) {
        console.log(`  ... ${removed.length - 20} more omitted`);
      }
    }

    const stdout = execFileSync(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', tempDir],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    ).trim();
    const packResult = JSON.parse(stdout);
    const firstPack = Array.isArray(packResult) ? packResult[0] : null;

    if (!firstPack || typeof firstPack.filename !== 'string') {
      throw new Error(`Unexpected npm pack --json output: ${stdout}`);
    }

    return {
      tempDir,
      tarballPaths: [
        path.isAbsolute(firstPack.filename)
          ? firstPack.filename
          : path.join(tempDir, firstPack.filename),
      ],
    };
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const providedPaths = process.argv.slice(2);
  const bundledPackageDirs = getBundledWorkspacePackageDirs();
  let tempPack = null;
  let tarballPaths = providedPaths;

  if (tarballPaths.length === 0) {
    tempPack = createTemporaryPack();
    tarballPaths = tempPack.tarballPaths;
  }

  try {
    const results = [];

    for (const tarballPath of tarballPaths) {
      results.push(await validateTarball(tarballPath, bundledPackageDirs));
    }

    for (const result of results) {
      printResult(result);
    }

    const violationCount = results.reduce((sum, result) => sum + result.violations.length, 0);
    console.log(`summary: ${results.length} tarball(s), ${violationCount} violation(s)`);

    process.exitCode = violationCount > 0 ? 1 : 0;
  } finally {
    if (tempPack) {
      fs.rmSync(tempPack.tempDir, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(`error: ${error.message}`);
  process.exit(2);
});
