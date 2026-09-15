import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1763-zero-config-sandbox';
const INSTALL_TIMEOUT_MS = 8 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5 * 60 * 1000;
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
const configPath = path.join(targetDir, '.relayflow', '1763-zero-config-sandbox.vitest.config.mjs');
const observationPath = path.join(targetDir, '.relayflow-1763-zero-config-sandbox-observation.json');
const excludePath = path.join(path.dirname(resultPath), `${CASE_ID}-${arm}.exclude`);
const revision = expectedSha;
const configSource = `import path from 'node:path';
const names = ['cloud','config','fleet','harness-driver','harnesses','policy','sdk','session','utils'];
export default { resolve: { alias: names.flatMap((name) => { const root = path.resolve(process.cwd(), 'packages', name, 'src'); return [{ find: new RegExp('^@agent-relay/' + name + '/(.+)$'), replacement: root + '/$1' }, { find: '@agent-relay/' + name, replacement: path.join(root, 'index.ts') }]; }) }, test: { environment: 'node', include: ['packages/cloud/src/.relayflow-1763-zero-config-sandbox.test.ts'], setupFiles: [] } };
`;
const probeSource = String.raw`import { expect, test, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { Command } from 'commander';
const mocks = vi.hoisted(() => ({ ensureCloudSession: vi.fn(), authorizedApiFetch: vi.fn() }));
vi.mock('./auth.js', () => ({ ensureCloudSession: mocks.ensureCloudSession, authorizedApiFetch: mocks.authorizedApiFetch }));
vi.mock('../../cli/src/cli/lib/broker-lifecycle.js', () => ({ readBrokerConnection: vi.fn(() => ({ url: 'http://127.0.0.1:1', api_key: 'probe', pid: 1, port: 1 })) }));
vi.mock('@agent-relay/harness-driver', async (importOriginal) => ({ ...(await importOriginal()), HarnessDriverClient: class { async getSession() { return { workspace_key: 'probe', node_token: 'probe', node_id: 'node', node_name: 'node', broker_version: '1', protocol_version: 2, mode: 'persist', uptime_secs: 1 }; } async listAgents() { return []; } async listFleetInventory() { return { nodeName: 'node', agents: [] }; } disconnect() {} } }));
import { registerFleetCommands } from '../../cli/src/cli/commands/fleet.js';
const revision = '${revision}';
const auth = { accessToken: 'probe', refreshToken: 'probe', accessTokenExpiresAt: '2099-01-01T00:00:00Z', apiUrl: 'https://relayflow.invalid' };
test('fleet sandbox CLI materializes exact source through a scoped live Relayfile mount', async () => {
  const output = process.env.RELAY_PR1763_OBSERVATION_PATH;
  if (!output) throw new Error('Missing observation path.');
  const requests = [];
  mocks.ensureCloudSession.mockResolvedValue({ auth, client: {} });
  mocks.authorizedApiFetch.mockImplementation(async (_auth, _path, request) => {
    const body = request?.body ? JSON.parse(request.body) : null;
    requests.push({ body });
    if (requests.length === 1) return { response: Response.json({ cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99' }), auth };
    return { response: Response.json({ outcome: 'provisioned', cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99', nodeId: 'node-proof', nodeName: body?.name ?? 'sandbox-proof', sandboxId: body?.sandboxId ?? 'sbx_123e4567-e89b-42d3-a456-426614174000', relayWorkspaceId: 'rw-proof', relayfileMounted: true, providerId: 'agent37', relaycastTarget: { route: 'agent37-isolated', baseUrl: 'https://agent37-cast.agentrelay.com', workspaceId: 'rw-proof', relaycastApiKey: 'rk_live_probe' }, repoRevisions: body?.repoRevisions ?? undefined }, { status: 201 }), auth };
  });
  const logs = [], warnings = [], deletes = [], releases = [], materializations = [], spawnInputs = [];
  const program = new Command(); program.exitOverride();
  registerFleetCommands(program, {
    core: { getProjectPaths: () => ({ projectRoot: process.cwd() }), env: {} },
    resolveWorkspaceSelection: () => ({ workspaceId: 'rw-proof', key: 'probe-key', source: 'project' }),
    sdk: {
      createAgentRelay: vi.fn(() => ({ messaging: { placement: { spawn: vi.fn(async (input) => { spawnInputs.push(input); throw new Error('synthetic dispatch failure'); }) } } })),
      createWorkspaceRelay: vi.fn(() => ({ workspace: { info: vi.fn(async () => ({ id: 'rw-proof' })), register: vi.fn(async () => ({ token: 'launcher' })), release: vi.fn(async (input) => { releases.push(input); return { deleted: true }; }) } })),
      createWorkspace: vi.fn(), log: (value) => logs.push(String(value)), error: vi.fn(), exit: vi.fn((code) => { throw new Error('CLI exit ' + code); }),
    },
    resolveSandboxRepository: vi.fn(() => ({ repository: 'AgentWorkforce/relay', repositoryName: 'relay', revision, projectRoot: process.cwd(), repositoryRelativeCwd: 'packages/cli', workerCwd: '/srv/agent-workforce/relay/packages/cli' })),
    materializeCloudRelayfileRepository: vi.fn(async (input) => { materializations.push(input); return { cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99', repository: input.repository, revision: input.revision, filesWritten: 1234, contentRoot: '/github/repos/AgentWorkforce/relay/contents', sentinelPath: '/github/repos/AgentWorkforce/relay/.relayfile/clone.json' }; }),
    deleteCloudFleetSandbox: vi.fn(async (input) => { deletes.push(input); }),
    persistWorkspaceRelaycastTarget: () => true,
    log: () => undefined, warn: (...args) => warnings.push(args.join(' ')), error: () => undefined,
  });
  await expect(program.parseAsync(['fleet', 'spawn', 'codex', '--name', 'proof-worker', '--task', 'proof', '--sandbox', '--no-confirm'], { from: 'user' })).rejects.toThrow('CLI exit 1');
  const body = requests[1]?.body ?? {};
  await writeFile(output, JSON.stringify({ requestCount: requests.length, materializations, requestRepos: body.repos ?? null, requestRepoRevisions: body.repoRevisions ?? null, relayfilePaths: body.relayfilePaths ?? null, workloadProfile: body.workloadProfile ?? null, workerCwd: spawnInputs[0]?.input?.worker_cwd ?? null, task: spawnInputs[0]?.input?.task ?? null, cleanupProviderIds: deletes.map((x) => x.providerId ?? null), launcherReleases: releases.length, warnings }, null, 2));
  if (${JSON.stringify(arm)} === 'head') { expect(materializations).toEqual([{ workspaceId: 'rw-proof', repository: 'AgentWorkforce/relay', revision }]); expect(body.repos ?? null).toBe(null); expect(body.repoRevisions ?? null).toBe(null); expect(body.relayfilePaths).toEqual(['/github/repos/AgentWorkforce/relay/contents/**', '/github/repos/AgentWorkforce/relay/.relayfile/**', '/.skills/**']); expect(spawnInputs[0]?.input?.worker_cwd).toBe('/workspace/github/repos/AgentWorkforce/relay/contents/packages/cli'); expect(spawnInputs[0]?.input?.task).toContain(revision); expect(body.workloadProfile).toBe('long-running-agent'); expect(releases).toHaveLength(1); expect(deletes).toHaveLength(1); expect(deletes[0].providerId).toBe('agent37'); }
  else { expect(materializations).toHaveLength(0); expect(body.workloadProfile).toBe('long-running-agent'); }
});
`;
try {
  if (process.env.RELAY_PR1763_SKIP_INSTALL !== '1')
    run(
      'npm',
      ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      targetDir,
      'Cloud dependency installation',
      INSTALL_TIMEOUT_MS
    );
  await writeGeneratedFile(
    excludePath,
    '.relayflow-1763-zero-config-sandbox-observation.json\npackages/cloud/src/.relayflow-1763-zero-config-sandbox.test.ts\n.relayflow/1763-zero-config-sandbox.vitest.config.mjs\nnode_modules\n'
  );
  await writeGeneratedFile(probePath, probeSource);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeGeneratedFile(configPath, configSource);
  run(
    'npm',
    ['exec', '--', 'vitest', 'run', '--config', path.relative(targetDir, configPath)],
    targetDir,
    'CLI repository revision proof',
    PROBE_TIMEOUT_MS,
    {
      RELAY_PR1763_OBSERVATION_PATH: observationPath,
      ...withGitExcludeEnv(excludePath),
    }
  );
  const observation = JSON.parse(await readFile(observationPath, 'utf8'));
  const forwarded =
    observation.materializations?.length === 1 &&
    observation.requestRepos === null &&
    observation.requestRepoRevisions === null &&
    JSON.stringify(observation.relayfilePaths) ===
      JSON.stringify([
        '/github/repos/AgentWorkforce/relay/contents/**',
        '/github/repos/AgentWorkforce/relay/.relayfile/**',
        '/.skills/**',
      ]) &&
    observation.workerCwd === '/workspace/github/repos/AgentWorkforce/relay/contents/packages/cli' &&
    observation.task?.includes(revision);
  const absent = observation.materializations?.length === 0;
  const outcome = arm === 'head' && forwarded ? 'fixed' : arm === 'base' && absent ? 'absent' : null;
  if (!outcome)
    throw new Error(`Unexpected repository revision observation: ${JSON.stringify(observation)}.`);
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature: outcome === 'fixed' ? 'live_relayfile_repository_contract_forwarded' : 'live_relayfile_repository_contract_absent', details: outcome === 'fixed' ? 'The real plain fleet spawn --sandbox command inferred the repository, materialized its exact revision through Relayfile, mounted source metadata and skills, mapped the caller-relative cwd, and sent no static clone request.' : 'The base plain fleet spawn command did not materialize or mount the inferred repository as a live decoded Relayfile working tree.' })}\n`
  );
} finally {
  await rm(probePath, { force: true });
  await rm(configPath, { force: true });
  await rm(observationPath, { force: true });
  await rm(excludePath, { force: true });
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
function run(command, args, cwd, label, timeoutMs, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: timeoutMs,
  });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with ${result.status}`);
}
function withGitExcludeEnv(file) {
  const rawCount = process.env.GIT_CONFIG_COUNT;
  const count = rawCount === undefined ? 0 : Number.parseInt(rawCount, 10);
  if (!Number.isSafeInteger(count) || count < 0 || count > 100) {
    throw new Error('Invalid inherited GIT_CONFIG_COUNT.');
  }
  return {
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: 'core.excludesFile',
    [`GIT_CONFIG_VALUE_${count}`]: file,
  };
}
async function writeGeneratedFile(file, contents) {
  try {
    const existing = await lstat(file);
    if (!existing.isFile()) throw new Error(`Refusing non-file ${file}.`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const tmp = `${file}.tmp-${process.pid}`;
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}
