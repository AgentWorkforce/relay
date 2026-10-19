#!/usr/bin/env node

/**
 * Red/green proof for the workflow and node file surface.
 *
 * The exact-head harness injects a Vitest probe into each exact target checkout.
 * The probe drives production cloud inference, worker payload validation, local
 * workflow command registration, and node-definition discovery. It records what
 * those calls do. The arm is chosen only from that observation.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = 'workflow-node-file-surfaces';
const COMMAND_TIMEOUT_MS = 12 * 60 * 1000;
const LOCAL_ROUTE = { ts: 'relayflows', yaml: 'relayflows', js: 'node', sh: 'shell' };

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

const probePath = path.join(targetDir, 'packages/cli/src/cli/.relayflow-workflow-node-file-surfaces.test.ts');
const configPath = path.join(targetDir, '.relayflow-workflow-node-file-surfaces.vitest.config.mjs');
const observationPath = path.join(targetDir, '.relayflow-workflow-node-file-surfaces-observation.json');

const probeSource = String.raw`import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { inferWorkflowFileType, resolveWorkerWorkflowPayload } from '@agent-relay/cloud';
import { Command } from 'commander';
import { test } from 'vitest';

import { registerLocalWorkflowCommands } from './commands/local-workflow.js';

const observationPath = process.env.RELAY_WORKFLOW_SURFACE_OBSERVATION_PATH;

function payload(fileType, sourceFileType, workflowFileName) {
  return {
    runId: 'run_proof',
    workspaceId: 'ws_proof',
    relayWorkspaceId: 'rws_proof',
    relaycastApiKey: 'not-a-real-token',
    relayfileUrl: 'https://example.invalid/relayfile',
    relayfileToken: 'not-a-real-token',
    workflow: 'name: proof\n',
    fileType,
    sourceFileType,
    workflowFileName,
  };
}

async function acceptPayload(fileType, sourceFileType, workflowFileName) {
  try {
    const resolved = await resolveWorkerWorkflowPayload({
      workflowRef: {
        type: 'inline',
        value: JSON.stringify(payload(fileType, sourceFileType, workflowFileName)),
      },
    });
    return { accepted: resolved.fileType === fileType, error: null };
  } catch (error) {
    return { accepted: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function runLocal(cwd, argv, runId) {
  const spawned = [];
  const program = new Command();
  program.exitOverride();
  registerLocalWorkflowCommands(program, {
    cwd: () => cwd,
    env: { SHELL: '/bin/sh' },
    spawnProcess: () => {
      spawned.push(true);
      return { pid: 4242, unref() {} };
    },
    resolveRelayflowsCliEntrypoint: () => '/proof/relayflows-cli.mjs',
    randomRunId: () => runId,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    log: () => undefined,
    error: () => undefined,
    exit: (code) => {
      throw new Error('unexpected exit ' + code);
    },
  });

  let error = null;
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  let fileType = null;
  let route = null;
  try {
    const raw = await readFile(
      path.join(cwd, '.agentworkforce', 'relay', 'local-runs', runId, 'run.json'),
      'utf8'
    );
    const record = JSON.parse(raw);
    fileType = record.fileType ?? null;
    route = runnerRoute(record, path.resolve(cwd, argv[1]));
  } catch {
    fileType = null;
    route = null;
  }
  return { error, spawned: spawned.length === 1, fileType, route };
}

function runnerRoute(record, workflowPath) {
  if (!record || typeof record.command !== 'string' || !Array.isArray(record.args)) return null;
  const command = record.command;
  const args = record.args;
  if (
    command === process.execPath &&
    args.length === 3 &&
    args[0] === '/proof/relayflows-cli.mjs' &&
    args[1] === 'run' &&
    args[2] === workflowPath
  ) {
    return 'relayflows';
  }
  if (command === process.execPath && args.length === 1 && args[0] === workflowPath) return 'node';
  if (command === '/bin/sh' && args.length === 1 && args[0] === workflowPath) return 'shell';
  return 'other';
}

test('observe workflow and node file surfaces', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-workflow-surface-'));
  try {
    const cloudDir = path.join(root, 'cloud');
    await mkdir(cloudDir);
    await writeFile(path.join(cloudDir, 'flow.py'), 'print("ok")\n');
    await writeFile(path.join(cloudDir, 'flow.ts'), 'export default {}\n');
    await writeFile(path.join(cloudDir, 'flow.yaml'), 'name: proof\n');
    await writeFile(path.join(cloudDir, 'flow.js'), 'console.log("ok")\n');

    const cloud = {
      py: inferWorkflowFileType(path.join(cloudDir, 'flow.py')),
      ts: inferWorkflowFileType(path.join(cloudDir, 'flow.ts')),
      yaml: inferWorkflowFileType(path.join(cloudDir, 'flow.yaml')),
      js: inferWorkflowFileType(path.join(cloudDir, 'flow.js')),
    };

    const worker = {
      py: await acceptPayload('py', 'py', 'flow.py'),
      yaml: await acceptPayload('yaml', 'yaml', 'flow.yaml'),
      ts: await acceptPayload('ts', 'ts', 'flow.ts'),
    };

    async function localCase(name, argv) {
      const cwd = path.join(root, name);
      await mkdir(cwd);
      await writeFile(path.join(cwd, 'flow.py'), 'print("ok")\n');
      await writeFile(path.join(cwd, 'flow.ts'), 'export default {}\n');
      await writeFile(path.join(cwd, 'flow.js'), 'console.log("ok")\n');
      await writeFile(path.join(cwd, 'flow.sh'), 'echo ok\n');
      await writeFile(path.join(cwd, 'flow.yaml'), 'name: proof\n');
      return runLocal(cwd, argv, 'local_proof');
    }

    const local = {
      inferPy: await localCase('infer-py', ['run', 'flow.py']),
      explicitPy: await localCase('explicit-py', ['run', 'flow.py', '--file-type', 'py']),
      ts: await localCase('ts', ['run', 'flow.ts']),
      js: await localCase('js', ['run', 'flow.js']),
      sh: await localCase('sh', ['run', 'flow.sh']),
      yaml: await localCase('yaml', ['run', 'flow.yaml']),
    };

    const pyOnly = path.join(root, 'py-node');
    const tsOnly = path.join(root, 'ts-node');
    await mkdir(pyOnly);
    await mkdir(tsOnly);
    await writeFile(path.join(pyOnly, 'agent-relay.py'), '# node\n');
    await writeFile(path.join(tsOnly, 'agent-relay.ts'), 'export default {}\n');
    const loader = await import('./lib/node-definition-loader.js');
    const pythonPath =
      typeof loader.discoverPythonNodeConfigPath === 'function'
        ? loader.discoverPythonNodeConfigPath(pyOnly)
        : undefined;
    const typescriptPath = loader.discoverNodeConfigPath(tsOnly);
    const pythonViaJs = loader.discoverNodeConfigPath(pyOnly);

    await writeFile(
      observationPath,
      JSON.stringify({
        cloud,
        worker,
        local,
        node: {
          python: pythonPath ? path.basename(pythonPath) : null,
          typescript: typescriptPath ? path.basename(typescriptPath) : null,
          pythonViaJs: pythonViaJs ? path.basename(pythonViaJs) : null,
        },
      })
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
`;

const configSource = `export default {
  test: {
    environment: 'node',
    include: ['packages/cli/src/cli/.relayflow-workflow-node-file-surfaces.test.ts'],
    setupFiles: [],
  },
};
`;

try {
  run('npm', ['ci', '--ignore-scripts'], targetDir, 'workspace dependency installation');
  run('npm', ['run', 'build:core'], targetDir, 'workspace package build');
  await writeGeneratedFile(probePath, probeSource);
  await writeGeneratedFile(configPath, configSource);
  run(
    'npm',
    ['exec', '--', 'vitest', 'run', '--config', path.relative(targetDir, configPath)],
    targetDir,
    'workflow and node file surface probe',
    { RELAY_WORKFLOW_SURFACE_OBSERVATION_PATH: observationPath }
  );

  const observation = JSON.parse(await readFile(observationPath, 'utf8'));
  console.log('Workflow surface proof observation:', JSON.stringify(observation));
  const classified = classifyObservation(observation);
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify(
      {
        version: 1,
        caseId: CASE_ID,
        arm,
        outcome: classified.outcome,
        signature: classified.signature,
        details: classified.details,
      },
      null,
      2
    )}\n`,
    'utf8'
  );
} finally {
  await rm(probePath, { force: true });
  await rm(configPath, { force: true });
  await rm(observationPath, { force: true });
}

function supportedLocal(result, fileType) {
  return (
    result?.error === null &&
    result?.spawned === true &&
    result?.fileType === fileType &&
    result?.route === LOCAL_ROUTE[fileType]
  );
}

function messageIncludes(result, text) {
  return typeof result?.error === 'string' && result.error.includes(text);
}

function classifyObservation(observation) {
  const cloud = observation?.cloud ?? {};
  const worker = observation?.worker ?? {};
  const local = observation?.local ?? {};
  const node = observation?.node ?? {};
  const supported = ['ts', 'js', 'sh', 'yaml'].every((fileType) => supportedLocal(local[fileType], fileType));
  const shared =
    cloud.ts === 'ts' &&
    cloud.yaml === 'yaml' &&
    cloud.js === null &&
    worker.yaml?.accepted === true &&
    worker.yaml?.error === null &&
    worker.ts?.accepted === true &&
    worker.ts?.error === null &&
    supported &&
    node.typescript === 'agent-relay.ts' &&
    node.pythonViaJs === null;

  const baseObserved =
    shared &&
    cloud.py === 'py' &&
    worker.py?.accepted === true &&
    worker.py?.error === null &&
    local.inferPy?.fileType === 'py' &&
    local.inferPy?.spawned === true &&
    local.inferPy?.error === null &&
    local.inferPy?.route === 'relayflows' &&
    local.explicitPy?.fileType === 'py' &&
    local.explicitPy?.spawned === true &&
    local.explicitPy?.error === null &&
    local.explicitPy?.route === 'relayflows' &&
    node.python === 'agent-relay.py';

  const headObserved =
    shared &&
    cloud.py === null &&
    worker.py?.accepted === false &&
    messageIncludes(worker.py, 'Resolved worker workflow payload is invalid.') &&
    local.inferPy?.fileType === null &&
    local.inferPy?.spawned === false &&
    local.inferPy?.route === null &&
    messageIncludes(local.inferPy, 'Could not infer workflow type') &&
    local.explicitPy?.fileType === null &&
    local.explicitPy?.spawned === false &&
    local.explicitPy?.route === null &&
    messageIncludes(local.explicitPy, 'Expected workflow type to be one of: ts, js, sh, yaml') &&
    node.python === null;

  if (baseObserved) {
    return {
      outcome: 'absent',
      signature: 'py_workflow_and_node_surface_present',
      details:
        'Cloud inference, worker payloads, and local workflow runs accept a .py workflow through Relayflows, and node discovery selects agent-relay.py. YAML and TypeScript local runs start through Relayflows, JavaScript runs on Node, and shell runs on /bin/sh.',
    };
  }
  if (headObserved) {
    return {
      outcome: 'fixed',
      signature: 'yaml_ts_js_sh_workflow_surface',
      details:
        'Cloud inference and worker payloads accept YAML and TypeScript. YAML and TypeScript local runs start through Relayflows, JavaScript runs on Node, and shell runs on /bin/sh. A .py path is not a workflow or node file, and node discovery selects agent-relay.ts.',
    };
  }
  throw new Error(`Unexpected workflow surface observation: ${JSON.stringify(observation)}`);
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
