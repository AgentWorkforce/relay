import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CASE_ID = '1702-relayfile-sdk-workspace-404';
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
// createWorkspaceIfNeeded() takes no signal/timeout option of its own — it is
// an opaque call into the target checkout's installed SDK, hitting a
// same-process mock server that answers instantly, so it should never
// legitimately take anywhere near this long. Racing it against a timeout
// keeps a stalled or unexpectedly-retrying call from burning the case's
// entire 900s budget before failing closed with a clear diagnostic.
const WORKSPACE_CALL_TIMEOUT_MS = 15_000;

const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
const resultPath = requiredValue('RELAY_PR_PROOF_RESULT_PATH');
const arm = requiredValue('RELAY_PR_PROOF_ARM');

if (arm !== 'base' && arm !== 'head') {
  throw new Error(`RELAY_PR_PROOF_ARM must be base or head, received ${JSON.stringify(arm)}.`);
}

const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
if (!expectedSha) throw new Error(`Missing expected ${arm} SHA.`);
const targetSha = run(
  'git',
  ['-C', targetDir, 'rev-parse', 'HEAD'],
  targetDir,
  'git rev-parse'
).stdout.trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
}

const runnerPath = fileURLToPath(import.meta.url);
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

// The bug (relay#1702) is that @relayflows/core pins @relayfile/sdk to a
// version whose createWorkspaceIfNeeded() treats a 404 on the deprecated
// bare `POST /v1/workspaces` collection route as fatal. relayfile-cloud's
// real router never registers that route — only `/v1/workspaces/:id/...`,
// since workspaces are Durable Objects created implicitly by ID — so this
// is a guaranteed failure, not a hypothetical one. Reproducing it faithfully
// only requires the target checkout's OWN resolved @relayfile/sdk exercising
// the exact route shape the real service returns; standing up the real
// relayfile-cloud service is unnecessary and would make the case dependent
// on production availability instead of on the code actually under test.
const server = createServer((req, res) => {
  const isBareWorkspacesCollectionPost =
    req.method === 'POST' && new URL(req.url, 'http://127.0.0.1').pathname === '/v1/workspaces';
  if (isBareWorkspacesCollectionPost) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'not_found', message: 'Route not found' }));
    return;
  }
  // Any ID-scoped route (the only kind relayfile-cloud actually registers)
  // succeeds, matching production.
  res.writeHead(204);
  res.end();
});

let details;
let outcome;
let signature;

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // Fresh, exact-lockfile install of the target checkout so the resolved
  // @relayfile/sdk version is whatever that checkout's package.json and
  // package-lock.json actually pin — the real thing under test, not an
  // assumption about it.
  await rm(path.join(targetDir, 'node_modules'), { recursive: true, force: true });
  run('npm', ['ci'], targetDir, 'npm ci');

  const sdkEntryPath = path.join(targetDir, 'node_modules/@relayfile/sdk/dist/workspace-seeder.js');
  const sdkPackagePath = path.join(targetDir, 'node_modules/@relayfile/sdk/package.json');
  const { default: sdkPackage } = await import(pathToFileURL(sdkPackagePath).href, {
    with: { type: 'json' },
  });
  const { createWorkspaceIfNeeded } = await import(pathToFileURL(sdkEntryPath).href);

  let thrown = null;
  try {
    await withTimeout(
      createWorkspaceIfNeeded(baseUrl, 'proof-token', 'proof-workspace'),
      WORKSPACE_CALL_TIMEOUT_MS,
      'createWorkspaceIfNeeded'
    );
  } catch (error) {
    thrown = error;
  }

  if (thrown === null) {
    outcome = 'fixed';
    signature = 'relayfile_sdk_404_treated_as_noop';
    details = `@relayfile/sdk@${sdkPackage.version}: createWorkspaceIfNeeded() returned normally against a mock relayfile-cloud that 404s the bare collection route, matching the real service.`;
  } else if (/HTTP 404/.test(thrown.message ?? '')) {
    outcome = 'bug';
    signature = 'relayfile_sdk_404_fatal';
    details = `@relayfile/sdk@${sdkPackage.version}: createWorkspaceIfNeeded() threw on the mock relayfile-cloud's 404 for the bare collection route: ${thrown.message.slice(0, 500)}`;
  } else {
    throw thrown;
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(
  resultPath,
  `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`
);

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function requiredDirectory(name) {
  return path.resolve(requiredValue(name));
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function run(command, args, cwd, label) {
  const completed = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS });
  if (completed.error) throw new Error(`${label} could not start: ${completed.error.message}`);
  if (completed.status !== 0) {
    throw new Error(
      `${label} failed with ${
        completed.signal ? `signal ${completed.signal}` : `exit code ${completed.status ?? 'unknown'}`
      }: ${(completed.stderr ?? '').slice(-2000)}`
    );
  }
  return completed;
}
