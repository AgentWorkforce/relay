import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1763-zero-config-sandbox';
const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
const resultPath = requiredValue('RELAY_PR_PROOF_RESULT_PATH');
const arm = requiredValue('RELAY_PR_PROOF_ARM');
if (arm !== 'base' && arm !== 'head') throw new Error(`Invalid proof arm ${JSON.stringify(arm)}.`);

const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!expectedSha || targetSha !== expectedSha)
  throw new Error(`Target ${targetSha} is not expected ${arm} ${expectedSha}.`);
if (!isWithin(harnessDir, fileURLToPath(import.meta.url)))
  throw new Error('Runner is not from exact-head harness.');

const probePath = path.join(targetDir, 'packages/cloud/src/.relayflow-1763-zero-config-sandbox.test.ts');
const configPath = path.join(targetDir, '.relayflow-1763-zero-config-sandbox.vitest.config.mjs');
const observationPath = path.join(targetDir, '.relayflow-1763-zero-config-sandbox-observation.json');
const revision = '0123456789abcdef0123456789abcdef01234567';

const probeSource = String.raw`import { afterEach, expect, test, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';

const mocks = vi.hoisted(() => ({ ensureCloudSession: vi.fn(), authorizedApiFetch: vi.fn() }));
vi.mock('./auth.js', () => ({ ensureCloudSession: mocks.ensureCloudSession, authorizedApiFetch: mocks.authorizedApiFetch }));
import { ensureCloudFleetSandbox } from './fleet-sandbox.js';

afterEach(() => vi.restoreAllMocks());

test('forwards the exact repository revision contract to Cloud', async () => {
  const observationPath = process.env.RELAY_PR1763_OBSERVATION_PATH;
  if (!observationPath) throw new Error('Missing observation path.');
  const auth = { accessToken: 'relayflow-proof', refreshToken: 'relayflow-proof-refresh', accessTokenExpiresAt: '2099-01-01T00:00:00Z', apiUrl: 'https://relayflow.invalid' };
  mocks.ensureCloudSession.mockResolvedValue({ auth, client: {} });
  mocks.authorizedApiFetch
    .mockResolvedValueOnce({ response: Response.json({ cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99' }), auth })
    .mockResolvedValueOnce({ response: Response.json({ outcome: 'provisioned', nodeId: 'node-proof', nodeName: 'sandbox-proof', sandboxId: 'sandbox-proof', relayWorkspaceId: 'rw-proof', relayfileMounted: true, repoRevisions: { 'AgentWorkforce/relay': '${revision}' } }, { status: 201 }), auth });
  const result = await ensureCloudFleetSandbox({
    workspaceId: 'rw-proof',
    requiredCapability: 'spawn:codex',
    mountRelayfile: true,
    repos: ['AgentWorkforce/relay'],
    repoRevisions: { 'AgentWorkforce/relay': '${revision}' },
  });
  const request = mocks.authorizedApiFetch.mock.calls[1]?.[2];
  const body = request?.body ? JSON.parse(request.body) : {};
  await writeFile(observationPath, JSON.stringify({
    requestRepos: body.repos ?? null,
    requestRepoRevisions: body.repoRevisions ?? null,
    resultRepoRevisions: result.repoRevisions ?? null,
  }), 'utf8');
});
`;
const configSource = `export default { test: { environment: 'node', include: ['packages/cloud/src/.relayflow-1763-zero-config-sandbox.test.ts'], setupFiles: [] } };\n`;

try {
  run(
    'npm',
    ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    targetDir,
    'Cloud dependency installation'
  );
  run('npm', ['run', 'build:config'], targetDir, 'configuration package build');
  run('npm', ['run', 'build:cloud'], targetDir, 'Cloud package build');
  await writeGeneratedFile(probePath, probeSource);
  await writeGeneratedFile(configPath, configSource);
  run(
    'npm',
    ['exec', '--', 'vitest', 'run', '--config', path.relative(targetDir, configPath)],
    targetDir,
    'repository revision contract probe',
    { RELAY_PR1763_OBSERVATION_PATH: observationPath }
  );
  const observation = JSON.parse(await readFile(observationPath, 'utf8'));
  const forwarded =
    JSON.stringify(observation.requestRepos) === JSON.stringify(['AgentWorkforce/relay']) &&
    observation.requestRepoRevisions?.['AgentWorkforce/relay'] === revision &&
    observation.resultRepoRevisions?.['AgentWorkforce/relay'] === revision;
  const absent = observation.requestRepoRevisions === null && observation.resultRepoRevisions === null;
  const outcome = arm === 'base' && absent ? 'absent' : arm === 'head' && forwarded ? 'fixed' : null;
  if (!outcome)
    throw new Error(`Unexpected repository revision observation: ${JSON.stringify(observation)}.`);
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature: outcome === 'fixed' ? 'sandbox_repository_revision_contract_forwarded' : 'sandbox_repository_revision_contract_absent', details: outcome === 'fixed' ? 'The Cloud client forwarded and returned the exact repository revision without allocating a production sandbox.' : 'The base Cloud client omitted the repository revision contract, so zero-config exact checkout attestation was absent.' })}\n`,
    'utf8'
  );
} finally {
  await rm(probePath, { force: true });
  await rm(configPath, { force: true });
  await rm(observationPath, { force: true });
}

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
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
function run(command, args, cwd, label, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 5 * 60 * 1000,
  });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with ${result.status}`);
}
async function writeGeneratedFile(file, contents) {
  try {
    const existing = await lstat(file);
    if (!existing.isFile()) throw new Error(`Refusing non-file ${file}.`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}
