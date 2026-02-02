import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

let tempRoot: string;
let dataDir: string;
let storageConfig: { type?: string; path?: string };
let mockStore: Map<string, string>;

// Store availability in an object to ensure closure works correctly across module resets
const mockAvailability = { betterAvailable: true, nodeAvailable: true };

vi.mock('@agent-relay/config', () => ({
  getProjectPaths: () => ({
    dataDir,
    teamDir: path.join(dataDir, 'team'),
    dbPath: path.join(dataDir, 'messages.sqlite'),
    socketPath: path.join(dataDir, 'relay.sock'),
    projectRoot: tempRoot,
    projectId: 'test-project',
  }),
}));

vi.mock('@agent-relay/storage/adapter', () => ({
  getStorageConfigFromEnv: () => storageConfig,
}));

vi.mock('better-sqlite3', () => {
  class MockBetterSqlite {
    private store = mockStore;

    constructor(_dbPath: string) {
      if (!mockAvailability.betterAvailable) {
        throw new Error('better-sqlite3 missing');
      }
    }

    prepare(sql: string) {
      if (sql.includes('INSERT OR REPLACE INTO doctor_diagnostics')) {
        return {
          run: (key: string, value: string) => {
            this.store.set(key, value);
          },
        };
      }
      if (sql.includes('SELECT value FROM doctor_diagnostics')) {
        return {
          get: (key: string) =>
            this.store.has(key) ? { value: this.store.get(key) } : undefined,
        };
      }
      if (sql.includes('DELETE FROM doctor_diagnostics')) {
        return {
          run: (key: string) => {
            this.store.delete(key);
          },
        };
      }
      return {
        run: () => {},
        get: () => ({ result: 1 }),
      };
    }

    exec(_sql: string) {
      // no-op
    }

    close() {
      // no-op
    }
  }

  return { default: MockBetterSqlite };
});

vi.mock('node:sqlite', () => {
  class MockNodeSqlite {
    private store = mockStore;

    constructor(_dbPath: string) {
      // Check mockAvailability object to ensure we get the current value
      if (!mockAvailability.nodeAvailable) {
        throw new Error('node:sqlite missing');
      }
    }

        exec(_sql: string) {
          // no-op
        }

        prepare(sql: string) {
          if (sql.includes('INSERT OR REPLACE INTO doctor_diagnostics')) {
            return {
              run: (key: string, value: string) => {
                this.store.set(key, value);
              },
            };
          }
          if (sql.includes('SELECT value FROM doctor_diagnostics')) {
            return {
              get: (key: string) =>
                this.store.has(key) ? { value: this.store.get(key) } : undefined,
            };
          }
          if (sql.includes('DELETE FROM doctor_diagnostics')) {
            return {
              run: (key: string) => {
                this.store.delete(key);
              },
            };
          }
          return {
            run: () => {},
            get: () => ({ result: 1 }),
          };
        }

        close() {
          // no-op
        }
      }

  return { DatabaseSync: MockNodeSqlite };
});

async function loadDoctor() {
  const module = await import('./doctor.js');
  return module;
}

