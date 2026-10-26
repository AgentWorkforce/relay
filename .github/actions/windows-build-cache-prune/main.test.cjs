'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pruneWorkspaceArtifacts } = require('./main.cjs');

const LIB = '1111111111111111';
const APP = '2222222222222222';
const HOSTING = '3333333333333333';
const BUILD = '4444444444444444';
const DEPENDENCY = 'aaaaaaaaaaaaaaaa';

function fixture(t, profile = 'debug') {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cache-prune-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  function write(relative, contents = 'artifact') {
    const filename = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
    return filename;
  }
  write('probe/Cargo.toml', '[package]\nname = "agent-relay-probe"\nversion = "0.0.0"\n');
  const prefix = `probe/target/${profile}`;
  return { workspace, prefix, write, exists: (relative) => fs.existsSync(path.join(workspace, relative)) };
}

test('removes workspace libraries, binaries and tests while preserving dependency products', (t) => {
  const f = fixture(t);
  for (const hash of [LIB, APP, HOSTING, BUILD]) {
    f.write(`${f.prefix}/.fingerprint/agent-relay-probe-${hash}/marker`);
  }
  f.write(`${f.prefix}/build/agent-relay-probe-${BUILD}/build-script-build.exe`);
  const removed = [
    `libagent_relay_probe-${LIB}.rlib`,
    `libagent_relay_probe-${LIB}.rmeta`,
    `agent_relay_probe-${LIB}.d`,
    `agent_relay-${APP}.exe`,
    `agent_relay-${APP}.pdb`,
    `linux_app_hosting-${HOSTING}.exe`,
    `linux_app_hosting-${HOSTING}.d`,
  ];
  for (const name of removed) f.write(`${f.prefix}/deps/${name}`);
  const retained = [
    `.fingerprint/gtk4-${DEPENDENCY}/marker`,
    `build/gtk4-sys-${DEPENDENCY}/build-script-build.exe`,
    `deps/libgtk4-${DEPENDENCY}.rlib`,
    `deps/glib_macros-${DEPENDENCY}.dll`,
    `deps/build_script_build-${DEPENDENCY}.exe`,
    // Similar package names and non-Cargo-looking names are not ours.
    `.fingerprint/agent-relay-probe-helper-${DEPENDENCY}/marker`,
    `deps/unrelated-${DEPENDENCY}.exe`,
    `deps/readme-${LIB}-extra.txt`,
  ];
  for (const name of retained) f.write(`${f.prefix}/${name}`);
  f.write('probe/src/keep.rs', 'source');
  f.write(`probe/target/release/deps/agent_relay-${APP}.exe`);
  const result = pruneWorkspaceArtifacts({ workspace: f.workspace, profile: 'debug' });
  assert.deepEqual(result, { fingerprints: 4, buildDirectories: 1, dependencyFiles: 7, bytes: 96 });
  for (const name of removed) assert.equal(f.exists(`${f.prefix}/deps/${name}`), false);
  for (const name of retained) assert.equal(f.exists(`${f.prefix}/${name}`), true);
  assert.equal(f.exists('probe/src/keep.rs'), true);
  assert.equal(f.exists(`probe/target/release/deps/agent_relay-${APP}.exe`), true);
});

test('release profile accepts orphaned workspace build outputs without deleting unidentified dependencies', (t) => {
  const f = fixture(t, 'release');
  f.write(`${f.prefix}/build/agent-relay-probe-${BUILD}/out/resource.o`);
  f.write(`${f.prefix}/deps/agent_relay_probe-${LIB}.exe`);
  const result = pruneWorkspaceArtifacts({ workspace: f.workspace, profile: 'release' });
  assert.equal(result.buildDirectories, 1);
  assert.equal(result.dependencyFiles, 0);
  assert.equal(f.exists(`${f.prefix}/deps/agent_relay_probe-${LIB}.exe`), true);
});

test('missing build or artifact directories are valid', (t) => {
  const f = fixture(t);
  assert.deepEqual(pruneWorkspaceArtifacts({ workspace: f.workspace, profile: 'debug' }), {
    fingerprints: 0,
    buildDirectories: 0,
    dependencyFiles: 0,
    bytes: 0,
  });
  fs.mkdirSync(path.join(f.workspace, f.prefix), { recursive: true });
  assert.equal(pruneWorkspaceArtifacts({ workspace: f.workspace, profile: 'debug' }).bytes, 0);
});

test('invalid profiles and unsafe manifest names are refused', (t) => {
  const f = fixture(t);
  for (const profile of ['', '../src', 'debug/../../src', 'Debug', undefined]) {
    assert.throws(() => pruneWorkspaceArtifacts({ workspace: f.workspace, profile }), /profile/);
  }
  f.write('probe/Cargo.toml', '[package]\nname = "../outside"\n');
  assert.throws(() => pruneWorkspaceArtifacts({ workspace: f.workspace, profile: 'debug' }), /safe name/);
});

for (const parent of ['probe', 'probe/target', 'probe/target/debug', 'probe/target/debug/deps']) {
  test(`refuses symlink build parent ${parent}`, (t) => {
    const f = fixture(t);
    const outside = path.join(f.workspace, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep'), 'outside');
    const filename = path.join(f.workspace, parent);
    fs.rmSync(filename, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.symlinkSync(outside, filename, 'junction');
    assert.throws(
      () => pruneWorkspaceArtifacts({ workspace: f.workspace, profile: 'debug' }),
      /unsafe|checked-out/
    );
    assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'outside');
  });
}

test('refuses symlink products before removing any planned workspace files', (t) => {
  const f = fixture(t);
  const marker = f.write(`${f.prefix}/.fingerprint/agent-relay-probe-${LIB}/marker`);
  const outside = f.write('outside', 'keep');
  const product = path.join(f.workspace, f.prefix, 'deps', `agent_relay_probe-${LIB}.exe`);
  fs.mkdirSync(path.dirname(product));
  fs.symlinkSync(outside, product, 'file');
  assert.throws(() => pruneWorkspaceArtifacts({ workspace: f.workspace, profile: 'debug' }), /unsafe/);
  assert.equal(fs.existsSync(marker), true);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
});
