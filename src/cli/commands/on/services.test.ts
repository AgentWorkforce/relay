import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: spawnMock,
    spawnSync: spawnSyncMock,
  };
});

import { healthCheck, resolveServiceConfig, startServices, stopServices } from './services.js';


const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.chdir('/var/tmp');
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveServiceConfig', () => {
  it('prefers an existing parent relayauth path over a missing cwd candidate', () => {
    const root = makeTempDir('relay-services-');
    const workspace = path.join(root, 'workspace', 'project');
    const relayauth = path.join(root, 'workspace', 'relayauth');
    const relayfile = path.join(root, 'workspace', 'relayfile');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(relayauth, { recursive: true });
    mkdirSync(relayfile, { recursive: true });
    process.chdir(workspace);

    const resolved = resolveServiceConfig();

    expect(resolved.relayauthRoot).toBe(realpathSync(relayauth));
    expect(resolved.relayfileRoot).toBe(realpathSync(relayfile));
    expect(resolved.logDir.endsWith(path.join('.relay', 'logs'))).toBe(true);
  });

  it('reads config values from .relay/config.json', () => {
    const root = makeTempDir('relay-services-');
    const relayauth = path.join(root, 'relayauth');
    const relayfile = path.join(root, 'relayfile');
    const logDir = path.join(root, 'logs');
    mkdirSync(path.join(root, '.relay'), { recursive: true });
    mkdirSync(relayauth, { recursive: true });
    mkdirSync(relayfile, { recursive: true });
    writeFileSync(
      path.join(root, '.relay', 'config.json'),
      JSON.stringify({
        data: {
          RELAYAUTH_ROOT: relayauth,
          RELAYFILE_ROOT: relayfile,
          RELAY_LOG_DIR: logDir,
          RELAY_AUTH_PORT: 9991,
          RELAY_FILE_PORT: '9992',
          signing_secret: 'cached-secret',
        },
      })
    );
    process.chdir(root);

    const resolved = resolveServiceConfig();

    expect(resolved).toMatchObject({
      relayauthRoot: relayauth,
      relayfileRoot: relayfile,
      logDir,
      portAuth: 9991,
      portFile: 9992,
      secret: 'cached-secret',
    });
  });
});

describe('healthCheck', () => {
  it('returns true when the health endpoint succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    const result = await healthCheck(8787, 1);
    expect(result).toBe(true);
  });
});

describe('startServices/stopServices', () => {
  it('starts both services, writes pids, and stops them cleanly', async () => {
    const root = makeTempDir('relay-services-');
    const relayauth = path.join(root, 'relayauth');
    const relayfile = path.join(root, 'relayfile');
    const logDir = path.join(root, '.relay', 'logs');
    mkdirSync(relayauth, { recursive: true });
    mkdirSync(path.join(relayfile, 'bin'), { recursive: true });
    writeFileSync(path.join(relayfile, 'bin', 'relayfile'), '#!/bin/sh\n');
    process.chdir(root);

    const pidFilePath = path.join(os.homedir(), '.relay', 'pids.json');
    rmSync(pidFilePath, { force: true });
    const livePids = new Set([1111, 2222]);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        if (!livePids.has(pid)) {
          throw new Error('not running');
        }
        return true;
      }
      livePids.delete(pid);
      return true;
    }) as typeof process.kill);

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    spawnMock
      .mockReturnValueOnce({ pid: 1111 })
      .mockReturnValueOnce({ pid: 2222 });
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '' });

    const started = await startServices({ relayauthRoot: relayauth, relayfileRoot: relayfile, logDir, secret: 'secret' });

    expect(started).toEqual({ authPid: 1111, filePid: 2222 });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const pidFile = JSON.parse(readFileSync(pidFilePath, 'utf8'));
    expect(pidFile).toEqual({ relayauthPid: 1111, relayfilePid: 2222 });

    await stopServices();

    expect(killSpy).toHaveBeenCalledWith(1111, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(2222, 'SIGTERM');
  });
});
