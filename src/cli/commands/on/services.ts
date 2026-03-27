import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface ServiceConfigCache {
  relayauthRoot?: string;
  relayfileRoot?: string;
  logDir?: string;
  portAuth?: string | number;
  portFile?: string | number;
  secret?: string;
}

interface PidFile {
  relayauthPid?: number;
  relayfilePid?: number;
}

export interface ServiceConfig {
  relayauthRoot: string; // path to relayauth repo
  relayfileRoot: string; // path to relayfile repo
  secret: string; // shared signing secret
  portAuth: number; // default 8787
  portFile: number; // default 8080
  logDir: string; // .relay/logs/
}

const DEFAULT_PORT_AUTH = 8787;
const DEFAULT_PORT_FILE = 8080;
function getPidFilePath(): string {
  return path.join(os.homedir(), '.relay', 'pids.json');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function getCachedConfig(): ServiceConfigCache {
  const configPath = path.resolve('.relay', 'config.json');
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const data =
      parsed && typeof parsed === 'object' && 'data' in parsed && typeof parsed.data === 'object'
        ? (parsed.data as Record<string, unknown>)
        : parsed;

    const getStringValue = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = data[key];
        if (typeof value === 'string') {
          return value;
        }
      }
      return undefined;
    };

    const getPortValue = (...keys: string[]): string | number | undefined => {
      for (const key of keys) {
        const value = data[key];
        if (typeof value === 'string' || typeof value === 'number') {
          return value;
        }
      }
      return undefined;
    };

    return {
      relayauthRoot: getStringValue('RELAYAUTH_ROOT', 'relayauthRoot'),
      relayfileRoot: getStringValue('RELAYFILE_ROOT', 'relayfileRoot'),
      logDir:
        getStringValue('RELAY_LOG_DIR', 'logDir'),
      portAuth: getPortValue('RELAY_AUTH_PORT', 'portAuth'),
      portFile: getPortValue('RELAY_FILE_PORT', 'portFile'),
      secret:
        typeof data.signing_secret === 'string'
          ? data.signing_secret
          : typeof data.signingSecret === 'string'
            ? data.signingSecret
            : undefined,
    };
  } catch {
    return {};
  }
}

