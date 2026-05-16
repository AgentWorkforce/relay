import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { SupportedCli } from './detect-cli.js';

export const CONNECTIONS_MANIFEST_VERSION = 1;

export interface CliEntry {
  cli: SupportedCli;
  binPath: string;
  version: string;
  rawVersionOutput: string;
  connectedAt: string;
}

export interface CliEntryRecord {
  binPath: string;
  version: string;
  rawVersionOutput: string;
  connectedAt: string;
}

export interface ConnectionsManifest {
  version: number;
  updatedAt: string;
  clis: Partial<Record<SupportedCli, CliEntryRecord>>;
}

export interface ConnectionsFileDeps {
  xdgConfigHome?: string;
  homeDir?: string;
  now?: () => string;
  warn?: (message: string) => void;
}

export function xdgConfigHome(deps: ConnectionsFileDeps = {}): string {
  const fromArg = deps.xdgConfigHome;
  if (fromArg && fromArg.length > 0) {
    return fromArg;
  }
  const fromEnv = process.env.XDG_CONFIG_HOME;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  const home = deps.homeDir ?? os.homedir();
  return path.join(home, '.config');
}

export function connectionsFilePath(deps: ConnectionsFileDeps = {}): string {
  return path.join(xdgConfigHome(deps), 'agent-relay', 'connections.json');
}

function emptyManifest(now: string): ConnectionsManifest {
  return { version: CONNECTIONS_MANIFEST_VERSION, updatedAt: now, clis: {} };
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coerceClisField(value: unknown): ConnectionsManifest['clis'] {
  if (!isPlainObject(value)) {
    return {};
  }
  const clis: ConnectionsManifest['clis'] = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== 'claude' && key !== 'codex' && key !== 'gemini') {
      continue;
    }
    if (!isPlainObject(entry)) {
      continue;
    }
    const binPath = typeof entry.binPath === 'string' ? entry.binPath : '';
    const version = typeof entry.version === 'string' ? entry.version : 'unknown';
    const rawVersionOutput =
      typeof entry.rawVersionOutput === 'string' ? entry.rawVersionOutput : '';
    const connectedAt = typeof entry.connectedAt === 'string' ? entry.connectedAt : '';
    clis[key as SupportedCli] = { binPath, version, rawVersionOutput, connectedAt };
  }
  return clis;
}

function coerceManifest(parsed: unknown, now: string): ConnectionsManifest {
  if (!isPlainObject(parsed)) {
    return emptyManifest(now);
  }
  const version = typeof parsed.version === 'number' ? parsed.version : CONNECTIONS_MANIFEST_VERSION;
  const updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now;
  return {
    version,
    updatedAt,
    clis: coerceClisField(parsed.clis),
  };
}

export async function readConnectionsManifest(
  deps: ConnectionsFileDeps = {},
): Promise<ConnectionsManifest> {
  const now = deps.now ? deps.now() : new Date().toISOString();
  const filePath = connectionsFilePath(deps);
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return emptyManifest(now);
    }
    throw err;
  }
  try {
    const parsed = JSON.parse(contents);
    return coerceManifest(parsed, now);
  } catch (err) {
    const warn = deps.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
    const message = err instanceof Error ? err.message : String(err);
    warn(`[agent-relay] connections.json was unreadable (${message}); replacing.`);
    return emptyManifest(now);
  }
}

export interface UpsertResult {
  manifestPath: string;
  manifest: ConnectionsManifest;
}

export async function upsertConnectionsManifest(
  entry: CliEntry,
  deps: ConnectionsFileDeps = {},
): Promise<UpsertResult> {
  const now = deps.now ? deps.now() : new Date().toISOString();
  const manifestPath = connectionsFilePath(deps);
  const parentDir = path.dirname(manifestPath);

  await mkdir(parentDir, { mode: 0o700, recursive: true });
  await ensureDirectoryMode(parentDir, 0o700);

  const existing = await readConnectionsManifest(deps);
  const merged: ConnectionsManifest = {
    // Never downgrade an existing manifest. If a future agent-relay release
    // bumps CONNECTIONS_MANIFEST_VERSION and writes extra fields, an older
    // binary running upsert here would otherwise reset the version back to
    // its own (smaller) value and trick the future binary into ignoring its
    // own forward-compatible fields. readConnectionsManifest already
    // preserves the higher version on read; we now preserve it on write too.
    version: Math.max(existing.version, CONNECTIONS_MANIFEST_VERSION),
    updatedAt: now,
    clis: {
      ...existing.clis,
      [entry.cli]: {
        binPath: entry.binPath,
        version: entry.version,
        rawVersionOutput: entry.rawVersionOutput,
        connectedAt: entry.connectedAt,
      },
    },
  };

  const body = `${JSON.stringify(merged, null, 2)}\n`;
  await writeFile(manifestPath, body, { mode: 0o600 });
  await ensureFileMode(manifestPath, 0o600);

  return { manifestPath, manifest: merged };
}

async function ensureDirectoryMode(dirPath: string, mode: number): Promise<void> {
  try {
    const stats = await stat(dirPath);
    if ((stats.mode & 0o777) !== mode) {
      const fs = await import('node:fs/promises');
      await fs.chmod(dirPath, mode);
    }
  } catch {
    // Best-effort; if chmod is unsupported (e.g., Windows) we don't fail the write.
  }
}

async function ensureFileMode(filePath: string, mode: number): Promise<void> {
  try {
    const stats = await stat(filePath);
    if ((stats.mode & 0o777) !== mode) {
      const fs = await import('node:fs/promises');
      await fs.chmod(filePath, mode);
    }
  } catch {
    // Best-effort.
  }
}
