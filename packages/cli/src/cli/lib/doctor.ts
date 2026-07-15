import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { getProjectPaths } from '@agent-relay/config';
import { HarnessDriverClient, type BrokerStatus } from '@agent-relay/harness-driver';
import { readNodeDeliveryStatus } from './broker-lifecycle.js';

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

interface DoctorBrokerConnection {
  url: string;
  api_key: string;
  pid: number;
}

interface BrokerProcessInfo {
  pid: number;
  command: string;
}

function parseBrokerConnection(raw: string): DoctorBrokerConnection | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as { url?: unknown }).url === 'string' &&
      typeof (parsed as { api_key?: unknown }).api_key === 'string' &&
      typeof (parsed as { pid?: unknown }).pid === 'number' &&
      (parsed as { pid: number }).pid > 0
    ) {
      const conn = parsed as DoctorBrokerConnection;
      return { url: conn.url, api_key: conn.api_key, pid: conn.pid };
    }
  } catch {
    // Handled by caller as invalid metadata.
  }
  return null;
}

function readBrokerConnectionFile(dataDir: string): {
  path: string;
  exists: boolean;
  conn: DoctorBrokerConnection | null;
} {
  const connPath = path.join(dataDir, 'connection.json');
  if (!fs.existsSync(connPath)) {
    return { path: connPath, exists: false, conn: null };
  }

  try {
    return {
      path: connPath,
      exists: true,
      conn: parseBrokerConnection(fs.readFileSync(connPath, 'utf-8')),
    };
  } catch {
    return { path: connPath, exists: true, conn: null };
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parsePsLine(line: string): BrokerProcessInfo | null {
  const match = line.match(/^\s*(\d+)\s+(.+)$/);
  if (!match) return null;
  const pid = Number.parseInt(match[1], 10);
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return null;
  return { pid, command: match[2] };
}

function findLiveBrokerProcesses(projectRoot: string, dataDir: string): BrokerProcessInfo[] {
  let output: string;
  try {
    output = execFileSync('ps', ['axo', 'pid=,command='], { encoding: 'utf-8' });
  } catch {
    return [];
  }

  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedDataDir = path.resolve(dataDir);
  const brokerName = path.basename(resolvedProjectRoot);
  return output
    .split('\n')
    .map(parsePsLine)
    .filter((processInfo): processInfo is BrokerProcessInfo => processInfo !== null)
    .filter((processInfo) => processInfo.command.includes('agent-relay-broker'))
    .filter(
      (processInfo) =>
        processInfo.command.includes(resolvedProjectRoot) ||
        processInfo.command.includes(resolvedDataDir) ||
        (brokerName !== '' && processInfo.command.includes(`--name ${brokerName}`))
    );
}

function unresolvedTemplate(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/\$\{[^}]+\}/);
  return match?.[0] ?? null;
}

