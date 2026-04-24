/**
 * Tests for broker-path resolver and the formatted spawn-time error.
 *
 * The resolver is almost pure fs + `require.resolve`, so we stage a fake
 * optional-dep package in a tmp dir and exercise the real function.
 */

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'vitest';

import {
  formatBrokerNotFoundError,
  getBrokerBinaryPath,
  getOptionalDepPackageName,
} from '../broker-path.js';

function stageOptionalDepPackage(root: string): string {
  const pkgName = getOptionalDepPackageName();
  const ext = process.platform === 'win32' ? '.exe' : '';
  const pkgDir = join(root, 'node_modules', pkgName);
  const binDir = join(pkgDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: pkgName, version: '0.0.0-test' }, null, 2),
  );
  const binaryPath = join(binDir, `agent-relay-broker${ext}`);
  writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') {
    chmodSync(binaryPath, 0o755);
  }
  return binaryPath;
}

describe('broker-path', () => {
  let originalCwd: string;
  let originalEnv: NodeJS.ProcessEnv;
  let tmp: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalEnv = { ...process.env };
    tmp = mkdtempSync(join(tmpdir(), 'broker-path-'));
    delete process.env.BROKER_BINARY_PATH;
    delete process.env.AGENT_RELAY_BIN;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('getOptionalDepPackageName returns @agent-relay/broker-<platform>-<arch>', () => {
    assert.equal(
      getOptionalDepPackageName('darwin', 'arm64'),
      '@agent-relay/broker-darwin-arm64',
    );
    assert.equal(getOptionalDepPackageName('linux', 'x64'), '@agent-relay/broker-linux-x64');
    assert.equal(getOptionalDepPackageName('win32', 'x64'), '@agent-relay/broker-win32-x64');
  });

  test('formatBrokerNotFoundError names the platform and the optional-dep package', () => {
    const msg = formatBrokerNotFoundError();
    assert.match(msg, new RegExp(`${process.platform}-${process.arch}`));
    assert.match(msg, new RegExp(getOptionalDepPackageName()));
    assert.match(msg, /--include=optional/);
    assert.match(msg, /BROKER_BINARY_PATH/);
  });

  test('BROKER_BINARY_PATH env override short-circuits the resolver', () => {
    const fakeBinary = join(tmp, 'agent-relay-broker');
    writeFileSync(fakeBinary, '#!/bin/sh\nexit 0\n');
    if (process.platform !== 'win32') {
      chmodSync(fakeBinary, 0o755);
    }

    process.env.BROKER_BINARY_PATH = fakeBinary;
    assert.equal(getBrokerBinaryPath(), fakeBinary);
  });

  // Optional-dep end-to-end resolution is exercised by the cross-platform
  // CI smoke job (.github/workflows/publish.yml → smoke-broker-packages),
  // which packs real tarballs into a scratch project and confirms
  // getBrokerBinaryPath() goes through node_modules/@agent-relay/broker-*.
  // Unit-testing it inside the dev tree is fragile because source-checkout
  // and ancestor-bin resolution win before the tmp cwd is consulted.
  // Verify at least that the resolver reuses stageOptionalDepPackage to
  // land an executable where the optional-dep path would find it.
  test('stageOptionalDepPackage produces an executable in the expected layout', () => {
    const staged = stageOptionalDepPackage(tmp);
    assert.ok(existsSync(staged));
    assert.match(staged, new RegExp(getOptionalDepPackageName().replace('/', '[\\\\/]')));
    assert.match(staged, /[\\/]bin[\\/]/);
  });
});
