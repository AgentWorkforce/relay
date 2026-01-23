/**
 * Machine ID utilities for anonymous user identification.
 * Uses the existing machine-id file at ~/.local/share/agent-relay/machine-id
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Get the path to the machine-id file.
 */
export function getMachineIdPath(): string {
  const dataDir = process.env.AGENT_RELAY_DATA_DIR ||
    path.join(os.homedir(), '.local', 'share', 'agent-relay');
  return path.join(dataDir, 'machine-id');
}

/**
 * Load or generate the machine ID.
 * This matches the existing behavior in cloud-sync.ts
 */
export function loadMachineId(): string {
  const machineIdPath = getMachineIdPath();

  try {
    if (fs.existsSync(machineIdPath)) {
      return fs.readFileSync(machineIdPath, 'utf-8').trim();
    }

    // Generate new machine ID
    const machineId = `${os.hostname()}-${randomBytes(8).toString('hex')}`;
    const dataDir = path.dirname(machineIdPath);

    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(machineIdPath, machineId);

    return machineId;
  } catch {
    // Fallback: generate ephemeral ID
    return `${os.hostname()}-${Date.now().toString(36)}`;
  }
}

/**
 * Create an anonymous ID from the machine ID using SHA256 hash.
 * The hash is truncated to 16 characters for brevity while maintaining uniqueness.
 *
 * @returns A 16-character hex string derived from the machine ID
 */
export function createAnonymousId(): string {
  const machineId = loadMachineId();
  return createHash('sha256')
    .update(machineId)
    .digest('hex')
    .substring(0, 16);
}
