// Portable process-boundary latency proof. Actual Windows ACL semantics remain
// covered by the unchanged native Windows CI tests; this does not emulate ACLs.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { stripTypeScriptTypes, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = 'windows-acl-cold-start';
const target = path.resolve(required('RELAY_PR_PROOF_TARGET_DIR'));
const harness = path.resolve(required('RELAY_PR_PROOF_HARNESS_DIR'));
const resultPath = required('RELAY_PR_PROOF_RESULT_PATH');
const arm = required('RELAY_PR_PROOF_ARM');
assert.ok(['base', 'head'].includes(arm));
const relative = path.relative(harness, fileURLToPath(import.meta.url));
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
const realExec = childProcess.execFileSync;
const actualSha = realExec('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(actualSha, required(arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA'));
const source = await readFile(
  path.join(target, 'packages/cloud/src/credential-directory-windows.ts'),
  'utf8'
);
const code = stripTypeScriptTypes(source, { mode: 'strip' });
const fixture = await mkdtemp(path.join(os.tmpdir(), 'relay-acl-case-'));
const originalPlatform = process.platform;
const originalSystemRoot = process.env.SystemRoot;
let scenario;
let observation;
try {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  process.env.SystemRoot = 'C:\\Windows';
  childProcess.execFileSync = (executable, args, options) => {
    observation.calls++;
    assert.equal(executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    assert.equal(args.length, 5);
    assert.equal(typeof args[4], 'string');
    assert.equal(typeof JSON.parse(options.input).directory, 'string');
    assert.ok(Number.isSafeInteger(options.timeout) && options.timeout > 0 && options.timeout <= 15_000);
    // Use a real child and the application's unchanged spawn options. A delayed
    // private result models cold native startup; no timer mocks or timeout bypass.
    const response =
      scenario === 'unsafe' ? { ok: false, reason: 'credential-parent-untrusted-allow' } : { ok: true };
    const delay = scenario === 'slow-private' ? 11_000 : scenario === 'hung' ? 20_000 : 0;
    const child = `process.stdin.resume(); process.stdin.on('end', () => setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(response))}), ${delay}));`;
    try {
      return realExec(process.execPath, ['-e', child], options);
    } catch (error) {
      observation.nativeTimeout = error?.code === 'ETIMEDOUT';
      throw error;
    }
  };
  syncBuiltinESMExports();
  const helperUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  const { assertWindowsCredentialDirectory } = await import(helperUrl);
  function probe(kind) {
    scenario = kind;
    observation = { calls: 0, nativeTimeout: false, accepted: false };
    const started = Date.now();
    try {
      assertWindowsCredentialDirectory(path.join(target, 'private-probe'));
      observation.accepted = true;
    } catch (error) {
      assert.match(String(error), /Windows Relaycast credential storage requires a private directory/);
    }
    observation.elapsedMs = Date.now() - started;
    assert.equal(observation.calls, 1, 'the native boundary must be evaluated exactly once');
    return observation;
  }
  const slow = probe('slow-private');
  const unsafe = probe('unsafe');
  assert.equal(unsafe.accepted, false);
  assert.equal(unsafe.nativeTimeout, false, 'unsafe ACL result must be evaluated, not time out');
  const hung = probe('hung');
  assert.equal(hung.accepted, false);
  assert.equal(
    hung.nativeTimeout,
    true,
    'an unresponsive native probe must fail closed at a finite deadline'
  );
  // Exercise the complete credential write too: a valid slow ACL result must
  // not consume the separate lock-contention budget before the first attempt.
  const storeSource = await readFile(path.join(target, 'packages/cloud/src/workspace-store.ts'), 'utf8');
  const importSpecifier = "'./credential-directory-windows.js'";
  assert.equal(storeSource.split(importSpecifier).length, 2);
  const storeCode = stripTypeScriptTypes(storeSource.replace(importSpecifier, JSON.stringify(helperUrl)), {
    mode: 'strip',
  });
  const store = await import(`data:text/javascript;base64,${Buffer.from(storeCode).toString('base64')}`);
  scenario = 'slow-private';
  observation = { calls: 0, nativeTimeout: false, accepted: false };
  try {
    store.writeRelaycastCredential(
      'latency-fixture',
      {
        workspaceId: 'rw_latency_fixture',
        route: 'canonical',
        baseUrl: 'https://relay.example',
        apiKey: 'test-credential',
      },
      { AGENT_RELAY_HOME: fixture }
    );
    observation.accepted = true;
  } catch (error) {
    assert.match(String(error), /Windows Relaycast credential storage requires a private directory/);
  }
  const write = observation;
  assert.equal(write.calls, 1);
  assert.equal(write.accepted, arm === 'head');
  assert.equal(write.nativeTimeout, arm === 'base');
  assert.equal(
    store.readRelaycastCredential('latency-fixture', { AGENT_RELAY_HOME: fixture })?.workspaceId,
    arm === 'head' ? 'rw_latency_fixture' : undefined
  );
  console.log(JSON.stringify({ caseId: CASE_ID, arm, slow, unsafe, hung, write }));
  const outcome =
    slow.accepted && !slow.nativeTimeout ? 'fixed' : !slow.accepted && slow.nativeTimeout ? 'bug' : null;
  assert.equal(outcome, arm === 'base' ? 'bug' : 'fixed');
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    JSON.stringify({
      version: 1,
      caseId: CASE_ID,
      arm,
      outcome,
      signature:
        outcome === 'fixed' ? 'private_acl_cold_start_validated' : 'private_acl_cold_start_times_out',
      details: `Actual runtime helper with real delayed child boundary: private=${slow.accepted}, unsafe denied, hung timed out; full credential write=${write.accepted}; actual Windows ACL rules separately verified by native CI.`,
    }) + '\n'
  );
} finally {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
  if (originalSystemRoot === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = originalSystemRoot;
  childProcess.execFileSync = realExec;
  syncBuiltinESMExports();
  await rm(fixture, { recursive: true, force: true });
}
function required(key) {
  const value = process.env[key];
  assert.ok(value, `Missing ${key}`);
  return value;
}
