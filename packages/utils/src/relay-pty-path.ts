/**
 * Shared utility for finding the relay-pty binary path.
 *
 * This is used by both:
 * - packages/bridge/src/spawner.ts (AgentSpawner)
 * - packages/wrapper/src/relay-pty-orchestrator.ts (RelayPtyOrchestrator)
 *
 * The search order handles multiple installation scenarios:
 * 1. Development (local Rust build)
 * 2. Local npm install (node_modules/agent-relay)
 * 3. Global npm install via nvm
 * 4. System-wide installs (/usr/local/bin)
 */

import fs from 'node:fs';
import path from 'node:path';

/** Cached result of relay-pty binary check */
let cachedBinaryPath: string | null | undefined;
let cacheChecked = false;

/**
 * Find the relay-pty binary.
 *
 * Search order:
 * 1. bin/relay-pty in package root (installed by postinstall)
 * 2. relay-pty/target/release/relay-pty (local Rust build)
 * 3. /usr/local/bin/relay-pty (global install)
 * 4. In node_modules when installed as dependency
 * 5. Global npm installs (nvm) - both scoped and root packages
 *
 * @param callerDirname - The __dirname of the calling module (needed to resolve relative paths)
 * @returns Path to relay-pty binary, or null if not found
 */
export function findRelayPtyBinary(callerDirname: string): string | null {
  // Determine the agent-relay package root
  // This code runs from either:
  // - packages/{package}/dist/ (development/workspace)
  // - node_modules/@agent-relay/{package}/dist/ (npm install)
  //
  // We need to find the agent-relay package root where bin/relay-pty lives
  let packageRoot: string;

  // Check if we're inside node_modules/@agent-relay/*/
  if (callerDirname.includes('node_modules/@agent-relay/')) {
    // Go from node_modules/@agent-relay/{package}/dist/ to agent-relay/
    // dist/ -> {package}/ -> @agent-relay/ -> node_modules/ -> agent-relay/
    packageRoot = path.join(callerDirname, '..', '..', '..', '..');
  } else if (callerDirname.includes('node_modules/agent-relay')) {
    // Direct dependency: node_modules/agent-relay/packages/{package}/dist/
    // dist/ -> {package}/ -> packages/ -> agent-relay/
    packageRoot = path.join(callerDirname, '..', '..', '..');
  } else {
    // Development: packages/{package}/dist/ -> packages/ -> project root
    packageRoot = path.join(callerDirname, '..', '..', '..');
  }

  // Find the node_modules root for global installs
  // When running from node_modules/@agent-relay/dashboard/node_modules/@agent-relay/wrapper/dist/
  // we need to look for agent-relay at node_modules/agent-relay
  // Use non-greedy match (.+?) to get the FIRST node_modules, not the last
  let nodeModulesRoot: string | null = null;
  const nodeModulesMatch = callerDirname.match(/^(.+?\/node_modules)\/@agent-relay\//);
  if (nodeModulesMatch) {
    nodeModulesRoot = nodeModulesMatch[1];
  }

  const candidates = [
    // Primary: installed by postinstall from platform-specific binary
    path.join(packageRoot, 'bin', 'relay-pty'),
    // Development: local Rust build
    path.join(packageRoot, 'relay-pty', 'target', 'release', 'relay-pty'),
    path.join(packageRoot, 'relay-pty', 'target', 'debug', 'relay-pty'),
    // Local build in cwd (for development)
    path.join(process.cwd(), 'relay-pty', 'target', 'release', 'relay-pty'),
    // Docker container (CI tests)
    '/app/bin/relay-pty',
    // Installed globally
    '/usr/local/bin/relay-pty',
    // In node_modules (when installed as local dependency)
    path.join(process.cwd(), 'node_modules', 'agent-relay', 'bin', 'relay-pty'),
    // Global npm install (nvm) - root package
    path.join(process.env.HOME || '', '.nvm', 'versions', 'node', process.version, 'lib', 'node_modules', 'agent-relay', 'bin', 'relay-pty'),
  ];

  // Add candidate for root agent-relay package when running from scoped @agent-relay/* packages
  if (nodeModulesRoot) {
    candidates.push(path.join(nodeModulesRoot, 'agent-relay', 'bin', 'relay-pty'));
  }

  // Try common global npm paths
  if (process.env.HOME) {
    // Homebrew npm (macOS)
    candidates.push(path.join('/usr/local/lib/node_modules', 'agent-relay', 'bin', 'relay-pty'));
    candidates.push(path.join('/opt/homebrew/lib/node_modules', 'agent-relay', 'bin', 'relay-pty'));
    // pnpm global
    candidates.push(path.join(process.env.HOME, '.local', 'share', 'pnpm', 'global', 'node_modules', 'agent-relay', 'bin', 'relay-pty'));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Check if relay-pty binary is available (cached).
 * Returns true if the binary exists, false otherwise.
 *
 * @param callerDirname - The __dirname of the calling module
 */
export function hasRelayPtyBinary(callerDirname: string): boolean {
  if (!cacheChecked) {
    cachedBinaryPath = findRelayPtyBinary(callerDirname);
    cacheChecked = true;
  }
  return cachedBinaryPath !== null;
}

/**
 * Get the cached relay-pty binary path.
 * Must call hasRelayPtyBinary() or findRelayPtyBinary() first.
 */
export function getCachedRelayPtyPath(): string | null | undefined {
  return cachedBinaryPath;
}

/**
 * Clear the cached binary path (for testing).
 */
export function clearBinaryCache(): void {
  cachedBinaryPath = undefined;
  cacheChecked = false;
}
