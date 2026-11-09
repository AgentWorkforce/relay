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
import { assertArmIdentity, assertProofInputs, CASE_PATH, childEnv, externalPath, run } from './guards.mjs';
import { processIsRunning } from './process-probe.mjs';
import { createReceipt } from './receipt.mjs';

const caseDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(caseDir, '../../../..');
const posix = process.platform !== 'win32';
/** Run bounded fixture Git commands without user hooks, signing or monitor settings. */
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
/** Seed one fixture file, creating its parent directories as needed. */
async function put(root, name, value) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), value);
}
/** Create committed target and harness repositories with isolated cleanup ownership. */
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
  for (const name of ['run.mjs', 'guards.mjs', 'receipt.mjs', 'fixture.rs', 'case.json']) {
    await mkdir(path.join(harness, CASE_PATH), { recursive: true });
    await copyFile(path.join(caseDir, name), path.join(harness, CASE_PATH, name));
  }
  await put(
    harness,
    'scripts/verify-features/process-runner.mjs',
    await readFile(path.join(rootDir, 'scripts/verify-features/process-runner.mjs'))
  );
  await put(
    harness,
    'scripts/verify-features/case-contract.mjs',
    await readFile(path.join(rootDir, 'scripts/verify-features/case-contract.mjs'))
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
/** Treat only ENOENT as absence; permission and other read failures must propagate. */
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
    ['harness', 'scripts/verify-features/process-runner.mjs', false],
    ['harness', 'scripts/verify-features/case-contract.mjs', false],
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
// Real index flags can hide dirty working bytes while HEAD and status stay unchanged.
for (const phase of ['before', 'after']) {
  for (const location of ['target', 'harness']) {
    for (const [label, flags, tag] of [
      ['assume-unchanged', ['--assume-unchanged'], 'h'],
      ['skip-worktree', ['--skip-worktree'], 'S'],
      ['both index flags', ['--skip-worktree', '--assume-unchanged'], 's'],
    ]) {
      test(`refuses hidden dirty ${location} ${label} ${phase}`, async () => {
        const f = await fixture();
        try {
          const file = location === 'target' ? 'crates/relay-node/src/lib.rs' : `${CASE_PATH}/fixture.rs`;
          for (const flag of flags) git(f[location], 'update-index', flag, '--', file);
          await put(f[location], file, '// actual dirty bytes hidden by Git index flags\n');
          assert.equal(
            git(f[location], 'status', '--porcelain=v1', '--', file),
            '',
            'Fixture did not reproduce the hidden dirty-source defect.'
          );
          assert.equal(
            git(f[location], 'ls-files', '-v', '--', file),
            `${tag} ${file}`,
            'Unexpected local Git index-flag semantics.'
          );
          await assert.rejects(assertProofInputs(f.inputs, phase), new RegExp(`index flags.*\\(${phase}\\)`));
        } finally {
          await f.dispose();
        }
      });
    }
  }
}
// A stale fsmonitor can preserve ordinary H tags while hiding different working bytes.
for (const phase of ['before', 'after']) {
  for (const location of ['target', 'harness']) {
    test(`refuses stale fsmonitor dirty ${location} ${phase}`, { skip: !posix }, async () => {
      const f = await fixture();
      try {
        const directory = f[location];
        const file = location === 'target' ? 'crates/relay-node/src/lib.rs' : `${CASE_PATH}/fixture.rs`;
        const hook = path.join(f.scratch, 'stale-fsmonitor');
        await writeFile(hook, "#!/bin/sh\nprintf 'stable-token\\0'\n", { mode: 0o700 });
        git(directory, 'config', 'core.fsmonitor', hook);
        git(directory, 'config', 'core.fsmonitorHookVersion', '2');
        const enabled = ['-c', `core.fsmonitor=${hook}`];
        // Explicit refresh writes the monitor's valid bits despite optional-locks=0.
        git(directory, ...enabled, 'update-index', '--refresh');
        assert.equal(git(directory, ...enabled, 'ls-files', '-f', '--', file), `h ${file}`);
        const dirty = '// actual modified bytes omitted by the stale monitor\n';
        await put(directory, file, dirty);
        assert.notEqual(git(directory, 'show', `HEAD:${file}`), dirty.trim());
        assert.equal(git(directory, ...enabled, 'ls-files', '-v', '--', file), `H ${file}`);
        assert.equal(
          git(directory, ...enabled, 'status', '--porcelain=v1', '--untracked-files=all', '--', file),
          '',
          'Fixture did not reproduce stale fsmonitor hiding dirty input.'
        );
        await assert.rejects(
          assertProofInputs(f.inputs, phase),
          new RegExp(`inputs are dirty.*\\(${phase}\\)`)
        );
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

test('process probe verifies a real live process and a real no-match', { skip: !posix }, () => {
  assert.equal(processIsRunning(process.pid), true);
  const exited = spawnSync(process.execPath, ['-e', ''], { env: childEnv(), timeout: 2_000 });
  assert.equal(exited.status, 0);
  assert(Number.isInteger(exited.pid));
  assert.equal(processIsRunning(exited.pid), false);
});
for (const [name, body] of [
  ['failing exit', 'process.exit(2)'],
  ['quiet failure rather than no-match', 'process.exit(1)'],
  ['stderr query error', "process.stderr.write('fixture query error');console.log('S')"],
  ['empty successful output', 'process.exit(0)'],
  ['invalid successful output', "console.log('not-a-state')"],
  ['multiple successful states', "console.log('S\\nR')"],
  ['no-match with output', "console.log('S');process.exit(1)"],
  ['terminated query', "process.kill(process.pid,'SIGTERM')"],
  ['timed out query', 'setInterval(()=>{},1000)'],
]) {
  test(`process probe refuses ${name}`, { skip: !posix, timeout: 8_000 }, async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'relay-2100-ps-'));
    try {
      const command = path.join(scratch, 'ps-fixture');
      await writeFile(command, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
      assert.throws(
        () => processIsRunning(process.pid, { command, timeoutMs: name === 'timed out query' ? 500 : 2_000 }),
        /Process-state/
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}
test(
  'process probe refuses missing ps instead of treating it as a stopped child',
  { skip: !posix },
  async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'relay-2100-no-ps-'));
    try {
      assert.throws(
        () => processIsRunning(process.pid, { command: path.join(scratch, 'missing-ps') }),
        /Process-state query failed/
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
);

test(
  'bounded subprocess timeout terminates a Cargo-shaped parent and compiler descendant',
  { skip: !posix, timeout: 15_000 },
  async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'relay-2100-process-'));
    const pidsPath = path.join(scratch, 'pids.json');
    let pids = [];
    try {
      const code = `const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
      await assert.rejects(
        run(process.execPath, ['-e', code, pidsPath], { timeoutMs: 5_000, terminationGraceMs: 100 }),
        /timedOut true/
      );
      pids = JSON.parse(await readFile(pidsPath, 'utf8'));
      for (const pid of pids) {
        let running = true;
        for (let attempt = 0; attempt < 30 && running; attempt++) {
          running = processIsRunning(pid);
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

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(
    `runner ${signal} interruption stops its Cargo-shaped process tree`,
    { skip: !posix, timeout: 15_000 },
    async () => {
      const f = await fixture();
      const pidsPath = path.join(f.scratch, 'interrupted-pids.json');
      const result = path.join(f.scratch, 'interrupted-observation.json');
      const helper = path.join(f.scratch, 'interruption-helper.mjs');
      let pids;
      let completion;
      try {
        const cargo = `const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});writeFileSync(process.argv[1],JSON.stringify([process.ppid,process.pid,child.pid]));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
        const code = `import{run}from ${JSON.stringify(new URL('./guards.mjs', import.meta.url).href)};import{createReceipt}from ${JSON.stringify(new URL('./receipt.mjs', import.meta.url).href)};const receipt=await createReceipt(${JSON.stringify(result)},${JSON.stringify([f.target, f.harness])});try{await run(process.execPath,['-e',${JSON.stringify(cargo)},${JSON.stringify(pidsPath)}],{timeoutMs:10000});await receipt.write('{"unexpectedObservation":true}');}finally{await receipt.close();}`;
        await writeFile(helper, code);
        // Convert rejection immediately so readiness polling cannot cause an unhandled rejection.
        completion = run(process.execPath, [helper], { timeoutMs: 12_000, terminationGraceMs: 100 }).then(
          () => ({ succeeded: true }),
          (error) => ({ error })
        );
        for (let attempt = 0; attempt < 200 && !(await exists(pidsPath)); attempt++) await delay(25);
        pids = JSON.parse(await readFile(pidsPath, 'utf8'));
        assert.equal(pids.length, 3);
        process.kill(pids[0], signal);
        const outcome = await completion;
        assert(outcome.error, 'Interrupted helper returned success.');
        for (const pid of pids.slice(1)) {
          let running = true;
          for (let attempt = 0; attempt < 30 && running; attempt++) {
            running = processIsRunning(pid);
            if (running) await delay(25);
          }
          assert.equal(running, false, `Interrupted proof descendant ${pid} survived.`);
        }
        assert.match(outcome.error.message, /aborted true/, 'Helper did not propagate cancellation.');
        const placeholder = await readFile(result, 'utf8');
        assert.equal(placeholder, '', 'Interrupted helper published observation data.');
        assert.throws(() => JSON.parse(placeholder));
      } finally {
        if (!pids && (await exists(pidsPath))) pids = JSON.parse(await readFile(pidsPath, 'utf8'));
        for (const pid of pids ?? []) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
        if (completion) await completion;
        await f.dispose();
      }
    }
  );
}

test('subprocess signal listeners are removed after success and failure', async () => {
  const before = ['SIGTERM', 'SIGINT'].map((signal) => process.listenerCount(signal));
  await run(process.execPath, ['-e', ''], { timeoutMs: 2_000 });
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(7)'], { timeoutMs: 2_000 }));
  assert.deepEqual(
    ['SIGTERM', 'SIGINT'].map((signal) => process.listenerCount(signal)),
    before
  );
});

/** Simulate compile/runtime completion only to test refusals, never to produce accepted routing evidence. */
async function runGuardScenario(f, { cache, dirtyAfter, tmpdir, replaceParent, existingReceipt }) {
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
  const result = replaceParent
    ? path.join(f.scratch, 'receipt-parent', 'observation.json')
    : path.join(f.scratch, 'result.json');
  const victim = path.join(f.target, 'observation.json'),
    original = 'original tracked checkout bytes';
  if (replaceParent) {
    await mkdir(path.dirname(result));
    await put(f.target, 'observation.json', original);
    git(f.target, 'add', 'observation.json');
    git(f.target, 'commit', '--quiet', '-m', 'Tracked replacement victim');
    f.inputs.targetSha = git(f.target, 'rev-parse', 'HEAD');
  }
  if (existingReceipt) await writeFile(result, 'prior receipt must remain unchanged');
  const replace = replaceParent
    ? `fs.renameSync(${JSON.stringify(path.dirname(result))},${JSON.stringify(path.join(f.scratch, 'moved-receipt-parent'))});fs.symlinkSync(${JSON.stringify(f.target)},${JSON.stringify(path.dirname(result))},'dir');`
    : '';
  const cargoCode = `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');fs.writeFileSync(${JSON.stringify(called)},'called');const output=process.argv[process.argv.indexOf('--target-dir')+1];fs.mkdirSync(path.join(output,'debug'),{recursive:true});fs.writeFileSync(path.join(output,'debug','relay-pr-2100-consumer'),${JSON.stringify(`#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(matrix))});\n`)},{mode:0o700});${replace}${dirtyAfter ? `fs.writeFileSync(${JSON.stringify(path.join(f[dirtyAfter], dirtyAfter === 'target' ? 'crates/relay-node/src/lib.rs' : `${CASE_PATH}/fixture.rs`))},'// changed during subprocess\\n');` : ''}\n`;
  await put(bin, 'cargo', cargoCode);
  await chmod(path.join(bin, 'cargo'), 0o700);
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
        ...(tmpdir ? { TMPDIR: tmpdir, TMP: tmpdir, TEMP: tmpdir } : {}),
      },
      timeoutMs: 10_000,
    }),
    dirtyAfter
      ? /consumed inputs are dirty \(after\)/
      : existingReceipt
        ? /EEXIST/
        : /outside|protected checkout|Receipt.*changed/
  );
  if (replaceParent) {
    assert.equal(
      await readFile(victim, 'utf8'),
      original,
      'Receipt publication changed tracked checkout bytes.'
    );
    assert.equal(
      await readFile(path.join(f.scratch, 'moved-receipt-parent', 'observation.json'), 'utf8'),
      ''
    );
  } else if (existingReceipt)
    assert.equal(await readFile(result, 'utf8'), 'prior receipt must remain unchanged');
  else if (dirtyAfter) {
    const placeholder = await readFile(result, 'utf8');
    assert.equal(placeholder, '', 'A refused guard published observation data.');
    assert.throws(() => JSON.parse(placeholder));
  } else assert.equal(await exists(result), false, 'A preflight refusal created a receipt.');
  assert.equal(
    await exists(called),
    Boolean(dirtyAfter || replaceParent),
    'Cargo ran before the preflight guard.'
  );
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

