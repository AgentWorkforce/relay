import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getProjectPaths } from '@agent-relay/config';
import { getStorageConfigFromEnv } from '@agent-relay/storage/adapter';

type SqliteDriver = 'better-sqlite3' | 'node';

interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
  remediation?: string;
}

interface DriverAvailability {
  betterSqlite3: boolean;
  nodeSqlite: boolean;
}

interface InstallationStatus {
  status?: string;
  driver?: string;
  detail?: string;
  node?: string;
  platform?: string;
  timestamp?: string;
  fallback?: string;
  found: boolean;
  error?: string;
  path: string;
}

interface DiagnosticDb {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...params: any[]) => unknown; get: (...params: any[]) => any };
  close?: () => void;
}

const require = createRequire(import.meta.url);

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const display = value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${display} ${units[unitIndex]}`;
}

function relativePath(target: string): string {
  const rel = path.relative(process.cwd(), target);
  return rel && !rel.startsWith('..') ? rel : target;
}

function parseNodeVersion(): { major: number; minor: number; patch: number; raw: string } {
  const rawVersion = process.env.AGENT_RELAY_DOCTOR_NODE_VERSION || process.versions.node;
  const parts = rawVersion.split('.').map((n) => parseInt(n, 10));
  const [major = 0, minor = 0, patch = 0] = parts;
  return { major, minor, patch, raw: rawVersion };
}

async function checkBetterSqlite3(): Promise<CheckResult> {
  // Allow tests to force better-sqlite3 availability status
  if (process.env.AGENT_RELAY_DOCTOR_FORCE_BETTER_SQLITE3 === '1') {
    return {
      name: 'better-sqlite3',
      ok: true,
      message: 'Available (test mode)',
    };
  }
  if (process.env.AGENT_RELAY_DOCTOR_FORCE_BETTER_SQLITE3 === '0') {
    return {
      name: 'better-sqlite3',
      ok: false,
      message: 'Not available',
      remediation: 'npm rebuild better-sqlite3',
    };
  }

  try {
    // Use dynamic import for better-sqlite3
    const mod = await import('better-sqlite3');
    const DatabaseCtor: any = (mod as any).default ?? mod;
    // Quick sanity check to ensure native binding works
    const db = new DatabaseCtor(':memory:');
    db.prepare('SELECT 1').get();
    db.close?.();
    // Try to get version, but don't fail if package.json can't be read
    let version = 'unknown';
    try {
      const { createRequire } = await import('node:module');
      const require = createRequire(import.meta.url);
      const pkg = require('better-sqlite3/package.json');
      version = pkg.version ?? 'unknown';
    } catch { /* ignore */ }
    return {
      name: 'better-sqlite3',
      ok: true,
      message: `Available (v${version})`,
    };
  } catch {
    return {
      name: 'better-sqlite3',
      ok: false,
      message: 'Not available',
      remediation: 'npm rebuild better-sqlite3',
    };
  }
}

async function checkNodeSqlite(): Promise<CheckResult> {
  const nodeVersion = parseNodeVersion();
  if (process.env.AGENT_RELAY_DOCTOR_FORCE_NODE_SQLITE === '1') {
    return {
      name: 'node:sqlite',
      ok: true,
      message: `Available (Node ${nodeVersion.raw})`,
    };
  }

  if (process.env.AGENT_RELAY_DOCTOR_NODE_SQLITE_AVAILABLE === '0') {
    return {
      name: 'node:sqlite',
      ok: false,
      message: `Not available (Node ${nodeVersion.raw})`,
      remediation: 'Upgrade to Node 22+ or install better-sqlite3',
    };
  }

  if (nodeVersion.major < 22) {
    return {
      name: 'node:sqlite',
      ok: false,
      message: `Not available (Node ${nodeVersion.raw})`,
      remediation: 'Upgrade to Node 22+ or install better-sqlite3',
    };
  }

  try {
    const mod: any = require('node:sqlite');
    const db = new mod.DatabaseSync(':memory:');
    db.exec('SELECT 1');
    db.close?.();
    return {
      name: 'node:sqlite',
      ok: true,
      message: `Available (Node ${nodeVersion.raw})`,
    };
  } catch {
    return {
      name: 'node:sqlite',
      ok: false,
      message: `Not available (Node ${nodeVersion.raw})`,
      remediation: 'Upgrade to Node 22+ or install better-sqlite3',
    };
  }
}

function resolveDriverPreference(): SqliteDriver[] {
  const raw = process.env.AGENT_RELAY_SQLITE_DRIVER?.trim().toLowerCase();
  if (!raw) return ['better-sqlite3', 'node'];
  if (raw === 'node' || raw === 'node:sqlite' || raw === 'nodesqlite') {
    return ['node', 'better-sqlite3'];
  }
  if (raw === 'better' || raw === 'better-sqlite3' || raw === 'bss') {
    return ['better-sqlite3', 'node'];
  }
  return ['better-sqlite3', 'node'];
}

function pickDriver(availability: DriverAvailability): SqliteDriver | null {
  for (const driver of resolveDriverPreference()) {
    if (driver === 'better-sqlite3' && availability.betterSqlite3) return driver;
    if (driver === 'node' && availability.nodeSqlite) return driver;
  }
  if (availability.betterSqlite3) return 'better-sqlite3';
  if (availability.nodeSqlite) return 'node';
  return null;
}

function describeCurrentAdapter(
  storageType: string,
  dbPath: string,
  availability: DriverAvailability
): CheckResult {
  const type = storageType.toLowerCase();

  if (type === 'none' || type === 'memory') {
    return {
      name: 'Current adapter',
      ok: true,
      message: 'In-memory (no persistence)',
    };
  }

  if (type === 'jsonl') {
    return {
      name: 'Current adapter',
      ok: true,
      message: 'JSONL (append-only files)',
    };
  }

  if (type === 'postgres' || type === 'postgresql') {
    return {
      name: 'Current adapter',
      ok: false,
      message: 'PostgreSQL (not implemented)',
      remediation: 'Use sqlite storage or in-memory mode',
    };
  }

  const driver = pickDriver(availability);
  if (driver) {
    const driverLabel = driver === 'node' ? 'node:sqlite' : 'better-sqlite3';
    return {
      name: 'Current adapter',
      ok: true,
      message: `SQLite (${driverLabel})`,
    };
  }

  return {
    name: 'Current adapter',
    ok: false,
    message: `SQLite drivers unavailable for ${relativePath(dbPath)}`,
    remediation: 'Upgrade to Node 22+ or run: npm rebuild better-sqlite3',
  };
}

async function checkDbPermissions(
  storageType: string,
  dbPath: string,
  dataDir: string
): Promise<CheckResult> {
  if (storageType === 'none' || storageType === 'memory') {
    return {
      name: 'Database file',
      ok: true,
      message: 'Not applicable (in-memory storage)',
    };
  }

  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  } catch {
    // Best effort – handled below
  }

  const displayPath = relativePath(dbPath);
  const exists = fs.existsSync(dbPath);

  try {
    const target = exists ? dbPath : dataDir;
    fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK);
    const size = exists ? fs.statSync(dbPath).size : 0;
    const mode = exists ? 'rw' : 'rw (file will be created on first write)';
    const sizeDisplay = exists ? `, ${formatBytes(size)}` : '';
    return {
      name: 'Database file',
      ok: true,
      message: `${displayPath} (${mode}${sizeDisplay})`,
    };
  } catch {
    return {
      name: 'Database file',
      ok: false,
      message: `${displayPath} (unreadable or unwritable)`,
      remediation: `Check permissions for ${displayPath} or its parent directory`,
    };
  }
}

async function checkDiskSpace(dataDir: string): Promise<CheckResult> {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const stats = fs.statfsSync(dataDir);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    return {
      name: 'Disk space',
      ok: true,
      message: `${formatBytes(freeBytes)} available`,
    };
  } catch (err: any) {
    const message = typeof err?.message === 'string' ? err.message.toLowerCase() : '';
    if (err?.code === 'ERR_METHOD_NOT_IMPLEMENTED' || message.includes('not implemented')) {
      return {
        name: 'Disk space',
        ok: true,
        message: 'Check not supported on this platform',
      };
    }
    return {
      name: 'Disk space',
      ok: false,
      message: 'Could not determine free space',
      remediation: `Ensure ${relativePath(dataDir)} exists and is readable`,
    };
  }
}

async function openDiagnosticDb(dbPath: string, driver: SqliteDriver): Promise<DiagnosticDb> {
  if (driver === 'node') {
    const mod: any = require('node:sqlite');
    const db = new mod.DatabaseSync(dbPath);
    return db as DiagnosticDb;
  }

  const mod = await import('better-sqlite3');
  const DatabaseCtor: any = (mod as any).default ?? mod;
  const db: any = new DatabaseCtor(dbPath);
  return db as DiagnosticDb;
}

async function checkWriteTest(
  storageType: string,
  dbPath: string,
  availability: DriverAvailability,
  key: string,
  value: string
): Promise<CheckResult> {
  if (storageType === 'none' || storageType === 'memory') {
    return {
      name: 'Write test',
      ok: true,
      message: 'Skipped (in-memory storage)',
    };
  }
  if (storageType === 'jsonl') {
    return {
      name: 'Write test',
      ok: true,
      message: 'Skipped (JSONL storage)',
    };
  }

  const driver = pickDriver(availability);
  if (!driver) {
    return {
      name: 'Write test',
      ok: false,
      message: 'Could not write (no SQLite driver available)',
      remediation: 'Upgrade to Node 22+ or run: npm rebuild better-sqlite3',
    };
  }

  let db: DiagnosticDb | undefined;
  try {
    db = await openDiagnosticDb(dbPath, driver);
    db.exec(`
      CREATE TABLE IF NOT EXISTS doctor_diagnostics (
        key TEXT PRIMARY KEY,
        value TEXT,
        created_at INTEGER
      );
    `);
    const insert = db.prepare('INSERT OR REPLACE INTO doctor_diagnostics (key, value, created_at) VALUES (?, ?, ?)');
    insert.run(key, value, Date.now());
    db.close?.();
    return {
      name: 'Write test',
      ok: true,
      message: 'OK',
    };
  } catch {
    db?.close?.();
    return {
      name: 'Write test',
      ok: false,
      message: 'Failed to write test message',
      remediation: 'Check database permissions and rebuild SQLite driver',
    };
  }
}

async function checkReadTest(
  storageType: string,
  dbPath: string,
  availability: DriverAvailability,
  key: string,
  expectedValue: string
): Promise<CheckResult> {
  if (storageType === 'none' || storageType === 'memory') {
    return {
      name: 'Read test',
      ok: true,
      message: 'Skipped (in-memory storage)',
    };
  }
  if (storageType === 'jsonl') {
    return {
      name: 'Read test',
      ok: true,
      message: 'Skipped (JSONL storage)',
    };
  }

  const driver = pickDriver(availability);
  if (!driver) {
    return {
      name: 'Read test',
      ok: false,
      message: 'Could not read (no SQLite driver available)',
      remediation: 'Upgrade to Node 22+ or run: npm rebuild better-sqlite3',
    };
  }

  let db: DiagnosticDb | undefined;
  try {
    db = await openDiagnosticDb(dbPath, driver);
    const read = db.prepare('SELECT value FROM doctor_diagnostics WHERE key = ?');
    const row = read.get(key) as { value?: string } | undefined;
    const deleteStmt = db.prepare('DELETE FROM doctor_diagnostics WHERE key = ?');
    deleteStmt.run(key);
    db.close?.();

    if (!row || row.value !== expectedValue) {
      return {
        name: 'Read test',
        ok: false,
        message: 'Failed to read test message',
        remediation: 'Ensure the database file is readable and not locked',
      };
    }

    return {
      name: 'Read test',
      ok: true,
      message: 'OK',
    };
  } catch {
    db?.close?.();
    return {
      name: 'Read test',
      ok: false,
      message: 'Failed to read test message',
      remediation: 'Ensure the database file is readable and not locked',
    };
  }
}

function printHeader(): void {
  console.log('');
  console.log('Storage Diagnostics');
  console.log('═══════════════════');
  console.log('');
}

function printResult(result: CheckResult): void {
  const icon = result.ok ? '✓' : '✗';
  console.log(`${icon} ${result.name}: ${result.message}`);
  if (!result.ok && result.remediation) {
    console.log(`  Fix: ${result.remediation}`);
  }
}

function readInstallationStatus(dataDir: string): InstallationStatus {
  const statusPath = path.join(dataDir, 'storage-status.txt');
  if (!fs.existsSync(statusPath)) {
    return { found: false, path: statusPath };
  }

  try {
    const lines = fs.readFileSync(statusPath, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean);
    const map: Record<string, string> = {};
    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      map[key] = value;
    }

    return {
      found: true,
      path: statusPath,
      status: map['status'],
      driver: map['driver'],
      detail: map['detail'],
      node: map['node'],
      platform: map['platform'],
      timestamp: map['timestamp'],
      fallback: map['fallback'],
    };
  } catch (err: any) {
    return {
      found: false,
      path: statusPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function printInstallationStatus(status: InstallationStatus): void {
  console.log('Installation Status');
  console.log('--------------------');

  if (!status.found) {
    const reason = status.error ? `unreadable (${status.error})` : 'not found';
    console.log(`- Status file ${reason} at ${relativePath(status.path)}`);
    console.log('');
    return;
  }

  const timestamp = status.timestamp ?? 'Unknown time';
  const platform = status.platform ? ` (${status.platform})` : '';
  const driver = status.driver ?? 'Unknown';
  const health = status.status ?? 'unknown';
  const detail = status.detail ?? status.fallback ?? 'None recorded';
  const nodeVersion = status.node ? `Node ${status.node}` : 'Node version unknown';

  console.log(`- Last check: ${timestamp}${platform}`);
  console.log(`- Driver detected: ${driver} (status: ${health})`);
  console.log(`- Detail: ${detail}`);
  console.log(`- ${nodeVersion}`);
  console.log('');
}

// Hook point: extend with StorageHealthCheck once the shared interface is available.
export async function runDoctor(): Promise<void> {
  const paths = getProjectPaths();
  const storageEnv = getStorageConfigFromEnv();
  const storageType = storageEnv.type?.toLowerCase() ?? 'sqlite';
  const dbPath = storageEnv.path ?? paths.dbPath;
  const dataDir = path.dirname(dbPath);
  const installationStatus = readInstallationStatus(paths.dataDir);

  const results: CheckResult[] = [];
  const betterResult = await checkBetterSqlite3();
  const nodeResult = await checkNodeSqlite();

  const availability: DriverAvailability = {
    betterSqlite3: betterResult.ok,
    nodeSqlite: nodeResult.ok,
  };

  results.push(betterResult);
  results.push(nodeResult);
  results.push(describeCurrentAdapter(storageType, dbPath, availability));
  results.push(await checkDbPermissions(storageType, dbPath, dataDir));
  results.push(await checkDiskSpace(dataDir));

  const testKey = `doctor-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const testValue = `ok-${Math.random().toString(16).slice(2)}`;
  const writeResult = await checkWriteTest(storageType, dbPath, availability, testKey, testValue);
  results.push(writeResult);
  const readResult = await checkReadTest(storageType, dbPath, availability, testKey, testValue);
  results.push(readResult);

  printHeader();
  printInstallationStatus(installationStatus);
  results.forEach((res) => printResult(res));
  console.log('');

  const failed = results.some((r) => !r.ok);
  console.log(`Status: ${failed ? 'Some checks failed ✗' : 'All checks passed ✓'}`);

  process.exitCode = failed ? 1 : 0;
}
