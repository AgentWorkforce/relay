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

export function getOptionalDepPackageName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  return `@agent-relay/broker-${platform}-${arch}`;
}

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

function getResolutionReferences(): string[] {
  const refs: string[] = [];
  addUniquePath(refs, getCurrentModuleReference());

  // Also try the entry script so CLI consumers and bundled installs
  // (where the SDK lives under the consuming package's node_modules) can
  // still find the optional-dep package.
  if (process.argv[1]) {
    addUniquePath(refs, process.argv[1]);
  }

  // Fall back to the cwd so unusual runtime layouts still resolve.
  addUniquePath(refs, join(process.cwd(), 'package.json'));

  return refs;
}

function requireResolveFromRefs(specifier: string): string | null {
  for (const ref of getResolutionReferences()) {
    try {
      return createRequire(ref).resolve(specifier);
    } catch {
      // Try the next reference.
    }
  }
  return null;
}

/**
 * Resolve the broker binary via the platform-specific optional-dependency
 * package (`@agent-relay/broker-<platform>-<arch>`). Returns null when the
 * optional dep is not installed (expected when users install with
 * --no-optional / --ignore-scripts or when the broker hasn't been published
 * for their platform yet).
 */
function getOptionalDepBinaryPath(ext: string): string | null {
  const pkgName = getOptionalDepPackageName();
  const binaryFile = `${BROKER_NAME}${ext}`;

  const pkgJsonPath = requireResolveFromRefs(`${pkgName}/package.json`);
  if (!pkgJsonPath) return null;

  const binPath = join(dirname(pkgJsonPath), 'bin', binaryFile);
  return existsSync(binPath) ? binPath : null;
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

// The `agent-relay` npm tarball historically shipped platform-specific
// brokers at its top-level `bin/`. Walk up from the SDK module looking for
// any ancestor with a `bin/` directory. This fallback is retained for one
// release cycle while downstream installs migrate to the optional-dep
// package; delete it in the next major.
function getAncestorBinDirs(): string[] {
  const binDirs: string[] = [];
  const start = getCurrentModuleDir();
  if (!start) return binDirs;

  let current = resolve(start);
  for (let i = 0; i < 6; i++) {
    addUniquePath(binDirs, join(current, 'bin'));
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
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

function isSourceCheckoutRoot(candidate: string): boolean {
  const repoRoot = resolve(candidate);
  return (
    existsSync(join(repoRoot, 'Cargo.toml')) &&
    existsSync(join(repoRoot, 'src', 'main.rs')) &&
    existsSync(join(repoRoot, 'packages', 'sdk', 'package.json'))
  );
}

function getSourceCheckoutBinaryPaths(ext: string, binDirs: string[]): string[] {
  return getDevelopmentBinaryPaths(ext, binDirs).filter((binaryPath) =>
    isSourceCheckoutRoot(resolve(dirname(binaryPath), '..', '..'))
  );
}

/**
 * Resolve the agent-relay-broker binary path.
 *
 * Search order:
 *   1. Explicit env override (BROKER_BINARY_PATH / AGENT_RELAY_BIN)
 *   2. Local Cargo build when the SDK is loaded from an agent-relay source
 *      checkout — keeps dev workflows snappy by preferring a fresh
 *      `target/release` binary over anything staged in bin/
 *   3. Platform-specific optional-dep package
 *      (`@agent-relay/broker-<platform>-<arch>`) — primary production path
 *   4. SDK's bin/ directory (legacy bundled binary — kept for one release
 *      cycle so mixed-version installs still work)
 *   5. Ancestor bin/ directories (legacy, from PR #768 — kept for one
 *      release cycle so stale `agent-relay` tarballs still resolve)
 *   6. Cargo development paths (target/release and target/debug)
 *   7. PATH lookup via `which` / `where`
 *
 * @returns Absolute path to the broker binary, or null if not found
 */
export function getBrokerBinaryPath(): string | null {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const binDirs = getSdkBinDirs();
  const ancestorBinDirs = getAncestorBinDirs();
  const platformSpecific = `${BROKER_NAME}-${process.platform}-${process.arch}${ext}`;
  const override = process.env.BROKER_BINARY_PATH ?? process.env.AGENT_RELAY_BIN;

  if (override) {
    const resolvedOverride = resolve(override);
    if (existsSync(resolvedOverride)) {
      return resolvedOverride;
    }
  }

  // 1. Prefer a local Cargo build when this SDK is being used from a source checkout.
  // In development, a binary staged in packages/sdk/bin can be stale relative
  // to the current Rust build in target/release.
  for (const developmentPath of getSourceCheckoutBinaryPaths(ext, binDirs)) {
    if (existsSync(developmentPath)) {
      return developmentPath;
    }
  }

  // 2. Platform-specific optional-dep package — the primary production path.
  const optionalDepBinary = getOptionalDepBinaryPath(ext);
  if (optionalDepBinary) {
    return optionalDepBinary;
  }

  // 3. SDK's bin/ (legacy bundled binary — kept for one release cycle).
  for (const binDir of binDirs) {
    const exactPath = join(binDir, `${BROKER_NAME}${ext}`);
    if (existsSync(exactPath)) {
      return exactPath;
    }
  }

  // 4. Platform-specific name in SDK's bin/ (legacy).
  for (const binDir of binDirs) {
    const platformPath = join(binDir, platformSpecific);
    if (existsSync(platformPath)) {
      return platformPath;
    }
  }

  // 5. Ancestor bin/ directories (legacy from PR #768 — the `agent-relay`
  // tarball historically shipped brokers at its package-root bin/).
  for (const binDir of ancestorBinDirs) {
    const exactPath = join(binDir, `${BROKER_NAME}${ext}`);
    if (existsSync(exactPath)) {
      return exactPath;
    }
    const platformPath = join(binDir, platformSpecific);
    if (existsSync(platformPath)) {
      return platformPath;
    }
  }

  // 6. Common development paths for local Cargo builds.
  for (const developmentPath of getDevelopmentBinaryPaths(ext, binDirs)) {
    if (existsSync(developmentPath)) {
      return developmentPath;
    }
  }

  // 7. PATH lookup
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

/**
 * Human-readable error message explaining that the optional-dep broker
 * package for the current platform/arch isn't installed. Used by the SDK
 * at broker-spawn time so users get a clear message instead of an
 * inscrutable `spawn agent-relay-broker ENOENT`.
 */
export function formatBrokerNotFoundError(): string {
  const pkgName = getOptionalDepPackageName();
  return (
    `@agent-relay/sdk couldn't find an agent-relay-broker binary for ` +
    `${process.platform}-${process.arch}. The optional dependency ` +
    `${pkgName} is expected to be installed alongside @agent-relay/sdk. ` +
    `Try reinstalling with --include=optional, or set BROKER_BINARY_PATH ` +
    `to point at a broker binary you've downloaded manually.`
  );
}