for (const location of ['target', 'harness']) {
  test(
    `the actual runner rejects TMPDIR within ${location} before Cargo can inherit uncommitted config`,
    { skip: !posix },
    async () => {
      const f = await fixture();
      try {
        const config = '[build]\nrustflags=["--cfg=uncommitted_proof_input"]\n';
        await put(f[location], '.cargo/config.toml', config);
        await runGuardScenario(f, { cache: path.join(f.scratch, 'cache'), tmpdir: f[location] });
        assert.equal(await readFile(path.join(f[location], '.cargo/config.toml'), 'utf8'), config);
        assert(!(await readdir(f[location])).some((name) => name.startsWith('relay-2100-proof-')));
      } finally {
        await f.dispose();
      }
    }
  );
}
test(
  'the actual runner refuses a replaced receipt parent without overwriting tracked checkout bytes',
  { skip: !posix },
  async () => {
    const f = await fixture();
    try {
      await runGuardScenario(f, { cache: path.join(f.scratch, 'cache'), replaceParent: true });
    } finally {
      await f.dispose();
    }
  }
);
test(
  'the actual runner never truncates an existing receipt and refuses before Cargo',
  { skip: !posix },
  async () => {
    const f = await fixture();
    try {
      await runGuardScenario(f, { cache: path.join(f.scratch, 'cache'), existingReceipt: true });
    } finally {
      await f.dispose();
    }
  }
);