function pickFirst<T>(values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function pickFirstString(values: Array<string | undefined>): string {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return '';
}

function resolveExistingPath(candidates: Array<string | undefined>, fallback: string): string {
  const normalized = candidates.filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
  return path.resolve(normalized.find((candidate) => existsSync(candidate)) ?? normalized[0] ?? fallback);
}

export function resolveServiceConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  const cache = getCachedConfig();
  const cwd = process.cwd();

  const relayauthRoot = resolveExistingPath(
    [
      overrides.relayauthRoot,
      process.env.RELAYAUTH_ROOT,
      cache.relayauthRoot,
      path.join(cwd, 'relayauth'),
      path.join(cwd, '..', 'relayauth'),
      path.join(cwd, '..', '..', 'relayauth'),
    ],
    path.join(cwd, 'relayauth')
  );

  const relayfileRoot = resolveExistingPath(
    [
      overrides.relayfileRoot,
      process.env.RELAYFILE_ROOT,
      cache.relayfileRoot,
      path.join(path.dirname(relayauthRoot), 'relayfile'),
    ],
    path.join(path.dirname(relayauthRoot), 'relayfile')
  );

  const logDir = path.resolve(
    pickFirstString([
      overrides.logDir,
      process.env.RELAY_LOG_DIR,
      cache.logDir,
      path.join('.relay', 'logs'),
    ])
  );

  return {
    relayauthRoot,
    relayfileRoot,
    secret: pickFirstString([
      overrides.secret,
      process.env.SIGNING_KEY,
      cache.secret,
    ]),
    portAuth: parsePositiveInt(
      pickFirst<string | number>([
        process.env.RELAY_AUTH_PORT,
        overrides.portAuth,
        cache.portAuth,
      ]),
      DEFAULT_PORT_AUTH
    ),
    portFile: parsePositiveInt(
      pickFirst<string | number>([
        process.env.RELAY_FILE_PORT,
        overrides.portFile,
        cache.portFile,
      ]),
      DEFAULT_PORT_FILE
    ),
    logDir,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isExecutable(target: string): boolean {
  try {
    accessSync(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readPids(): PidFile | null {
  if (!existsSync(getPidFilePath())) {
    return null;
  }

  try {
    const raw = readFileSync(getPidFilePath(), 'utf-8');
    return JSON.parse(raw) as PidFile;
  } catch {
    return null;
  }
}

function writePids(pids: PidFile): void {
  mkdirSync(path.dirname(getPidFilePath()), { recursive: true });
  writeFileSync(getPidFilePath(), `${JSON.stringify(pids)}\n`, 'utf-8');
}

function removePidsFile(): void {
  if (existsSync(getPidFilePath())) {
    rmSync(getPidFilePath());
  }
}

async function stopPid(pid: number): Promise<void> {
  if (!pid || !isProcessAlive(pid)) {
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }

  for (let i = 0; i < 5; i += 1) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(1000);
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return;
  }
}

function readPortPids(port: number): number[] {
  const result = spawnSync('lsof', ['-ti', `:${port}`], {
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  return result.stdout
    .trim()
    .split('\n')
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

async function stopPortProcess(port: number): Promise<void> {
  const pids = Array.from(new Set(readPortPids(port)));
  await Promise.all(pids.map((pid) => stopPid(pid)));
}

async function checkHealth(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function spawnLogged(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, logPath: string): ChildProcess {
  const logFile = openSync(logPath, 'a');
  try {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', logFile, logFile],
    });
    // Close parent's copy of the fd — child process inherits its own copy
    return child;
  } finally {
    closeSync(logFile);
  }
}

function spawnRelayauth(config: ServiceConfig, relayauthLogPath: string): ChildProcess {
  return spawnLogged(
    'npx',
    ['wrangler', 'dev', '--port', String(config.portAuth)],
    config.relayauthRoot,
    {
      ...process.env,
      SIGNING_KEY: config.secret,
    },
    relayauthLogPath
  );
}

function spawnRelayfile(config: ServiceConfig, relayfileLogPath: string): ChildProcess {
  const binary = path.join(config.relayfileRoot, 'bin', 'relayfile');
  if (existsSync(binary) && isExecutable(binary)) {
    return spawnLogged(
      binary,
      [],
      config.relayfileRoot,
      {
        ...process.env,
        RELAYFILE_JWT_SECRET: config.secret,
        RELAYFILE_BACKEND_PROFILE: 'durable-local',
      },
      relayfileLogPath
    );
  }

  return spawnLogged(
    'go',
    ['run', './cmd/relayfile'],
    config.relayfileRoot,
    {
      ...process.env,
      RELAYFILE_JWT_SECRET: config.secret,
      RELAYFILE_BACKEND_PROFILE: 'durable-local',
    },
    relayfileLogPath
  );
}

export async function healthCheck(port: number, timeout: number): Promise<boolean> {
  const endAt = Date.now() + timeout * 1000;
  const healthUrl = `http://127.0.0.1:${port}/health`;

  while (Date.now() < endAt) {
    if (await checkHealth(healthUrl)) {
      return true;
    }
    await sleep(2000);
  }

  return false;
}

export async function startServices(config: Partial<ServiceConfig> = {}): Promise<{ authPid: number; filePid: number }> {
  const resolved = resolveServiceConfig(config);
  const existing = readPids();

  if (existing?.relayauthPid && isProcessAlive(existing.relayauthPid)) {
    throw new Error('relayauth already running');
  }
  if (existing?.relayfilePid && isProcessAlive(existing.relayfilePid)) {
    throw new Error('relayfile already running');
  }

  if (existing) {
    removePidsFile();
  }

  mkdirSync(resolved.logDir, { recursive: true });

  const relayauthLog = path.join(resolved.logDir, 'relayauth.log');
  const relayfileLog = path.join(resolved.logDir, 'relayfile.log');

  const relayauthProcess = spawnRelayauth(resolved, relayauthLog);
  const relayfileProcess = spawnRelayfile(resolved, relayfileLog);

  if (!relayauthProcess.pid) {
    throw new Error('failed to start relayauth');
  }
  if (!relayfileProcess.pid) {
    await stopPid(relayauthProcess.pid);
    throw new Error('failed to start relayfile');
  }

  writePids({
    relayauthPid: relayauthProcess.pid,
    relayfilePid: relayfileProcess.pid,
  });

  const [authHealthy, fileHealthy] = await Promise.all([
    healthCheck(resolved.portAuth, 30),
    healthCheck(resolved.portFile, 30),
  ]);

  if (!authHealthy || !fileHealthy) {
    await stopServices();
    throw new Error('services did not become healthy');
  }

  return {
    authPid: relayauthProcess.pid,
    filePid: relayfileProcess.pid,
  };
}

export async function stopServices(): Promise<void> {
  const resolved = resolveServiceConfig();
  const pids = readPids();

  if (pids?.relayauthPid) {
    await stopPid(pids.relayauthPid);
  }

  if (pids?.relayfilePid) {
    await stopPid(pids.relayfilePid);
  }

  await stopPortProcess(resolved.portAuth);
  await stopPortProcess(resolved.portFile);
  removePidsFile();
}
