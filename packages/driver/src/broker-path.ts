/**
 * Resolves the agent-relay-broker binary path at runtime.
 *
 * Usage:
 *   import { getBrokerBinaryPath } from '@agent-relay/driver/broker-path';
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

  // Fall back to the cwd's package.json as a final resolution anchor.
  // `createRequire` only needs a file path that sits inside a project root
  // — it doesn't have to exist. This catches setups where the SDK's module
  // path and the entry script both sit outside the consumer's node_modules
  // tree (e.g. a globally-installed SDK importing per-project optional deps,
  // some vite/webpack bundling configurations, repl experimentation), but
  // the consumer's cwd is inside their own project. We only use this
  // reference to run require.resolve; no file I/O is triggered on misses.
  addUniquePath(refs, join(process.cwd(), 'package.json'));

  return refs;
}

/**
 * Resolve the broker binary via the platform-specific optional-dependency
 * package (`@agent-relay/broker-<platform>-<arch>`). Returns null when the
 * optional dep is not installed (expected when users install with
 * --no-optional / --omit=optional / --include= omits optional, or when the
 * broker hasn't been published for their platform yet).
 */
function getOptionalDepBinaryPath(ext: string): string | null {
  const pkgName = getOptionalDepPackageName();
  const binaryFile = `${BROKER_NAME}${ext}`;

  for (const ref of getResolutionReferences()) {
    try {
      const pkgJsonPath = createRequire(ref).resolve(`${pkgName}/package.json`);
      const binPath = join(dirname(pkgJsonPath), 'bin', binaryFile);
      if (existsSync(binPath)) return binPath;
    } catch {
      // Try the next reference.
    }
  }
  return null;
}

function getDriverBinDirs(): string[] {
  const binDirs: string[] = [];

  const currentModuleDir = getCurrentModuleDir();
  if (currentModuleDir) {
    addUniquePath(binDirs, resolve(currentModuleDir, '..', 'bin'));
  }

  const currentModuleReference = getCurrentModuleReference();
  if (currentModuleReference) {
    try {
      const driverEntry = createRequire(currentModuleReference).resolve('@agent-relay/driver');
      addUniquePath(binDirs, resolve(dirname(driverEntry), '..', 'bin'));
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

function findAncestorSourceCheckoutRoot(start: string): string | null {
  let current = resolve(start);
  for (let i = 0; i < 8; i++) {
    if (isSourceCheckoutRoot(current)) {
      return current;
    }
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  return null;
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
  addRepoRoot(findAncestorSourceCheckoutRoot(process.cwd()));

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
    existsSync(join(repoRoot, 'crates', 'broker', 'src', 'main.rs')) &&
      existsSync(join(repoRoot, 'packages', 'driver', 'package.json'))
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
 *   4. Driver's bin/ directory
 *   5. Cargo development paths (target/release and target/debug)
 *   6. PATH lookup via `which` / `where`
 *
 * @returns Absolute path to the broker binary, or null if not found
 */
export function getBrokerBinaryPath(): string | null {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const binDirs = getDriverBinDirs();
  const platformSpecific = `${BROKER_NAME}-${process.platform}-${process.arch}${ext}`;
  const override = process.env.BROKER_BINARY_PATH ?? process.env.AGENT_RELAY_BIN;

  if (override) {
    const resolvedOverride = resolve(override);
    if (existsSync(resolvedOverride)) {
      return resolvedOverride;
    }
  }

  // 1. Prefer a local Cargo build when this SDK is being used from a source checkout.
  // In development, a binary staged in packages/driver/bin can be stale relative
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

  // 3. Driver's bin/.
  for (const binDir of binDirs) {
    const exactPath = join(binDir, `${BROKER_NAME}${ext}`);
    if (existsSync(exactPath)) {
      return exactPath;
    }
  }

  // 4. Platform-specific name in Driver's bin/.
  for (const binDir of binDirs) {
    const platformPath = join(binDir, platformSpecific);
    if (existsSync(platformPath)) {
      return platformPath;
    }
  }

  // 5. Common development paths for local Cargo builds.
  for (const developmentPath of getDevelopmentBinaryPaths(ext, binDirs)) {
    if (existsSync(developmentPath)) {
      return developmentPath;
    }
  }

  // 6. PATH lookup
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
    `@agent-relay/driver couldn't find an agent-relay-broker binary for ` +
    `${process.platform}-${process.arch}. The optional dependency ` +
    `${pkgName} is expected to be installed alongside @agent-relay/driver. ` +
    `Try reinstalling with --include=optional, or set BROKER_BINARY_PATH ` +
    `to point at a broker binary you've downloaded manually.`
  );
}