test('a fresh handle-bound receipt writes only its reserved regular file', async () => {
  const f = await fixture();
  try {
    const result = path.join(f.scratch, 'receipt-unit.json');
    const receipt = await createReceipt(result, [f.target, f.harness]);
    try {
      await receipt.write('{"receiptUnitOnly":true}\n');
    } finally {
      await receipt.close();
    }
    assert.deepEqual(JSON.parse(await readFile(result, 'utf8')), { receiptUnitOnly: true });
  } finally {
    await f.dispose();
  }
});

test('head-only corpus identities are accepted without weakening base discrimination', () => {
  const same = '1'.repeat(40),
    other = '2'.repeat(40);
  assert.doesNotThrow(() => assertArmIdentity('head', same, same));
  assert.doesNotThrow(() => assertArmIdentity('head', same, other));
  assert.doesNotThrow(() => assertArmIdentity('base', same, other));
  assert.throws(() => assertArmIdentity('base', same, same), /must differ/);
  assert.throws(() => assertArmIdentity('unknown', same, other), /Unknown proof arm/);
});

test('case manifest and observations use the current verify-features contract', async () => {
  const { validateCaseManifest, validateObservation } =
    await import('../../../../scripts/verify-features/case-contract.mjs');
  const manifest = validateCaseManifest(JSON.parse(await readFile(path.join(caseDir, 'case.json'), 'utf8')), {
    caseId: '2100-copilot-native-mcp-route',
    kind: 'bugfix',
  });
  for (const arm of ['base', 'head']) {
    const expected = manifest.expected[arm];
    const observation = {
      version: 1,
      caseId: manifest.id,
      arm,
      ...expected,
      details: 'synthetic schema validation only; not a route observation',
    };
    assert.deepEqual(validateObservation(observation, { caseId: manifest.id, arm, expected }), observation);
    assert.throws(
      () =>
        validateObservation({ ...observation, signature: 'wrong' }, { caseId: manifest.id, arm, expected }),
      /Invalid case observation/
    );
  }
});
