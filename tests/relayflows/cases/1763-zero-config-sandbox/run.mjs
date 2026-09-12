import { execFileSync, spawnSync } from 'node:child_process';
import { appendFile, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

let excludeState;
const probePath = path.join(targetDir, 'packages/cloud/src/.relayflow-1763-zero-config-sandbox.test.ts');
const configPath = path.join(targetDir, '.relayflow', '1763-zero-config-sandbox.vitest.config.mjs');
const observationPath = path.join(targetDir, '.relayflow-1763-zero-config-sandbox-observation.json');
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
test('fleet sandbox CLI forwards exact repo revision and uses returned provider identity for cleanup', async () => {
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
  const logs = [], warnings = [], deletes = [], releases = [];
  const program = new Command(); program.exitOverride();
  registerFleetCommands(program, {
    core: { getProjectPaths: () => ({ projectRoot: process.cwd() }), env: {} },
    resolveWorkspaceSelection: () => ({ workspaceId: 'rw-proof', key: 'probe-key', source: 'project' }),
    sdk: {
      createAgentRelay: vi.fn(() => ({ messaging: { placement: { spawn: vi.fn(async () => { throw new Error('synthetic dispatch failure'); }) } } })),
      createWorkspaceRelay: vi.fn(() => ({ workspace: { info: vi.fn(async () => ({ id: 'rw-proof' })), register: vi.fn(async () => ({ token: 'launcher' })), release: vi.fn(async (input) => { releases.push(input); return { deleted: true }; }) } })),
      createWorkspace: vi.fn(), log: (value) => logs.push(String(value)), error: vi.fn(), exit: vi.fn((code) => { throw new Error('CLI exit ' + code); }),
    },
    deleteCloudFleetSandbox: vi.fn(async (input) => { deletes.push(input); }),
    persistWorkspaceRelaycastTarget: () => true,
    log: () => undefined, warn: (...args) => warnings.push(args.join(' ')), error: () => undefined,
  });
  await expect(program.parseAsync(['fleet', 'spawn', 'codex', '--name', 'proof-worker', '--task', 'proof', '--sandbox', '--no-confirm'], { from: 'user' })).rejects.toThrow('CLI exit 1');
  const body = requests[1]?.body ?? {};
  await writeFile(output, JSON.stringify({ requestCount: requests.length, requestRepos: body.repos ?? null, requestRepoRevisions: body.repoRevisions ?? null, resultRepoRevisions: body.repoRevisions ?? null, workloadProfile: body.workloadProfile ?? null, cleanupProviderIds: deletes.map((x) => x.providerId ?? null), launcherReleases: releases.length, warnings }, null, 2));
  expect(releases.length).toBe(1); expect(deletes).toHaveLength(1); expect(deletes[0].providerId).toBe('agent37');
  if (${JSON.stringify(arm)} === 'head') { expect(body.repos).toEqual(['AgentWorkforce/relay']); expect(body.repoRevisions).toEqual({ 'AgentWorkforce/relay': revision }); expect(body.workloadProfile).toBe('long-running-agent'); expect(deletes).toHaveLength(1); expect(deletes[0].providerId).toBe('agent37'); }
  else { expect(body.repoRevisions ?? null).toBe(null); expect(body.workloadProfile).toBe('long-running-agent'); }
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
  excludeState = await prepareGitExclude(targetDir);
  await writeGeneratedFile(probePath, probeSource);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeGeneratedFile(configPath, configSource);
  run(
    'npm',
    ['exec', '--', 'vitest', 'run', '--config', path.relative(targetDir, configPath)],
    targetDir,
    'CLI repository revision proof',
    PROBE_TIMEOUT_MS,
    { RELAY_PR1763_OBSERVATION_PATH: observationPath }
  );
  const observation = JSON.parse(await readFile(observationPath, 'utf8'));
  const forwarded =
    JSON.stringify(observation.requestRepoRevisions) === JSON.stringify({ 'AgentWorkforce/relay': revision });
  const absent = observation.requestRepoRevisions === null;
  const outcome = arm === 'head' && forwarded ? 'fixed' : arm === 'base' && absent ? 'absent' : null;
  if (!outcome)
    throw new Error(`Unexpected repository revision observation: ${JSON.stringify(observation)}.`);
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature: outcome === 'fixed' ? 'sandbox_repository_revision_contract_forwarded' : 'sandbox_repository_revision_contract_absent', details: outcome === 'fixed' ? 'The real fleet spawn command inferred the repository, forwarded its exact revision to Cloud, and retained the returned provider attribution through the CLI path.' : 'The base fleet spawn command omitted the exact repository revision contract.' })}\n`
  );
} finally {
  await rm(probePath, { force: true });
  await rm(configPath, { force: true });
  await rm(observationPath, { force: true });
  if (excludeState) await restoreGitExclude(excludeState);
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
async function prepareGitExclude(root) {
  const raw = execFileSync('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude'], {
    encoding: 'utf8',
  }).trim();
  const file = path.isAbsolute(raw) ? raw : path.resolve(root, raw);
  let original = null;
  try {
    original = await readFile(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const marker = Buffer.from(
    '\n# relayflow-1763 generated probe\n.relayflow-1763-zero-config-sandbox-observation.json\npackages/cloud/src/.relayflow-1763-zero-config-sandbox.test.ts\n.relayflow/1763-zero-config-sandbox.vitest.config.mjs\nnode_modules\n'
  );
  const existing = original ?? Buffer.alloc(0);
  if (!existing.includes(marker)) await appendFile(file, marker);
  return { file, original };
}
async function restoreGitExclude(state) {
  if (state.original === null) {
    await rm(state.file, { force: true });
  } else {
    await writeFile(state.file, state.original);
  }
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
