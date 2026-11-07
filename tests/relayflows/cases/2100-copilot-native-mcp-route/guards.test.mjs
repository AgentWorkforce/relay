import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertProofInputs, CASE_PATH, childEnv, externalPath, run } from './guards.mjs';

const caseDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(caseDir, '../../../..');
const posix = process.platform !== 'win32';
function git(cwd, ...args) {
  const result = spawnSync(
    'git',
    [
      '-C',
      cwd,
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'init.templateDir=',
      '-c',
      `core.hooksPath=${path.join(cwd, '.git/proof-no-hooks')}`,
      ...args,
    ],
    { encoding: 'utf8', env: childEnv(), timeout: 10_000 }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function put(root, name, value) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), value);
}
async function fixture() {
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'relay-2100-guards-')));
  const target = path.join(scratch, 'target'),
    harness = path.join(scratch, 'harness');
  for (const root of [target, harness]) {
    await mkdir(root);
    git(root, 'init', '--quiet');
    git(root, 'config', 'user.email', 'proof-fixture@example.invalid');
    git(root, 'config', 'user.name', 'Proof fixture');
  }
  await put(target, 'crates/relay-node/src/lib.rs', '// consumed production source fixture\n');
  await put(target, 'crates/relay-node/Cargo.lock', '# consumed lock fixture\n');
  await put(target, '.gitignore', '*.ignored.rs\n');
  for (const name of ['run.mjs', 'guards.mjs', 'fixture.rs']) {
    await mkdir(path.join(harness, CASE_PATH), { recursive: true });
    await copyFile(path.join(caseDir, name), path.join(harness, CASE_PATH, name));
  }
  await put(
    harness,
    'scripts/pr-proof/process-runner.mjs',
    await readFile(path.join(rootDir, 'scripts/pr-proof/process-runner.mjs'))
  );
  for (const root of [target, harness]) {
    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'Committed guard fixture');
  }
  const inputs = {
    target,
    harness,
    targetSha: git(target, 'rev-parse', 'HEAD'),
    headSha: git(harness, 'rev-parse', 'HEAD'),
  };
  return { scratch, target, harness, inputs, dispose: () => rm(scratch, { recursive: true, force: true }) };
}
async function exists(name) {
  return readFile(name).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  );
}

