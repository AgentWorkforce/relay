/**
 * Machine ID utilities for anonymous user identification.
 * Uses existing machine-id file at ~/.local/share/agent-relay/machine-id
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function getMachineIdPath(): string {
  const dataDir = process.env.AGENT_RELAY_DATA_DIR ||
    path.join(os.homedir(), '.local', 'share', 'agent-relay');
  return path.join(dataDir, 'machine-id');
}

/**
 * Load or generate machine ID using atomic file creation to avoid race conditions.
 */
export function loadMachineId(): string {
  const machineIdPath = getMachineIdPath();

  try {
    return fs.readFileSync(machineIdPath, 'utf-8').trim();
  } catch (readErr: unknown) {
    if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') {
      return `${os.hostname()}-${Date.now().toString(36)}`;
    }

    try {
      const dataDir = path.dirname(machineIdPath);
      fs.mkdirSync(dataDir, { recursive: true });

      const machineId = `${os.hostname()}-${randomBytes(8).toString('hex')}`;

      // O_CREAT | O_EXCL fails if file exists - prevents race condition
      const fd = fs.openSync(machineIdPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeSync(fd, machineId);
      fs.closeSync(fd);

      return machineId;
    } catch (writeErr: unknown) {
      // Another process created the file first
      if ((writeErr as NodeJS.ErrnoException).code === 'EEXIST') {
        try {
          return fs.readFileSync(machineIdPath, 'utf-8').trim();
        } catch {
          // Fall through
        }
      }
      return `${os.hostname()}-${Date.now().toString(36)}`;
    }
  }
}

/** SHA256 hash of machine ID, truncated to 16 chars */
export function createAnonymousId(): string {
  const machineId = loadMachineId();
  return createHash('sha256')
    .update(machineId)
    .digest('hex')
    .substring(0, 16);
}
