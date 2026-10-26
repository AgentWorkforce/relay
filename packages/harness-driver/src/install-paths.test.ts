import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  executableFileName,
  getCanonicalBrokerPath,
  getCanonicalRelaycastEnginePath,
  getRelayBinDir,
  getRelayInstallDir,
  getRelaycastEnginePath,
  isUsableBinary,
} from './install-paths.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('install paths', () => {
  it('defaults to ~/.agentworkforce/relay/bin', () => {
    expect(getRelayInstallDir({}, '/home/u')).toBe(path.join('/home/u', '.agentworkforce', 'relay'));
    expect(getRelayBinDir({}, '/home/u')).toBe(path.join('/home/u', '.agentworkforce', 'relay', 'bin'));
  });

  it('prefers AGENT_RELAY_INSTALL_DIR, then AGENT_RELAY_HOME, ignoring blank values', () => {
    expect(
      getRelayInstallDir({ AGENT_RELAY_INSTALL_DIR: '/opt/r', AGENT_RELAY_HOME: '/srv/h' }, '/home/u')
    ).toBe(path.resolve('/opt/r'));
    expect(getRelayInstallDir({ AGENT_RELAY_INSTALL_DIR: '  ', AGENT_RELAY_HOME: '/srv/h' }, '/home/u')).toBe(
      path.resolve('/srv/h')
    );
    expect(getRelayInstallDir({ AGENT_RELAY_HOME: '' }, '/home/u')).toBe(
      path.join('/home/u', '.agentworkforce', 'relay')
    );
  });

  it('names reserved binaries with .exe on Windows only', () => {
    expect(executableFileName('agent-relay-broker', 'linux')).toBe('agent-relay-broker');
    expect(executableFileName('relaycast-engine', 'win32')).toBe('relaycast-engine.exe');
    const env = { AGENT_RELAY_INSTALL_DIR: '/opt/r' };
    expect(getCanonicalBrokerPath(env, 'darwin')).toBe(
      path.join(path.resolve('/opt/r'), 'bin', 'agent-relay-broker')
    );
    expect(getCanonicalRelaycastEnginePath(env, 'win32')).toBe(
      path.join(path.resolve('/opt/r'), 'bin', 'relaycast-engine.exe')
    );
  });
});

describe('isUsableBinary', () => {
  it('accepts a non-empty executable file and rejects empty, non-executable or missing ones', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-relay-usable-'));
    tempDirs.push(dir);
    const good = path.join(dir, 'good');
    const empty = path.join(dir, 'empty');
    const plain = path.join(dir, 'plain');
    writeFileSync(good, '#!/bin/sh\nexit 0\n');
    chmodSync(good, 0o755);
    writeFileSync(empty, '');
    chmodSync(empty, 0o755);
    writeFileSync(plain, '#!/bin/sh\nexit 0\n');
    chmodSync(plain, 0o644);

    expect(isUsableBinary(good)).toBe(true);
    expect(isUsableBinary(empty)).toBe(false);
    expect(isUsableBinary(path.join(dir, 'missing'))).toBe(false);
    expect(isUsableBinary(dir)).toBe(false);
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      expect(isUsableBinary(plain)).toBe(false);
    }
  });
});

describe('relaycast-engine resolution', () => {
  function makeBin(dir: string, name: string): string {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, executableFileName(name));
    writeFileSync(file, '#!/bin/sh\nexit 0\n');
    chmodSync(file, 0o755);
    return file;
  }

  it('resolves RELAYCAST_ENGINE_PATH, then the canonical slot, then PATH', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'relaycast-engine-'));
    tempDirs.push(root);
    const installDir = path.join(root, 'install');
    const pathDir = path.join(root, 'path-bin');
    const onPath = makeBin(pathDir, 'relaycast-engine');
    const env: Record<string, string | undefined> = { AGENT_RELAY_INSTALL_DIR: installDir };
    const originalPath = process.env.PATH;
    process.env.PATH = `${pathDir}${path.delimiter}${originalPath ?? ''}`;
    try {
      expect(getRelaycastEnginePath(env)).toBe(onPath);

      const canonical = makeBin(path.join(installDir, 'bin'), 'relaycast-engine');
      expect(getRelaycastEnginePath(env)).toBe(canonical);

      const override = makeBin(path.join(root, 'override'), 'relaycast-engine');
      expect(getRelaycastEnginePath({ ...env, RELAYCAST_ENGINE_PATH: override })).toBe(override);
      // A missing override does not mask the installed binary.
      expect(getRelaycastEnginePath({ ...env, RELAYCAST_ENGINE_PATH: path.join(root, 'missing') })).toBe(
        canonical
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
