#!/usr/bin/env node

/**
 * Red/green proof for fleet-node attach CLI name normalization.
 *
 * The exact-head harness injects a Vitest probe into each exact target checkout.
 * It drives the production attach entrypoint with a fake terminal-session boundary
 * and roster, observing the ref sent to that boundary without live credentials.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1637-attach-node-name';
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
const resultPath = path.resolve(requiredValue('RELAY_PR_PROOF_RESULT_PATH'));
const arm = requiredValue('RELAY_PR_PROOF_ARM');
if (arm !== 'base' && arm !== 'head') {
  throw new Error(`RELAY_PR_PROOF_ARM must be base or head, received ${JSON.stringify(arm)}.`);
}

const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
if (!expectedSha) throw new Error(`Missing expected ${arm} SHA.`);
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
  timeout: COMMAND_TIMEOUT_MS,
}).trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
}

const runnerPath = fileURLToPath(import.meta.url);
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

const probePath = path.join(targetDir, 'packages/cli/src/cli/.relayflow-1637-attach-node-name.test.ts');
const configPath = path.join(targetDir, '.relayflow-1637-attach-node-name.vitest.config.mjs');
const observationPath = path.join(targetDir, '.relayflow-1637-attach-node-name-observation.json');

const probeSource = String.raw`import { writeFile } from 'node:fs/promises';

import { test, vi } from 'vitest';

const calls = vi.hoisted(() => ({ posts: [], rosterReads: [], viewCalls: [] }));
vi.mock('./lib/attach-fleet-node.js', () => ({
  startFleetNodeAttachProxy: async (options) => {
    calls.posts.push(options);
    return { brokerUrl: 'http://127.0.0.1:1', apiKey: 'local-proxy', requestTimeoutMs: 1000, close: async () => {} };
  },
  validateFleetAttachBaseUrl: (url) => url,
}));
vi.mock('./lib/sdk-client.js', () => ({
  resolveWorkspaceTransport: (options) => ({ workspaceKey: options.workspaceKey, baseUrl: options.baseUrl }),
  createWorkspaceRelay: (options) => ({ nodes: { list: async () => {
    calls.rosterReads.push(options);
    return [{ id: 'node_123', name: 'sf-mini', status: 'online', capabilities: [] }];
  } } }),
}));
vi.mock('./lib/attach-view.js', () => ({ attachView: async () => { calls.viewCalls.push(true); return 0; } }));

import { attachFleetNode } from './commands/local-agent.js';

const opts = { workspaceKey: 'rk_live_probe', baseUrl: 'https://cast.agentrelay.com' };
async function probe(node) {
  const before = calls.posts.length;
  let error = null;
  try { await attachFleetNode('lead', 'view', node, opts); }
  catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
  return { post: calls.posts.length > before ? calls.posts.at(-1) : null, error };
}

test('observe CLI attach request routing against a local fake terminal-session boundary', async () => {
  const name = await probe('sf-mini');
  const unknown = await probe('unknown-node');
  const id = await probe('node_123');
  await writeFile(process.env.RELAY_PR1637_OBSERVATION_PATH, JSON.stringify({ name, unknown, id, rosterReads: calls.rosterReads }), 'utf8');
});
`;

const configSource = `export default {
  test: {
    environment: 'node',
    include: ['packages/cli/src/cli/.relayflow-1637-attach-node-name.test.ts'],
    setupFiles: [],
  },
};\n`;

try {
  if (process.env.RELAY_PR_PROOF_DEV_SKIP_INSTALL !== '1') run('npm', ['ci', '--ignore-scripts'], targetDir, 'workspace dependency installation');
  if (process.env.RELAY_PR_PROOF_DEV_SKIP_INSTALL !== '1') run('npm', ['run', 'build:core'], targetDir, 'workspace package build');
  await writeGeneratedFile(probePath, probeSource);
  await writeGeneratedFile(configPath, configSource);
  run(
    'npm',
    ['exec', '--', 'vitest', 'run', '--config', path.relative(targetDir, configPath)],
    targetDir,
    'attach node name probe',
    { RELAY_PR1637_OBSERVATION_PATH: observationPath }
  );

  const observation = JSON.parse(await readFile(observationPath, 'utf8'));
  console.log('Attach node name proof observation:', JSON.stringify(observation));
  const baseObserved =
    observation.name?.post?.node === 'sf-mini' &&
    observation.unknown?.post?.node === 'unknown-node' &&
    observation.id?.post?.node === 'node_123' &&
    observation.rosterReads.length === 0;
  const headObserved =
    observation.name?.post?.node === 'node_123' &&
    observation.name?.post?.nodeRef === 'sf-mini' &&
    observation.unknown?.post === null &&
    observation.unknown?.error?.includes('No fleet node named') &&
    observation.id?.post?.node === 'node_123' &&
    observation.rosterReads.length === 2 &&
    observation.rosterReads.every(
      (entry) => entry.workspaceKey === 'rk_live_probe' && entry.baseUrl === 'https://cast.agentrelay.com'
    );
  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'bug';
    signature = 'attach_posts_node_name';
    details = 'The base CLI passes a roster name and an unknown name directly to terminal-session creation.';
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'attach_posts_stable_node_id';
    details =
      'The head CLI maps a name through the selected workspace roster, rejects an unknown name before session creation, and preserves a raw node ID.';
  } else {
    throw new Error(`Unexpected attach routing observation: ${JSON.stringify(observation)}.`);
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details }, null, 2)}\n`,
    'utf8'
  );
} finally {
  await rm(probePath, { force: true });
  await rm(configPath, { force: true });
  await rm(observationPath, { force: true });
}

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

async function writeGeneratedFile(targetPath, source) {
  try {
    const existing = await lstat(targetPath);
    if (!existing.isFile()) throw new Error(`Refusing to replace non-file ${targetPath}.`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(source, 'utf8');
    await handle.close();
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function run(command, args, cwd, label, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${label} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${label} exited ${result.status ?? 'null'}:\n${(result.stdout ?? '').slice(-2000)}\n${(result.stderr ?? '').slice(-2000)}`
    );
  }
}
