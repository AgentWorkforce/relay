// Unit tests for the Cargo resolver used by the 1602 PR-proof case runner.
//
// Run with:
//   node --test tests/relayflows/cases/1602-parentless-worker-inventory/resolve-cargo.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isShimPath, resolveCargo } from './run.mjs';

async function makeExecutable(filePath, body = '#!/bin/sh\nexit 0\n') {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, body);
  await chmod(filePath, 0o755);
}

async function makeTmpRoot(prefix) {
  const raw = await mkdtemp(path.join(os.tmpdir(), prefix));
  // macOS resolves /var to /private/var — normalize once so string comparisons
  // against paths inside `root` line up with the resolver's realpath output.
  return realpath(raw);
}

test('isShimPath recognizes rustup, mise, asdf, and volta shim directories', () => {
  assert.equal(isShimPath('/home/x/.local/share/mise/shims/cargo'), true);
  assert.equal(isShimPath('/home/x/.asdf/shims/cargo'), true);
  assert.equal(isShimPath('/root/.rustup/shims/cargo'), true);
  assert.equal(isShimPath('/home/x/.volta/bin/cargo'), true);

  // Real toolchain binaries — mise's installs/ and asdf's installs/ contain
  // the real cargo, not a shim. Do not reject them.
  assert.equal(isShimPath('/home/x/.local/share/mise/installs/rust/1.75.0/bin/cargo'), false);
  assert.equal(isShimPath('/home/x/.asdf/installs/rust/1.75.0/bin/cargo'), false);
  assert.equal(isShimPath('/root/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin/cargo'), false);
  assert.equal(isShimPath('/usr/local/cargo/bin/cargo'), false);
});

test('resolveCargo skips a rustup symlink-proxy and walks toolchain dirs', async () => {
  const root = await makeTmpRoot('resolve-cargo-proxy-');
  try {
    // rustup on PATH: real `rustup` binary, plus a `cargo` symlink pointing at
    // rustup. Basename check rejects it (realpath's basename is `rustup`).
    const cargoBin = path.join(root, 'cargo-bin');
    await makeExecutable(path.join(cargoBin, 'rustup'));
    await symlink(path.join(cargoBin, 'rustup'), path.join(cargoBin, 'cargo'));

    const toolchainCargo = path.join(
      root,
      '.rustup',
      'toolchains',
      'stable-x86_64-unknown-linux-gnu',
      'bin',
      'cargo'
    );
    await makeExecutable(toolchainCargo);

    // Force the toolchain walk by making `rustup which cargo` fail.
    const runOnce = async () => ({ code: 1, signal: null, stdout: '', stderr: 'no toolchain' });

    const resolved = await resolveCargo({
      env: { PATH: cargoBin, HOME: root },
      pathEntries: [cargoBin],
      runOnce,
      extraSystemPaths: [],
    });
    assert.equal(resolved, toolchainCargo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveCargo prefers the path printed by `rustup which cargo`', async () => {
  const root = await makeTmpRoot('resolve-cargo-rustup-');
  try {
    // Put shims in a proper `shims/` dir so loop 1 rejects them.
    const shimsDir = path.join(root, 'shims');
    await makeExecutable(path.join(shimsDir, 'rustup'));
    await makeExecutable(path.join(shimsDir, 'cargo'), '#!/bin/sh\necho shim\n');

    const realCargo = path.join(root, 'toolchains', 'stable', 'bin', 'cargo');
    await makeExecutable(realCargo);

    const runOnce = async (command, args) => {
      if (path.basename(command) === 'rustup' && args.join(' ') === 'which cargo') {
        return { code: 0, signal: null, stdout: `${realCargo}\n`, stderr: '' };
      }
      return { code: 1, signal: null, stdout: '', stderr: '' };
    };

    const resolved = await resolveCargo({
      env: { PATH: shimsDir, HOME: root },
      pathEntries: [shimsDir],
      runOnce,
      extraSystemPaths: [],
    });
    assert.equal(resolved, realCargo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveCargo throws a diagnostic listing when nothing resolves', async () => {
  const root = await makeTmpRoot('resolve-cargo-empty-');
  try {
    const shimsDir = path.join(root, '.local', 'share', 'mise', 'shims');
    await makeExecutable(path.join(shimsDir, 'cargo'), '#!/bin/sh\necho mise-shim\n');

    const runOnce = async () => ({ code: 1, signal: null, stdout: '', stderr: '' });

    await assert.rejects(
      resolveCargo({
        env: { PATH: shimsDir, HOME: root },
        pathEntries: [shimsDir],
        runOnce,
        extraSystemPaths: [],
      }),
      (error) => {
        assert.match(error.message, /could not resolve a real Cargo executable/);
        assert.match(error.message, /attempts:/);
        assert.match(error.message, /rejected: shim path/);
        return true;
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveCargo returns a direct non-shim cargo on PATH when present', async () => {
  const root = await makeTmpRoot('resolve-cargo-direct-');
  try {
    const binDir = path.join(root, 'bin');
    const cargo = path.join(binDir, 'cargo');
    await makeExecutable(cargo);

    const runOnce = async () => {
      throw new Error('should not be called when PATH already has a real cargo');
    };

    const resolved = await resolveCargo({
      env: { PATH: binDir, HOME: root },
      pathEntries: [binDir],
      runOnce,
      extraSystemPaths: [],
    });
    assert.equal(resolved, cargo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