async function checkBrokerReliability(): Promise<CheckResult[]> {
  let client: HarnessDriverClient | undefined;
  const paths = getProjectPaths();
  const connection = readBrokerConnectionFile(paths.dataDir);
  const hasRelayWorkspaceKeyTemplate = unresolvedTemplate(process.env.RELAY_WORKSPACE_KEY) !== null;
  const hasLegacyRelayKeyTemplate = unresolvedTemplate(process.env.RELAY_API_KEY) !== null;
  const hasUnresolvedRelayKeyTemplate = hasRelayWorkspaceKeyTemplate || hasLegacyRelayKeyTemplate;
  const relayKeyEnvName = hasRelayWorkspaceKeyTemplate ? 'RELAY_WORKSPACE_KEY' : 'RELAY_API_KEY';
  const relayKeyTemplateResult: CheckResult | null = hasUnresolvedRelayKeyTemplate
    ? {
        name: 'Agent Relay workspace key',
        ok: false,
        message: `Unresolved ${relayKeyEnvName} template`,
        remediation: 'Export a real rk_live_... workspace key instead of a literal ${...} placeholder.',
      }
    : null;

  if (!connection.exists) {
    const liveBrokers = findLiveBrokerProcesses(paths.projectRoot, paths.dataDir);
    if (liveBrokers.length > 0) {
      return [
        ...(relayKeyTemplateResult ? [relayKeyTemplateResult] : []),
        {
          name: 'Broker connection',
          ok: false,
          message: `Broker process alive but ${relativePath(connection.path)} is missing (pid${liveBrokers.length === 1 ? '' : 's'}: ${liveBrokers.map((processInfo) => processInfo.pid).join(', ')})`,
          remediation:
            'Run `agent-relay down --force`, then `agent-relay up` to clear the half-started broker.',
        },
        {
          name: 'Outbound queues',
          ok: true,
          message: 'Skipped (broker connection metadata missing)',
        },
      ];
    }

    return [
      ...(relayKeyTemplateResult ? [relayKeyTemplateResult] : []),
      {
        name: 'Broker connection',
        ok: true,
        message: 'Skipped (broker not running: no connection metadata found)',
      },
      {
        name: 'Outbound queues',
        ok: true,
        message: 'Skipped (broker not running)',
      },
    ];
  }

  if (!connection.conn) {
    return [
      ...(relayKeyTemplateResult ? [relayKeyTemplateResult] : []),
      {
        name: 'Broker connection',
        ok: false,
        message: `Invalid broker connection metadata at ${relativePath(connection.path)}`,
        remediation: 'Run `agent-relay down --force`, then `agent-relay up` to rewrite connection metadata.',
      },
      {
        name: 'Outbound queues',
        ok: true,
        message: 'Skipped (broker connection metadata invalid)',
      },
    ];
  }

  if (!isProcessRunning(connection.conn.pid)) {
    return [
      ...(relayKeyTemplateResult ? [relayKeyTemplateResult] : []),
      {
        name: 'Broker connection',
        ok: false,
        message: `Stale broker connection metadata: pid ${connection.conn.pid} is not running`,
        remediation:
          'Run `agent-relay down --force`, then `agent-relay up` to remove stale connection metadata.',
      },
      {
        name: 'Outbound queues',
        ok: true,
        message: 'Skipped (broker process is not running)',
      },
    ];
  }

  try {
    client = HarnessDriverClient.connect({ cwd: process.cwd() });
    const status = await client.getStatus();
    const typedStatus = status as BrokerStatus;
    const auth = typedStatus.auth;
    const authMessage = auth?.authenticated
      ? `Authenticated (${auth.workspace_count} workspace${auth.workspace_count === 1 ? '' : 's'})`
      : 'No authenticated Relaycast workspace reported by broker';
    const pending = typedStatus.pending_deliveries ?? [];
    const stuck = pending.filter((delivery) => (delivery.age_ms ?? 0) >= 10_000 || delivery.last_error);
    const nodeDelivery = readNodeDeliveryStatus(typedStatus);
    const nodeDeliveryOk = Boolean(nodeDelivery?.tokenPresent && nodeDelivery.connected);
    const nodeDeliveryMessage = !nodeDelivery
      ? 'Node delivery status unavailable'
      : nodeDelivery.connected
        ? 'Node delivery connected'
        : nodeDelivery.tokenPresent
          ? 'Node token present, but /v1/node/ws is disconnected'
          : 'No node token; /v1/node/ws cannot connect';
    return [
      ...(relayKeyTemplateResult ? [relayKeyTemplateResult] : []),
      {
        name: 'Broker connection',
        ok: true,
        message: `Reachable at ${connection.conn.url} (pid ${connection.conn.pid})`,
      },
      {
        name: 'Broker auth',
        ok: true,
        message: authMessage,
      },
      {
        name: 'Node delivery',
        ok: nodeDeliveryOk,
        message: nodeDeliveryMessage,
        remediation: !nodeDeliveryOk
          ? 'Check broker logs for create_node/node token errors; realtime injection requires an active /v1/node/ws connection.'
          : undefined,
      },
      {
        name: 'Outbound queues',
        ok: stuck.length === 0,
        message:
          pending.length === 0
            ? 'No pending deliveries'
            : `${pending.length} pending deliver${pending.length === 1 ? 'y' : 'ies'}, ${stuck.length} stuck`,
        remediation:
          stuck.length > 0
            ? 'Check agent-relay who --json for blocked_on_send agents and inspect pending_deliveries in /api/status.'
            : undefined,
      },
    ];
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return [
      ...(relayKeyTemplateResult ? [relayKeyTemplateResult] : []),
      {
        name: 'Broker connection',
        ok: false,
        message: `Stale or unreachable broker connection metadata: ${message}`,
        remediation:
          'Run `agent-relay status --wait-for=10` to confirm readiness, or `agent-relay down --force` before retrying.',
      },
      {
        name: 'Outbound queues',
        ok: true,
        message: 'Skipped (broker unavailable)',
      },
    ];
  } finally {
    await client?.shutdown().catch(() => undefined);
  }
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
    } catch {
      /* ignore */
    }
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
    ok: true,
    message: 'Memory fallback (no SQLite driver available)',
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
      ok: true,
      message: 'Skipped (no SQLite driver available)',
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
    const insert = db.prepare(
      'INSERT OR REPLACE INTO doctor_diagnostics (key, value, created_at) VALUES (?, ?, ?)'
    );
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
      ok: true,
      message: 'Skipped (no SQLite driver available)',
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
    const lines = fs
      .readFileSync(statusPath, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
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
  const storageType = (process.env.AGENT_RELAY_STORAGE_TYPE ?? 'sqlite').toLowerCase();
  const dbPath = process.env.AGENT_RELAY_STORAGE_PATH ?? paths.dbPath;
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
  results.push(...(await checkBrokerReliability()));

  printHeader();
  printInstallationStatus(installationStatus);
  results.forEach((res) => printResult(res));
  console.log('');

  const failed = results.some((r) => {
    // Individual driver availability is informational — missing drivers are
    // warnings, not failures, because the system falls back to memory storage.
    if (r.name === 'better-sqlite3' || r.name === 'node:sqlite') {
      return false;
    }
    return !r.ok;
  });
  const hasWarnings = results.some((r) => !r.ok) && !failed;
  const statusMessage = failed
    ? 'Some checks failed ✗'
    : hasWarnings
      ? 'Checks passed with warnings ⚠'
      : 'All checks passed ✓';
  console.log(`Status: ${statusMessage}`);

  process.exitCode = failed ? 1 : 0;
}
