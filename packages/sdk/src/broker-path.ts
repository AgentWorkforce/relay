/**
 * Resolves the agent-relay-broker binary path at runtime.
 *
 * Usage:
 *   import { getBrokerBinaryPath } from '@agent-relay/sdk/broker-path';
 *   const binPath = getBrokerBinaryPath();
 */

import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const BROKER_NAME = 'agent-relay-broker';

function addUniquePath(paths: string[], candidate: string | null | undefined): void {
  if (!candidate || paths.includes(candidate)) {
    return;
  }
  paths.push(candidate);
}

function getImportMetaUrl(): string | null {
  try {
    return import.meta.url;
  } catch {
    return null;
  }
}

function getCurrentModuleDir(): string | null {
  if (typeof __dirname === 'string' && __dirname) {
    return __dirname;
  }
  if (typeof __filename === 'string' && __filename) {
    return dirname(__filename);
  }

  const importMetaUrl = getImportMetaUrl();
  if (!importMetaUrl) {
    return null;
  }

  try {
    return dirname(fileURLToPath(importMetaUrl));
  } catch {
    return null;
  }
}

function getCurrentModuleReference(): string | null {
  if (typeof __filename === 'string' && __filename) {
    return __filename;
  }
  if (typeof __dirname === 'string' && __dirname) {
    return join(__dirname, 'broker-path.js');
  }

  return getImportMetaUrl();
}

function getSdkBinDirs(): string[] {
  const binDirs: string[] = [];

  const currentModuleDir = getCurrentModuleDir();
  if (currentModuleDir) {
    addUniquePath(binDirs, resolve(currentModuleDir, '..', 'bin'));
  }

  const currentModuleReference = getCurrentModuleReference();
  if (currentModuleReference) {
    try {
      const sdkEntry = createRequire(currentModuleReference).resolve('@agent-relay/sdk');
      addUniquePath(binDirs, resolve(dirname(sdkEntry), '..', 'bin'));
    } catch {
      // Continue with other resolution strategies.
    }
  }

  const importMetaUrl = getImportMetaUrl();
  if (importMetaUrl) {
    try {
      addUniquePath(binDirs, resolve(dirname(fileURLToPath(importMetaUrl)), '..', 'bin'));
    } catch {
      // Continue with other resolution strategies.
    }
  }

  return binDirs;
}

function getDevelopmentBinaryPaths(ext: string, binDirs: string[]): string[] {
  const binaryPaths: string[] = [];
  const repoRoots = new Set<string>();

  const addRepoRoot = (candidate: string | null | undefined): void => {
    if (!candidate) {
      return;
    }

    const repoRoot = resolve(candidate);
    if (repoRoots.has(repoRoot)) {
      return;
    }
    repoRoots.add(repoRoot);

    addUniquePath(binaryPaths, join(repoRoot, 'target', 'release', `${BROKER_NAME}${ext}`));
    addUniquePath(binaryPaths, join(repoRoot, 'target', 'debug', `${BROKER_NAME}${ext}`));
  };

  addRepoRoot(process.cwd());

  const currentModuleDir = getCurrentModuleDir();
  if (currentModuleDir) {
    addRepoRoot(resolve(currentModuleDir, '..', '..', '..'));
  }

  for (const binDir of binDirs) {
    addRepoRoot(resolve(binDir, '..', '..', '..'));
  }

  return binaryPaths;
}

/**
 * Resolve the agent-relay-broker binary path.
 *
 * Search order:
 *   1. SDK's bin/ directory (resolved via CJS globals, createRequire, or import.meta.url)
 *   2. Platform-specific name (agent-relay-broker-{platform}-{arch}) in bin/
 *   3. Common Cargo development paths (target/release and target/debug)
 *   4. PATH lookup via `which` / `where`
 *
 * @returns Absolute path to the broker binary, or null if not found
 */
export function getBrokerBinaryPath(): string | null {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const binDirs = getSdkBinDirs();
  const platformSpecific = `${BROKER_NAME}-${process.platform}-${process.arch}${ext}`;

  // 1. Exact name in bin/
  for (const binDir of binDirs) {
    const exactPath = join(binDir, `${BROKER_NAME}${ext}`);
    if (existsSync(exactPath)) {
      return exactPath;
    }
  }

  // 2. Platform-specific name in bin/
  for (const binDir of binDirs) {
    const platformPath = join(binDir, platformSpecific);
    if (existsSync(platformPath)) {
      return platformPath;
    }
  }

  // 3. Common development paths for local Cargo builds.
  for (const developmentPath of getDevelopmentBinaryPaths(ext, binDirs)) {
    if (existsSync(developmentPath)) {
      return developmentPath;
    }
  }

  // 4. PATH lookup
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(cmd, [BROKER_NAME], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (result) {
      return result.split(/\r?\n/u)[0].trim();
    }
  } catch {
    // Not found on PATH
  }

  return null;
}
