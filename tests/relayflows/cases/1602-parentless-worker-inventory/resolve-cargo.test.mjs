// Unit tests for the fail-fast Cargo resolver used by the 1602 PR-proof
// case runner.
//
// Every test drops a real (fake) executable script into a temp directory and
// exercises the resolver against it. The resolver's timeout is enforced by
// Node's execFileSync `timeout` + `killSignal: 'SIGKILL'`, so a probe that
// blocks forever is guaranteed to die within the budget.
//
// Run with:
//   node --test tests/relayflows/cases/1602-parentless-worker-inventory/resolve-cargo.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CargoNotResolvableError, resolveCargo } from './run.mjs';

async function makeExecutable(filePath, body) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, body);
  await chmod(filePath, 0o755);
}

async function makeFakeCargo(filePath, { version = '1.75.0' } = {}) {
  await makeExecutable(
    filePath,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "cargo ${version} (fake)"\nfi\n`
  );
}

async function makeHangingCargo(filePath) {
  // Ignore SIGTERM so a hung probe survives a soft signal; only SIGKILL takes
  // it out. Sleep in a small loop so `trap` can service the signal ignore.
  await makeExecutable(
    filePath,
    '#!/bin/sh\ntrap "" TERM\nwhile true; do sleep 60; done\n'
  );
}

async function makeWrongOutputCargo(filePath) {
  await makeExecutable(filePath, '#!/bin/sh\necho "not cargo at all"\n');
}

async function makeTmpRoot(prefix) {
  const raw = await mkdtemp(path.join(os.tmpdir(), prefix));
  // macOS resolves /var to /private/var — normalize so string comparisons
  // against paths inside the returned root line up.
  return realpath(raw);
}

test('resolveCargo returns a direct hit on PATH when `cargo --version` looks right', async () => {
  const root = await makeTmpRoot('resolve-cargo-path-');
  try {
    const binDir = path.join(root, 'bin');
    const cargo = path.join(binDir, 'cargo');
    await makeFakeCargo(cargo);

    const resolved = resolveCargo({
      env: { PATH: binDir },
      pathEntries: [binDir],
      extraSystemPaths: [],
    });
    assert.equal(resolved, cargo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveCargo prefers CARGO_HOME/bin/cargo when it works', async () => {
  const root = await makeTmpRoot('resolve-cargo-cargohome-');
  try {
    const cargoHome = path.join(root, '.cargo');
    const cargo = path.join(cargoHome, 'bin', 'cargo');
    await makeFakeCargo(cargo);

    const resolved = resolveCargo({
      env: { PATH: '', CARGO_HOME: cargoHome },
      pathEntries: [],
      extraSystemPaths: [],
    });
    assert.equal(resolved, cargo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveCargo enumerates HOME/.rustup/toolchains/*/bin/cargo', async () => {
  const root = await makeTmpRoot('resolve-cargo-rustup-');
  try {
    const toolchainCargo = path.join(
      root,
      '.rustup',
      'toolchains',
      'stable-x86_64-unknown-linux-gnu',
      'bin',
      'cargo'
    );
    await makeFakeCargo(toolchainCargo);

    const resolved = resolveCargo({
      env: { PATH: '', HOME: root },
      pathEntries: [],
      extraSystemPaths: [],
    });
    assert.equal(resolved, toolchainCargo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveCargo falls back to extraSystemPaths when nothing else works', async () => {
  const root = await makeTmpRoot('resolve-cargo-system-');
  try {
    const systemCargo = path.join(root, 'opt', 'cargo', 'bin', 'cargo');
    await makeFakeCargo(systemCargo);

    const resolved = resolveCargo({
      env: { PATH: '' },
      pathEntries: [],
      extraSystemPaths: [systemCargo],
    });
    assert.equal(resolved, systemCargo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveCargo skips a candidate that prints unexpected --version output and picks the next one', async () => {
  const root = await makeTmpRoot('resolve-cargo-badoutput-');
  try {
    // First candidate on PATH is a shim that prints garbage.
    const badDir = path.join(root, 'bad', 'bin');
    const badCargo = path.join(badDir, 'cargo');
    await makeWrongOutputCargo(badCargo);

    // Second candidate on PATH is the real thing.
    const goodDir = path.join(root, 'good', 'bin');
    const goodCargo = path.join(goodDir, 'cargo');
    await makeFakeCargo(goodCargo);

    const resolved = resolveCargo({
      env: { PATH: `${badDir}${path.delimiter}${goodDir}` },
      pathEntries: [badDir, goodDir],
      extraSystemPaths: [],
    });
    assert.equal(resolved, goodCargo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'resolveCargo throws CargoNotResolvableError when every candidate hangs past the timeout',
  { timeout: 15_000 },
  async () => {
    const root = await makeTmpRoot('resolve-cargo-hung-');
    try {
      const hungA = path.join(root, 'a', 'cargo');
      const hungB = path.join(root, 'b', 'cargo');
      await makeHangingCargo(hungA);
      await makeHangingCargo(hungB);

      const timeoutMs = 400;
      const started = Date.now();
      let threw;
      try {
        resolveCargo({
          env: { PATH: `${path.dirname(hungA)}${path.delimiter}${path.dirname(hungB)}` },
          pathEntries: [path.dirname(hungA), path.dirname(hungB)],
          timeoutMs,
          extraSystemPaths: [],
        });
      } catch (error) {
        threw = error;
      }
      const elapsed = Date.now() - started;

      assert.ok(threw instanceof CargoNotResolvableError, `expected CargoNotResolvableError, got ${threw}`);
      assert.equal(threw.attempts.length, 2, 'both hung candidates must be recorded');
      for (const attempt of threw.attempts) {
        assert.match(attempt.reason, /killed by SIGKILL after 400ms/);
      }
      assert.match(threw.message, /could not resolve a working cargo executable/);
      // Two 400ms probes + SIGKILL should be under 5s even on a busy runner.
      assert.ok(elapsed < 5000, `probes must respect timeout budget, elapsed=${elapsed}ms`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

test('resolveCargo dedupes identical candidates across enumeration sources', async () => {
  const root = await makeTmpRoot('resolve-cargo-dedupe-');
  try {
    const cargoHome = path.join(root, '.cargo');
    const cargo = path.join(cargoHome, 'bin', 'cargo');
    await makeFakeCargo(cargo);

    // CARGO_HOME/bin/cargo, HOME/.cargo/bin/cargo, and the PATH-based candidate
    // all resolve to the same string. Dedup must not double-execute it.
    const resolved = resolveCargo({
      env: {
        PATH: path.join(cargoHome, 'bin'),
        CARGO_HOME: cargoHome,
        HOME: root,
      },
      pathEntries: [path.join(cargoHome, 'bin')],
      extraSystemPaths: [cargo],
    });
    assert.equal(resolved, cargo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
