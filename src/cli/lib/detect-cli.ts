import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { upsertConnectionsManifest } from './connections-file.js';

export const SUPPORTED_CLIS = ['claude', 'codex', 'gemini'] as const;
export type SupportedCli = (typeof SUPPORTED_CLIS)[number];

export const INSTALL_DOCS: Record<SupportedCli, string> = {
  claude: 'https://docs.anthropic.com/claude-code/install',
  codex: 'https://github.com/openai/codex#installation',
  gemini: 'https://github.com/google-gemini/gemini-cli#installation',
};

export type CliDetectErrorCode =
  | 'NEEDS_CLI_INSTALL'
  | 'CLI_VERSION_FAILED'
  | 'UNSUPPORTED_CLI';

export class CliDetectError extends Error {
  readonly code: CliDetectErrorCode;
  readonly exitCode: number;

  constructor(code: CliDetectErrorCode, exitCode: number, message: string) {
    super(message);
    this.name = 'CliDetectError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export interface SpawnLike {
  pid?: number;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  stdout: {
    on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  } | null;
  stderr: {
    on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  } | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface SpawnFn {
  (
    command: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'pipe' },
  ): SpawnLike;
}

export interface DetectCliDeps {
  pathEnv?: string;
  pathExt?: string;
  platform?: NodeJS.Platform;
  accessExecutable?: (filePath: string) => Promise<void>;
  resolveRealPath?: (filePath: string) => string;
  spawn?: SpawnFn;
  versionTimeoutMs?: number;
  tmpDir?: string;
}

export interface FindCliResult {
  binPath: string;
}

export interface ProbeVersionResult {
  version: string;
  raw: string;
}

export interface ConnectCliResult {
  cli: SupportedCli;
  version: string;
  binPath: string;
  manifestPath: string;
}

const DEFAULT_VERSION_TIMEOUT_MS = 5000;

function defaultAccessExecutable(filePath: string): Promise<void> {
  return access(filePath, constants.X_OK);
}

function defaultResolveRealPath(filePath: string): string {
  return realpathSync(filePath);
}

const defaultSpawn: SpawnFn = (command, args, options) =>
  spawn(command, args, options) as unknown as SpawnLike;

function splitPathEnv(pathEnv: string, platform: NodeJS.Platform): string[] {
  const delimiter = platform === 'win32' ? ';' : ':';
  return pathEnv.split(delimiter).filter((segment) => segment.length > 0);
}

function candidateNames(cli: SupportedCli, platform: NodeJS.Platform, pathExt: string): string[] {
  if (platform !== 'win32') {
    return [cli];
  }
  const exts = pathExt
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.length > 0);
  if (exts.length === 0) {
    return [cli, `${cli}.cmd`, `${cli}.exe`];
  }
  return exts.map((ext) => `${cli}${ext}`);
}

export async function findCli(
  cli: SupportedCli,
  deps: DetectCliDeps = {},
): Promise<FindCliResult> {
  const platform = deps.platform ?? process.platform;
  const pathEnv = deps.pathEnv ?? process.env.PATH ?? '';
  const pathExt = deps.pathExt ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const accessExecutable = deps.accessExecutable ?? defaultAccessExecutable;
  const resolveRealPath = deps.resolveRealPath ?? defaultResolveRealPath;

  const segments = splitPathEnv(pathEnv, platform);
  const names = candidateNames(cli, platform, pathExt);

  for (const segment of segments) {
    for (const name of names) {
      const candidate = path.join(segment, name);
      try {
        await accessExecutable(candidate);
      } catch {
        continue;
      }
      try {
        const resolved = resolveRealPath(candidate);
        return { binPath: resolved };
      } catch {
        return { binPath: candidate };
      }
    }
  }

  throw new CliDetectError(
    'NEEDS_CLI_INSTALL',
    2,
    `NEEDS_CLI_INSTALL: ${cli} not found on PATH. Install: ${INSTALL_DOCS[cli]}`,
  );
}

const VERSION_PATTERN = /(\d+\.\d+\.\d+(?:-[A-Za-z0-9.+-]+)?)/;

function buildChildEnv(): NodeJS.ProcessEnv {
  const allow = ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'SystemRoot', 'TEMP', 'TMP'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allow) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

export async function probeVersion(
  binPath: string,
  deps: DetectCliDeps = {},
): Promise<ProbeVersionResult> {
  const spawnImpl = deps.spawn ?? defaultSpawn;
  const timeoutMs = deps.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
  const cwd = deps.tmpDir ?? os.tmpdir();
  const env = buildChildEnv();

  return new Promise<ProbeVersionResult>((resolve, reject) => {
    let child: SpawnLike;
    try {
      child = spawnImpl(binPath, ['--version'], { cwd, env, stdio: 'pipe' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reject(
        new CliDetectError(
          'CLI_VERSION_FAILED',
          3,
          `CLI_VERSION_FAILED: failed to spawn ${binPath} --version: ${message}`,
        ),
      );
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // best-effort kill
      }
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new CliDetectError(
          'CLI_VERSION_FAILED',
          3,
          `CLI_VERSION_FAILED: ${binPath} --version failed: ${err.message}`,
        ),
      );
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new CliDetectError(
            'CLI_VERSION_FAILED',
            3,
            `CLI_VERSION_FAILED: ${binPath} --version timed out after ${timeoutMs}ms`,
          ),
        );
        return;
      }
      if (code !== 0) {
        const firstStderr = stderr.split(/\r?\n/)[0] ?? '';
        const reason = firstStderr.length > 0 ? firstStderr : `exit ${code} signal ${signal ?? 'none'}`;
        reject(
          new CliDetectError(
            'CLI_VERSION_FAILED',
            3,
            `CLI_VERSION_FAILED: ${binPath} found but \`--version\` failed: ${reason}`,
          ),
        );
        return;
      }
      const raw = stdout;
      const match = raw.match(VERSION_PATTERN);
      const version = match ? match[1] : 'unknown';
      resolve({ version, raw });
    });
  });
}

export async function connectCli(
  cli: SupportedCli,
  deps: DetectCliDeps = {},
): Promise<ConnectCliResult> {
  const { binPath } = await findCli(cli, deps);
  const { version, raw } = await probeVersion(binPath, deps);
  const connectedAt = new Date().toISOString();
  const { manifestPath } = await upsertConnectionsManifest({
    cli,
    binPath,
    version,
    rawVersionOutput: raw,
    connectedAt,
  });
  return { cli, version, binPath, manifestPath };
}
