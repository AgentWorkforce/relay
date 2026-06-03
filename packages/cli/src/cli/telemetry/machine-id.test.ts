import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDistinctId, getMachineIdPath, loadMachineId } from './machine-id.js';

describe('telemetry machine id', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-telemetry-machine-'));
    vi.stubEnv('AGENT_RELAY_DATA_DIR', dataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('reads an existing machine id and derives a truncated sha256 distinct id', () => {
    fs.mkdirSync(path.dirname(getMachineIdPath()), { recursive: true });
    fs.writeFileSync(getMachineIdPath(), 'machine-id-123\n', 'utf-8');

    expect(loadMachineId()).toBe('machine-id-123');
    expect(createDistinctId()).toBe(
      createHash('sha256').update('machine-id-123').digest('hex').substring(0, 16)
    );
  });

  it('creates a machine id when none exists', () => {
    const machineId = loadMachineId();

    expect(machineId).toMatch(new RegExp(`^${os.hostname()}-[a-f0-9]{16}$`));
    expect(fs.readFileSync(getMachineIdPath(), 'utf-8')).toBe(machineId);
  });

  it('falls back to an ephemeral id when the path cannot be read as a file', () => {
    fs.mkdirSync(getMachineIdPath(), { recursive: true });

    expect(loadMachineId()).toMatch(new RegExp(`^${os.hostname()}-[a-z0-9]+$`));
  });
});
