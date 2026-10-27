/**
 * Resolves the agent-relay-broker binary path at runtime.
 *
 * Usage:
 *   import { getBrokerBinaryPath } from '@agent-relay/harness-driver/broker-path';
 *   const binPath = getBrokerBinaryPath();
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  BROKER_BINARY_NAME,
  findExecutableOnPath,
  getCanonicalBrokerPath,
  getRelayBinDir,
  isUsableBinary,
} from './install-paths.js';

const BROKER_NAME = BROKER_BINARY_NAME;

/**
 * npm package name of the platform broker, e.g. `@agent-relay/broker-linux-x64`.
 * @param platform - Target platform
 * @param arch - Target architecture
 * @returns The optional-dependency package name
 */
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

function addResolutionReference(refs: string[], candidate: string | null | undefined): void {
  addUniquePath(refs, candidate);
  if (!candidate) {
    return;
  }

  try {
    const filePath = candidate.startsWith('file:') ? fileURLToPath(candidate) : candidate;
    addUniquePath(refs, realpathSync(filePath));
  } catch {
    // The cwd fallback intentionally need not exist, and a launcher symlink may
    // disappear during an in-place package-manager upgrade. Keep the original
    // reference and let require.resolve handle the miss.
  }
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

function getResolutionReferences(includeCwd = true): string[] {
  const refs: string[] = [];
  addResolutionReference(refs, getCurrentModuleReference());

  // Also try the entry script so CLI consumers and bundled installs
  // (where the SDK lives under the consuming package's node_modules) can
  // still find the optional-dep package. Package-manager launchers such as
  // mise expose this as a symlink; its canonical target sits inside the global
  // package tree and is therefore a separate, necessary resolution anchor.
  if (process.argv[1]) {
    addResolutionReference(refs, process.argv[1]);
  }

  // Fall back to the cwd's package.json as a final resolution anchor.
  // `createRequire` only needs a file path that sits inside a project root
  // — it doesn't have to exist. This catches setups where the SDK's module
  // path and the entry script both sit outside the consumer's node_modules
  // tree (e.g. a globally-installed SDK importing per-project optional deps,
  // some vite/webpack bundling configurations, repl experimentation), but
  // the consumer's cwd is inside their own project. We only use this
  // reference to run require.resolve; no file I/O is triggered on misses.
  if (includeCwd) {
    addResolutionReference(refs, join(process.cwd(), 'package.json'));
  }

  return refs;
}

/**
 * Binary locations created by older Relay installers. These are
 * deliberately checked without shelling out: a version manager can launch
 * Node with a minimal PATH, which is exactly when `which` cannot see the
 * broker that the Relay installer placed beside its launcher or under the
 * canonical user install directory.
 */
function getInstalledBinaryPaths(ext: string): string[] {
  const binaryFile = `${BROKER_NAME}${ext}`;
  const binaryPaths: string[] = [];

  const addSiblingBinaryPaths = (candidate: string | null | undefined): void => {
    const launcherPaths: string[] = [];
    addResolutionReference(launcherPaths, candidate);
    for (const launcherPath of launcherPaths) {
      addUniquePath(binaryPaths, join(dirname(resolve(launcherPath)), binaryFile));
    }
  };

  addSiblingBinaryPaths(process.argv[1]);
  addSiblingBinaryPaths(process.execPath);

  const userHome = homedir();
  if (userHome) {
    addUniquePath(binaryPaths, join(userHome, '.agent-relay', 'bin', binaryFile));
    addUniquePath(binaryPaths, join(userHome, '.local', 'bin', binaryFile));
  }

  return binaryPaths;
}

/**
 * Resolve the broker binary via the platform-specific optional-dependency
 * package (`@agent-relay/broker-<platform>-<arch>`). Returns null when the
 * optional dep is not installed (expected when users install with
 * --no-optional / --omit=optional / --include= omits optional, or when the
 * broker hasn't been published for their platform yet).
 */
function getOptionalDepBinaryPath(ext: string, includeCwd = true): string | null {
  const pkgName = getOptionalDepPackageName();
  const binaryFile = `${BROKER_NAME}${ext}`;

  for (const ref of getResolutionReferences(includeCwd)) {
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

function getDevelopmentBinaryPaths(ext: string): string[] {
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

  return binaryPaths;
}

function isSourceCheckoutRoot(candidate: string): boolean {
  const repoRoot = resolve(candidate);
  return (
    existsSync(join(repoRoot, 'Cargo.toml')) &&
    existsSync(join(repoRoot, 'crates', 'broker', 'src', 'main.rs')) &&
    existsSync(join(repoRoot, 'packages', 'runtime', 'package.json'))
  );
}

function getSourceCheckoutBinaryPaths(ext: string): string[] {
  return getDevelopmentBinaryPaths(ext).filter((binaryPath) =>
    isSourceCheckoutRoot(resolve(dirname(binaryPath), '..', '..'))
  );
}

/** Where {@link resolveBrokerBinary} found the broker. */
export type BrokerBinarySource =
  | 'env'
  | 'source-checkout'
  | 'canonical'
  | 'standalone'
  | 'npm-optional-dependency'
  | 'cargo-dev'
  | 'path'
  | 'legacy-install';

/** A resolved broker binary and where it was found. */
export interface ResolvedBrokerBinary {
  path: string;
  source: BrokerBinarySource;
}

/**
 * Directory of a running standalone (Bun-compiled) CLI. install.sh puts the
 * standalone CLI and the broker side by side in the install's bin directory,
 * so when the install root was relocated without exporting
 * AGENT_RELAY_INSTALL_DIR at runtime, the executable's own directory is still
 * that install's bin directory.
 */
function getStandaloneCliBinDir(): string | null {
  const exe = basename(process.execPath).toLowerCase();
  if (exe !== 'agent-relay' && exe !== 'agent-relay.exe') return null;
  return dirname(resolve(process.execPath));
}

/**
 * Step 3 of {@link resolveBrokerBinary}: the canonical bin dir, then a
 * standalone CLI's own bin dir. A file there that is empty, not a regular
 * file or not executable is skipped, so a damaged shared install cannot hide
 * a working npm broker from SDK callers that never run the CLI's repair step.
 */
function findCanonicalBroker(ext: string): ResolvedBrokerBinary | null {
  const canonical = getCanonicalBrokerPath();
  if (existsSync(canonical) && isUsableBinary(canonical)) {
    return { path: canonical, source: 'canonical' };
  }
  const standaloneBinDir = getStandaloneCliBinDir();
  if (standaloneBinDir) {
    const standaloneBroker = join(standaloneBinDir, `${BROKER_NAME}${ext}`);
    if (existsSync(standaloneBroker) && isUsableBinary(standaloneBroker)) {
      return { path: standaloneBroker, source: 'standalone' };
    }
  }
  return null;
}

export interface OptionalDepBrokerPathOptions {
  /**
   * Also resolve through `<cwd>/package.json` (default true). The CLI passes
   * false when choosing a broker to copy into the shared bin directory, so a
   * project's own (possibly different) broker version never lands there.
   */
  includeCwd?: boolean;
}

/**
 * The broker shipped by the npm optional dependency
 * `@agent-relay/broker-<platform>-<arch>`, or null when it is not installed.
 * Exposed so the CLI can copy it into the canonical bin directory.
 * @param options - Resolution options
 * @returns Absolute path to the npm broker, or null
 */
export function getOptionalDepBrokerPath(options: OptionalDepBrokerPathOptions = {}): string | null {
  return getOptionalDepBinaryPath(process.platform === 'win32' ? '.exe' : '', options.includeCwd ?? true);
}

/**
 * Resolve the agent-relay-broker binary and report where it came from.
 *
 * Search order (first existing file wins):
 *   1. Explicit env override: BROKER_BINARY_PATH, then AGENT_RELAY_BIN.
 *   2. Development only: the Cargo build of an agent-relay source checkout
 *      when this runtime is loaded from (or run inside) that checkout.
 *   3. Canonical install: `<install root>/bin/agent-relay-broker[.exe]`, where
 *      the install root is AGENT_RELAY_INSTALL_DIR, else AGENT_RELAY_HOME,
 *      else ~/.agentworkforce/relay. install.sh, the desktop app and the npm
 *      CLI (on first run) all put the broker here. A standalone CLI's own bin
 *      directory counts as its canonical install.
 *   4. Legacy npm fallback: the platform optional-dependency package
 *      `@agent-relay/broker-<platform>-<arch>`.
 *   5. Cargo development paths (target/release, target/debug).
 *   6. PATH lookup via `which` / `where`.
 *   7. Older installer locations (launcher sibling, ~/.agent-relay/bin,
 *      ~/.local/bin), for version managers that launch Node with a minimal
 *      PATH.
 *
 * @returns The resolved broker and its source, or null if none was found
 */
export function resolveBrokerBinary(): ResolvedBrokerBinary | null {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const override = process.env.BROKER_BINARY_PATH ?? process.env.AGENT_RELAY_BIN;

  // 1. Explicit override.
  if (override) {
    const resolvedOverride = resolve(override);
    if (existsSync(resolvedOverride)) {
      return { path: resolvedOverride, source: 'env' };
    }
  }

  // 2. A local Cargo build when this runtime is being used from a source checkout.
  for (const developmentPath of getSourceCheckoutBinaryPaths(ext)) {
    if (existsSync(developmentPath)) {
      return { path: developmentPath, source: 'source-checkout' };
    }
  }

  // 3. The canonical install location shared by every install method.
  const installed = findCanonicalBroker(ext);
  if (installed) {
    return installed;
  }

  // 4. Legacy: the platform-specific npm optional dependency.
  const optionalDepBinary = getOptionalDepBinaryPath(ext);
  if (optionalDepBinary) {
    return { path: optionalDepBinary, source: 'npm-optional-dependency' };
  }

  // 5. Common development paths for local Cargo builds.
  for (const developmentPath of getDevelopmentBinaryPaths(ext)) {
    if (existsSync(developmentPath)) {
      return { path: developmentPath, source: 'cargo-dev' };
    }
  }

  // 6. PATH lookup.
  const onPath = findExecutableOnPath(BROKER_NAME);
  if (onPath) {
    return { path: onPath, source: 'path' };
  }

  // 7. Older installer locations. This also covers mise and similar version
  // managers when their activation PATH omits the user bin.
  for (const installedPath of getInstalledBinaryPaths(ext)) {
    if (existsSync(installedPath)) {
      return { path: installedPath, source: 'legacy-install' };
    }
  }

  return null;
}

/**
 * Resolve the agent-relay-broker binary path. See {@link resolveBrokerBinary}
 * for the search order.
 *
 * @returns Absolute path to the broker binary, or null if not found
 */
export function getBrokerBinaryPath(): string | null {
  return resolveBrokerBinary()?.path ?? null;
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
    `@agent-relay/harness-driver couldn't find an agent-relay-broker binary for ` +
    `${process.platform}-${process.arch}. Expected it at ${join(getRelayBinDir(), `${BROKER_NAME}${process.platform === 'win32' ? '.exe' : ''}`)} ` +
    `(install with: curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash) ` +
    `or in the optional dependency ${pkgName} (reinstall with --include=optional). ` +
    `Or set BROKER_BINARY_PATH to point at a broker binary you've downloaded manually.`
  );
}
