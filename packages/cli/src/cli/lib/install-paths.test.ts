import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  executableFileName,
  getCanonicalProbePath,
  getCanonicalRelaycastEnginePath,
  getRelayBinDir,
  getRelayInstallDir,
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
    expect(executableFileName('agent-relay-probe', 'linux')).toBe('agent-relay-probe');
    expect(executableFileName('relaycast-engine', 'win32')).toBe('relaycast-engine.exe');
    const env = { AGENT_RELAY_INSTALL_DIR: '/opt/r' };
    expect(getCanonicalProbePath(env, 'darwin')).toBe(
      path.join(path.resolve('/opt/r'), 'bin', 'agent-relay-probe')
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
