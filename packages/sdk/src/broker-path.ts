/**
 * Resolves the agent-relay-broker binary path at runtime.
 *
 * Usage:
 *   import { getBrokerBinaryPath } from '@agent-relay/sdk/broker-path';
 *   const binPath = getBrokerBinaryPath();
 */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const BROKER_NAME = 'agent-relay-broker';

/**
 * Resolve the agent-relay-broker binary path.
 *
 * Search order:
 *   1. SDK's bin/ directory (resolved via createRequire or import.meta.url)
 *   2. Platform-specific name (agent-relay-broker-{platform}-{arch}) in bin/
 *   3. PATH lookup via `which` / `where`
 *
 * @returns Absolute path to the broker binary, or null if not found
 */
export function getBrokerBinaryPath(): string | null {
  let binDir: string | null = null;
  try {
    // Use createRequire for ESM-compatible require.resolve
    const esmRequire = createRequire(import.meta.url);
    const sdkEntry = esmRequire.resolve('@agent-relay/sdk');
    binDir = join(dirname(sdkEntry), '..', 'bin');
  } catch {
    try {
      // Fallback: derive from import.meta.url
      binDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin');
    } catch {
      // Neither method worked
    }
  }
  if (!binDir) return null;

  // 1. Exact name in bin/
  const exactPath = join(binDir, BROKER_NAME);
  if (existsSync(exactPath)) {
    return exactPath;
  }

  // 2. Platform-specific name in bin/
  const platformSpecific = `${BROKER_NAME}-${process.platform}-${process.arch}`;
  const platformPath = join(binDir, platformSpecific);
  if (existsSync(platformPath)) {
    return platformPath;
  }

  // 3. PATH lookup
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execSync(`${cmd} ${BROKER_NAME}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (result) {
      return result.split('\n')[0].trim();
    }
  } catch {
    // Not found on PATH
  }

  return null;
}
