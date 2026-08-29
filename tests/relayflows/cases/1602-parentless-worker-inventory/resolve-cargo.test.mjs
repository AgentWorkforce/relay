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

test('resolveCargo prefers the path printed by `mise which cargo`', async () => {
  const root = await makeTmpRoot('resolve-cargo-mise-');
  try {
    const shimsDir = path.join(root, '.local', 'share', 'mise', 'shims');
    await makeExecutable(path.join(shimsDir, 'mise'));
    await makeExecutable(path.join(shimsDir, 'cargo'), '#!/bin/sh\necho mise-shim\n');

    const realCargo = path.join(root, '.local', 'share', 'mise', 'installs', 'rust', '1.75.0', 'bin', 'cargo');
    await makeExecutable(realCargo);

    const runOnce = async (command, args) => {
      if (path.basename(command) === 'mise' && args.join(' ') === 'which cargo') {
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

test('resolveCargo prefers the path printed by `asdf which cargo`', async () => {
  const root = await makeTmpRoot('resolve-cargo-asdf-');
  try {
    const shimsDir = path.join(root, '.asdf', 'shims');
    await makeExecutable(path.join(shimsDir, 'asdf'));
    await makeExecutable(path.join(shimsDir, 'cargo'), '#!/bin/sh\necho asdf-shim\n');

    const realCargo = path.join(root, '.asdf', 'installs', 'rust', '1.75.0', 'bin', 'cargo');
    await makeExecutable(realCargo);

    const runOnce = async (command, args) => {
      if (path.basename(command) === 'asdf' && args.join(' ') === 'which cargo') {
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

test('resolveCargo step 3 infers home from CARGO_HOME when PATH lacks shims', async () => {
  const root = await makeTmpRoot('resolve-cargo-cargohome-');
  try {
    const toolchainCargo = path.join(
      root,
      '.rustup',
      'toolchains',
      'stable-x86_64-unknown-linux-gnu',
      'bin',
      'cargo'
    );
    await makeExecutable(toolchainCargo);

    // Empty PATH (nothing to probe), no HOME, but CARGO_HOME points at
    // `<root>/.cargo`. `dirname(CARGO_HOME)` becomes `root`, so the toolchain
    // walk under `<root>/.rustup/toolchains` finds the cargo.
    const runOnce = async () => {
      throw new Error('should not be called; no tools on PATH');
    };

    const resolved = await resolveCargo({
      env: { PATH: '', CARGO_HOME: path.join(root, '.cargo') },
      pathEntries: [],
      runOnce,
      extraSystemPaths: [],
    });
    assert.equal(resolved, toolchainCargo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveCargo step 3 infers home from RUSTUP_HOME when PATH lacks shims', async () => {
  const root = await makeTmpRoot('resolve-cargo-rustuphome-');
  try {
    const toolchainCargo = path.join(
      root,
      '.rustup',
      'toolchains',
      'nightly-x86_64-unknown-linux-gnu',
      'bin',
      'cargo'
    );
    await makeExecutable(toolchainCargo);

    const runOnce = async () => {
      throw new Error('should not be called; no tools on PATH');
    };

    // RUSTUP_HOME is `<root>/.rustup`; dirname gives `root`, so the toolchain
    // walk under `<root>/.rustup/toolchains` succeeds.
    const resolved = await resolveCargo({
      env: { PATH: '', RUSTUP_HOME: path.join(root, '.rustup') },
      pathEntries: [],
      runOnce,
      extraSystemPaths: [],
    });
    assert.equal(resolved, toolchainCargo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveCargo step 3 infers home from an asdf shims PATH entry', async () => {
  const root = await makeTmpRoot('resolve-cargo-asdfhome-');
  try {
    // asdf shims dir sits on PATH but has no cargo shim in it, and no asdf
    // binary — so steps 1 and 2 both fall through. Step 3 must strip the
    // `/.asdf/shims` suffix to infer `<root>` as a home and walk toolchains.
    const shimsDir = path.join(root, '.asdf', 'shims');
    await mkdir(shimsDir, { recursive: true });

    const toolchainCargo = path.join(
      root,
      '.rustup',
      'toolchains',
      'stable-x86_64-unknown-linux-gnu',
      'bin',
      'cargo'
    );
    await makeExecutable(toolchainCargo);

    const runOnce = async () => ({ code: 1, signal: null, stdout: '', stderr: '' });

    const resolved = await resolveCargo({
      env: { PATH: shimsDir },
      pathEntries: [shimsDir],
      runOnce,
      extraSystemPaths: [],
    });
    assert.equal(resolved, toolchainCargo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveCargo times out a hung version-manager probe and falls through to the next resolver', async () => {
  const root = await makeTmpRoot('resolve-cargo-hung-');
  try {
    // Shims dir carries mise (which will hang) and asdf (which will succeed).
    // rustup is absent, so it fails fast; mise hangs, timeout kicks in; asdf
    // then answers with the real cargo. If the timeout doesn't fire, the
    // test itself would time out on `node --test`.
    const shimsDir = path.join(root, 'shims');
    await makeExecutable(path.join(shimsDir, 'mise'));
    await makeExecutable(path.join(shimsDir, 'asdf'));

    const realCargo = path.join(root, 'installs', 'rust', 'bin', 'cargo');
    await makeExecutable(realCargo);

    const logged = [];
    const runOnce = async (command, args) => {
      if (path.basename(command) === 'mise') {
        // Never resolves — simulates a hung shim (lock, network wait).
        return new Promise(() => {});
      }
      if (path.basename(command) === 'asdf' && args.join(' ') === 'which cargo') {
        return { code: 0, signal: null, stdout: `${realCargo}\n`, stderr: '' };
      }
      return { code: 1, signal: null, stdout: '', stderr: '' };
    };

    const resolved = await resolveCargo({
      env: { PATH: shimsDir, HOME: root },
      pathEntries: [shimsDir],
      runOnce,
      probeTimeoutMs: 75,
      log: (message) => logged.push(message),
      extraSystemPaths: [],
    });
    assert.equal(resolved, realCargo);
    assert.ok(
      logged.some((line) => line.includes('mise which cargo') && line.includes('timed out')),
      `expected a diagnosable timeout log line; got: ${JSON.stringify(logged)}`
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