for (const location of ['target', 'harness']) {
  test(`rejects lexical ${location} build output without creating it`, async () => {
    const f = await fixture();
    try {
      const destination = path.join(f[location], 'uncreated-build');
      await assert.rejects(externalPath(destination, [f.target, f.harness]), /outside/);
      assert.equal(await exists(destination), false);
    } finally {
      await f.dispose();
    }
  });
  test(
    `rejects symlink and dangling-symlink output into ${location} without creating it`,
    { skip: !posix },
    async () => {
      const f = await fixture();
      try {
        for (const [name, destination] of [
          ['existing', f[location]],
          ['dangling', path.join(f[location], 'uncreated')],
        ]) {
          const link = path.join(f.scratch, name);
          await symlink(destination, link);
          await assert.rejects(
            externalPath(path.join(link, 'build'), [f.target, f.harness]),
            /protected checkout/
          );
          assert.equal(await exists(path.join(f[location], 'uncreated')), false);
        }
      } finally {
        await f.dispose();
      }
    }
  );
}
test('accepts a sibling cache and the wrapper staging only its generated proof input', async () => {
  const f = await fixture();
  try {
    const sibling = path.join(f.scratch, 'dedicated-cache');
    assert.equal(await externalPath(sibling, [f.target, f.harness]), sibling);
    await put(f.harness, '.relayflow/pr-proof-input.json', '{"wrapper":"generated"}\n');
    git(f.harness, 'add', '.relayflow/pr-proof-input.json');
    await assertProofInputs(f.inputs, 'before');
    await assertProofInputs(f.inputs, 'after');
  } finally {
    await f.dispose();
  }
});
for (const phase of ['before', 'after']) {
  for (const [location, file, stage] of [
    ['target', 'crates/relay-node/src/lib.rs', false],
    ['target', 'crates/relay-node/Cargo.lock', true],
    ['target', 'crates/relay-node/src/new.rs', false],
    ['target', 'crates/relay-node/src/new.ignored.rs', false],
    ['harness', `${CASE_PATH}/fixture.rs`, false],
    ['harness', `${CASE_PATH}/run.mjs`, true],
    ['harness', `${CASE_PATH}/untracked-helper.mjs`, false],
    ['harness', 'scripts/pr-proof/process-runner.mjs', false],
  ]) {
    test(`refuses ${stage ? 'staged' : 'modified/untracked'} ${location} ${file} ${phase}`, async () => {
      const f = await fixture();
      try {
        await put(f[location], file, '// dirty consumed input\n');
        if (stage) git(f[location], 'add', file);
        await assert.rejects(assertProofInputs(f.inputs, phase), new RegExp(`inputs.*\\(${phase}\\)`));
      } finally {
        await f.dispose();
      }
    });
  }
}
test('child environment omits credentials, loader hooks and Relay overrides without changing HOME', () => {
  const blocked = [
    'FACTORY_API_KEY',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'NODE_OPTIONS',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'RUSTC_WRAPPER',
    'AGENT_RELAY_SOCKET',
    'RELAY_API_KEY',
  ];
  const before = new Map(blocked.map((name) => [name, process.env[name]]));
  try {
    for (const name of blocked) process.env[name] = 'proof-sentinel-not-a-credential';
    const env = childEnv();
    assert.equal(env.HOME, process.env.HOME);
    for (const name of blocked) assert.equal(env[name], undefined);
    assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test(
  'bounded subprocess timeout terminates a Cargo-shaped parent and compiler descendant',
  { skip: !posix, timeout: 10_000 },
  async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'relay-2100-process-'));
    const pidsPath = path.join(scratch, 'pids.json');
    let pids = [];
    try {
      const code = `const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
      await assert.rejects(
        run(process.execPath, ['-e', code, pidsPath], { timeoutMs: 500, terminationGraceMs: 100 }),
        /timedOut true/
      );
      pids = JSON.parse(await readFile(pidsPath, 'utf8'));
      for (const pid of pids) {
        let running = true;
        for (let attempt = 0; attempt < 30 && running; attempt++) {
          const state = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], {
            encoding: 'utf8',
            env: childEnv(),
          });
          running =
            state.status === 0 && Boolean(state.stdout.trim()) && !state.stdout.trim().startsWith('Z');
          if (running) await delay(25);
        }
        assert.equal(running, false, `Proof descendant ${pid} survived timeout.`);
      }
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      await rm(scratch, { recursive: true, force: true });
    }
  }
);

// These simulate ONLY compile/runtime completion to exercise refusal guards.
// They must never produce accepted routing evidence; real base/head proof uses Cargo/Rust.
async function runGuardScenario(f, { cache, dirtyAfter }) {
  const bin = path.join(f.scratch, 'bin');
  await mkdir(bin);
  const called = path.join(f.scratch, 'cargo-called');
  const marker = { status: 404, code: 'not_found' };
  const matrix = {
    managed: marker,
    wrongPid: marker,
    wrongUid: marker,
    get: marker,
    noAccount: marker,
    declined: marker,
    control: { status: 409, code: 'attestation_unavailable' },
    managedCalls: 0,
    declinedCalls: 0,
    peerForwarding: false,
  };
  const cargoCode = `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');fs.writeFileSync(${JSON.stringify(called)},'called');const output=process.argv[process.argv.indexOf('--target-dir')+1];fs.mkdirSync(path.join(output,'debug'),{recursive:true});fs.writeFileSync(path.join(output,'debug','relay-pr-2100-consumer'),${JSON.stringify(`#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(matrix))});\n`)},{mode:0o700});${dirtyAfter ? `fs.writeFileSync(${JSON.stringify(path.join(f[dirtyAfter], dirtyAfter === 'target' ? 'crates/relay-node/src/lib.rs' : `${CASE_PATH}/fixture.rs`))},'// changed during subprocess\\n');` : ''}\n`;
  await put(bin, 'cargo', cargoCode);
  await chmod(path.join(bin, 'cargo'), 0o700);
  const result = path.join(f.scratch, 'result.json');
  await assert.rejects(
    run(process.execPath, [path.join(f.harness, CASE_PATH, 'run.mjs')], {
      env: {
        ...childEnv(),
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        RELAY_PR_PROOF_ARM: 'base',
        RELAY_PR_PROOF_TARGET_DIR: f.target,
        RELAY_PR_PROOF_HARNESS_DIR: f.harness,
        RELAY_PR_PROOF_RESULT_PATH: result,
        RELAY_PR_PROOF_BASE_SHA: f.inputs.targetSha,
        RELAY_PR_PROOF_HEAD_SHA: f.inputs.headSha,
        RELAY_PR_PROOF_CARGO_TARGET_DIR: cache,
      },
      timeoutMs: 10_000,
    }),
    dirtyAfter ? /consumed inputs are dirty \(after\)/ : /outside|protected checkout/
  );
  assert.equal(await exists(result), false, 'A refused guard produced accepted evidence.');
  assert.equal(await exists(called), Boolean(dirtyAfter), 'Cargo ran before the output-directory guard.');
}
for (const kind of ['inside', 'symlink']) {
  test(
    `the actual case runner rejects ${kind} build output before invoking Cargo or creating output`,
    { skip: !posix },
    async () => {
      const f = await fixture();
      try {
        let cache = path.join(f.target, 'must-not-create');
        if (kind === 'symlink') {
          cache = path.join(f.scratch, 'cache-link');
          await symlink(path.join(f.target, 'must-not-create'), cache);
        }
        await runGuardScenario(f, { cache });
        assert.equal((await readdir(f.target)).includes('must-not-create'), false);
      } finally {
        await f.dispose();
      }
    }
  );
}
for (const dirtyAfter of ['target', 'harness']) {
  test(
    `the actual case runner refuses ${dirtyAfter} mutation after compile/runtime before publishing a receipt`,
    { skip: !posix },
    async () => {
      const f = await fixture();
      try {
        await runGuardScenario(f, { cache: path.join(f.scratch, 'cache'), dirtyAfter });
      } finally {
        await f.dispose();
      }
    }
  );
}