function collectLogs() {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
    logs.push(args.join(' '));
  });

  return {
    logs,
    restore: () => logSpy.mockRestore(),
  };
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
  dataDir = path.join(tempRoot, '.agent-relay');
  storageConfig = {
    type: 'sqlite',
    path: path.join(dataDir, 'messages.sqlite'),
  };
  mockStore = new Map<string, string>();
  mockAvailability.betterAvailable = true;
  mockAvailability.nodeAvailable = true;
  process.env.AGENT_RELAY_DOCTOR_NODE_VERSION = '22.1.0';
  delete process.env.AGENT_RELAY_DOCTOR_FORCE_NODE_SQLITE;
  delete process.env.AGENT_RELAY_DOCTOR_NODE_SQLITE_AVAILABLE;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  delete process.env.AGENT_RELAY_DOCTOR_NODE_VERSION;
  delete process.env.AGENT_RELAY_DOCTOR_NODE_SQLITE_AVAILABLE;
  delete process.env.AGENT_RELAY_DOCTOR_FORCE_BETTER_SQLITE3;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('doctor diagnostics', () => {
  it('reports success when drivers are available and storage is writable', async () => {
    process.env.AGENT_RELAY_DOCTOR_FORCE_NODE_SQLITE = '1';
    process.env.AGENT_RELAY_DOCTOR_FORCE_BETTER_SQLITE3 = '1';
    const { logs, restore } = collectLogs();
    const { runDoctor } = await loadDoctor();

    await runDoctor();

    restore();
    expect(logs.join('\n')).toContain('Installation Status');
    expect(logs.join('\n')).toContain('All checks passed');
    expect(process.exitCode).toBe(0);
  });

  it('shows remediation for node:sqlite on older Node versions', async () => {
    process.env.AGENT_RELAY_DOCTOR_NODE_VERSION = '18.2.0';
    delete process.env.AGENT_RELAY_DOCTOR_FORCE_NODE_SQLITE;
    const { logs, restore } = collectLogs();
    const { runDoctor } = await loadDoctor();

    await runDoctor();

    restore();
    const output = logs.join('\n');
    expect(output).toContain('node:sqlite');
    expect(output).toContain('Upgrade to Node 22+ or install better-sqlite3');
    expect(process.exitCode).toBe(1);
  });

  it('fails gracefully when no SQLite drivers are available', async () => {
    mockAvailability.betterAvailable = false;
    mockAvailability.nodeAvailable = false;
    process.env.AGENT_RELAY_DOCTOR_NODE_SQLITE_AVAILABLE = '0';
    delete process.env.AGENT_RELAY_DOCTOR_FORCE_NODE_SQLITE;

    const { logs, restore } = collectLogs();
    const { runDoctor } = await loadDoctor();

    await runDoctor();

    restore();
    const output = logs.join('\n');
    expect(output).toContain('better-sqlite3: Not available');
    expect(output).toContain('node:sqlite: Not available');
    expect(output).toContain('Could not write (no SQLite driver available)');
    expect(process.exitCode).toBe(1);
  });

  it('includes installation status details when storage-status.txt exists', async () => {
    process.env.AGENT_RELAY_DOCTOR_FORCE_NODE_SQLITE = '1';
    fs.mkdirSync(dataDir, { recursive: true });
    const statusPath = path.join(dataDir, 'storage-status.txt');
    fs.writeFileSync(
      statusPath,
      [
        'status: degraded',
        'driver: node:sqlite',
        'detail: better-sqlite3 rebuild failed',
        'node: v22.1.0',
        'platform: test-os',
        `timestamp: ${new Date().toISOString()}`,
      ].join('\n'),
      'utf-8'
    );

    const { logs, restore } = collectLogs();
    const { runDoctor } = await loadDoctor();

    await runDoctor();

    restore();
    const output = logs.join('\n');
    expect(output).toContain('Installation Status');
    expect(output).toContain('Driver detected: node:sqlite');
    expect(output).toContain('better-sqlite3 rebuild failed');
  });

  it('reports disk space check as unsupported when statfs is unavailable', async () => {
    process.env.AGENT_RELAY_DOCTOR_FORCE_NODE_SQLITE = '1';
    process.env.AGENT_RELAY_DOCTOR_FORCE_BETTER_SQLITE3 = '1';
    vi.spyOn(fs, 'statfsSync').mockImplementation(() => {
      const err: any = new Error('not implemented');
      err.code = 'ERR_METHOD_NOT_IMPLEMENTED';
      throw err;
    });

    const { logs, restore } = collectLogs();
    const { runDoctor } = await loadDoctor();

    await runDoctor();

    restore();
    const output = logs.join('\n');
    expect(output).toContain('Check not supported on this platform');
    expect(process.exitCode).toBe(0);
  });

  it('fails database permission check when access is denied', async () => {
    vi.spyOn(fs, 'accessSync').mockImplementation(() => {
      const err: any = new Error('EACCES');
      err.code = 'EACCES';
      throw err;
    });

    const { logs, restore } = collectLogs();
    const { runDoctor } = await loadDoctor();

    await runDoctor();

    restore();
    const output = logs.join('\n');
    expect(output).toContain('Database file:');
    expect(output).toContain('unreadable or unwritable');
    expect(process.exitCode).toBe(1);
  });
});
