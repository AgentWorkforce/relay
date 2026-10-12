import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, cp, open, readFile, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestJson } from '../http.js';
import { VERSION } from './cloud.js';
import { privateDirectory, relayPaths } from './paths.js';

// Starts the Node relay daemon for `connect join`, or finds the running one.
// The daemon runs from a copy of this package under ~/.agentworkforce so an
// npx cache cleanup cannot remove its code, under the Node already running
// this CLI: nothing is downloaded and no new binary is launched.

const HANDSHAKE_TIMEOUT_MS = 10_000;

export class RelayStartError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'RelayStartError';
    this.exitCode = exitCode;
    this.code = 'relay_start_failed';
  }
}

function versionParts(value) {
  return String(value || '')
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function olderVersion(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  return false;
}

/** The running daemon's health, or null. */
export async function relayHealth(socket, timeoutMs = 2_000) {
  try {
    const info = await stat(socket);
    if (!info.isSocket()) return null;
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) return null;
    const response = await requestJson(socket, { path: '/health', timeoutMs });
    return response?.ok === true ? response.data : null;
  } catch {
    return null;
  }
}

/** Copies this package's code to runtime/<version>/ once; returns the daemon entry path. */
export async function stageRuntime(paths, version = VERSION) {
  const codeDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const packageRoot = dirname(codeDir);
  const destination = join(paths.runtime, version);
  const entry = join(destination, basename(codeDir), 'relay/daemon.js');
  try {
    await access(entry, constants.R_OK);
    return entry;
  } catch {
    // Not staged yet.
  }
  await privateDirectory(paths.runtime);
  const staging = `${destination}.${process.pid}.tmp`;
  await rm(staging, { recursive: true, force: true });
  await cp(codeDir, join(staging, basename(codeDir)), { recursive: true });
  await cp(join(packageRoot, 'package.json'), join(staging, 'package.json'));
  try {
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    // Another CLI staged the same version first.
    if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
  }
  return entry;
}

async function logTail(path, lines = 12) {
  try {
    const text = await readFile(path, 'utf8');
    return text.trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function handshake(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ type: 'timeout' }), timeoutMs);
    child.once('message', (message) => finish(message && typeof message === 'object' ? message : { type: 'invalid' }));
    child.once('error', (error) => finish({ type: 'error', message: error.message }));
    child.once('exit', (code, signal) => finish({ type: 'exit', code, signal }));
  });
}

/**
 * Resolves the daemon socket, starting the daemon when none answers. Failures
 * reject with the daemon's own reason and the end of its log.
 */
export async function ensureRelay({ home = os.homedir(), env = process.env, timeoutMs = HANDSHAKE_TIMEOUT_MS, spawnProcess = spawn } = {}) {
  const paths = relayPaths(home);
  const running = await relayHealth(paths.socket);
  if (running) {
    // An older idle relay steps aside for this version; a busy one keeps serving.
    if (!olderVersion(running.version, VERSION) || running.sessions > 0) return paths.socket;
    await requestJson(paths.socket, { method: 'POST', path: '/shutdown', timeoutMs: 2_000 }).catch(() => null);
    for (let attempt = 0; attempt < 20 && (await relayHealth(paths.socket, 500)); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  await privateDirectory(paths.root);
  const entry = await stageRuntime(paths);
  const log = await open(paths.log, 'a', 0o600);
  let child;
  let handshakeResult;
  try {
    child = spawnProcess(process.execPath, [entry], {
      detached: true,
      stdio: ['ignore', log.fd, log.fd, 'ipc'],
      env: { ...env, HOME: home },
    });
    // Listen before anything else awaits: a daemon that fails at once must not be missed.
    handshakeResult = handshake(child, timeoutMs);
  } finally {
    await log.close();
  }
  const result = await handshakeResult;
  if (child.connected) child.disconnect();
  child.unref();

  if (result.type === 'ready') return result.socket || paths.socket;
  // Two CLIs can race to start it; the loser finds the winner here.
  if (result.type === 'error' && result.code === 'already_running') {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await relayHealth(paths.socket, 500)) return paths.socket;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (result.type === 'timeout' && child.pid) {
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      // It already exited.
    }
  }
  const reason =
    result.type === 'error'
      ? result.message
      : result.type === 'exit'
        ? `it exited${result.signal ? ` on ${result.signal}` : ` with code ${result.code}`} before it was ready`
        : result.type === 'timeout'
          ? `it did not report ready within ${Math.round(timeoutMs / 1000)} s`
          : `it could not be started (${result.message || 'unknown error'})`;
  const tail = await logTail(paths.log);
  throw new RelayStartError(
    `The Agent Relay Connect relay could not start: ${reason}.${tail ? `\nLast lines of ${paths.log}:\n${tail}` : ''}`
  );
}
