import { execFileSync, spawnSync } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1727-standalone-cloud-workflow-runtime';
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
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
}

const runnerPath = fileURLToPath(import.meta.url);
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

const probeDir = await mkdtemp(path.join(tmpdir(), 'relayflow-1727-'));
const runtimeDir = path.join(probeDir, 'cloud-archive');
const binaryPath = path.join(probeDir, 'agent-relay');
const workflowPath = path.join(runtimeDir, 'workflow.yaml');

try {
  run('npm', ['ci', '--ignore-scripts'], targetDir, 'workspace dependency installation');
  run('npm', ['run', 'build:core'], targetDir, 'candidate CLI build');
  run(
    'bun',
    [
      'build',
      '--compile',
      '--minify',
      '--define',
      'process.env.AGENT_RELAY_VERSION="relayflow-proof"',
      '--external',
      'better-sqlite3',
      '--external',
      'cpu-features',
      '--external',
      'node-pty',
      path.join(targetDir, 'packages/cli/dist/cli/index.js'),
      '--outfile',
      binaryPath,
    ],
    targetDir,
    'standalone candidate compilation'
  );
  await access(binaryPath, fsConstants.R_OK | fsConstants.X_OK);

  await mkdir(runtimeDir, { mode: 0o700 });
  await writeFile(
    workflowPath,
    [
      'version: "1.0"',
      'name: "standalone-cloud-proof"',
      'swarm:',
      '  pattern: sequential',
      'agents: []',
      'workflows:',
      '  - name: proof',
      '    steps:',
      '      - name: noop',
      '        type: deterministic',
      '        command: "printf bundled-workflow-ok"',
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o600 }
  );
  try {
    await lstat(path.join(runtimeDir, 'node_modules'));
    throw new Error('The Cloud archive probe must not contain node_modules.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const observed = spawnSync(binaryPath, ['__bundled-workflow', 'run', workflowPath, '--dry-run'], {
    cwd: runtimeDir,
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: runtimeDir,
      TMPDIR: runtimeDir,
      NO_COLOR: '1',
      AGENT_RELAY_TELEMETRY_DISABLED: '1',
      AGENT_RELAY_WORKFLOW_DISABLE_RELAYCAST: '1',
      RELAY_CLOUD_PROVISIONING_DONE: '1',
    },
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const output = `${observed.stdout ?? ''}\n${observed.stderr ?? ''}`;
  const baseObserved =
    observed.status !== 0 && /unknown command(?:\s+|:\s*)['"]?__bundled-workflow\b/i.test(output);
  const headObserved =
    observed.status === 0 && output.includes('Dry Run: proof') && output.includes('Validation: PASS');

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'bug';
    signature = 'standalone_cloud_archive_lacks_bundled_workflow_runtime';
    details =
      'The exact-base compiled standalone rejected the internal bundled-workflow entrypoint from a dependency-free Cloud archive.';
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'standalone_cloud_archive_runs_bundled_workflow_runtime';
    details =
      'The exact-head compiled standalone loaded the bundled RelayFlow runtime from a dependency-free Cloud archive and validated its workflow plan.';
  } else {
    throw new Error(
      `Unexpected standalone Cloud runtime observation: ${JSON.stringify({
        arm,
        status: observed.status,
        signal: observed.signal,
        errorCode: observed.error?.code ?? null,
        outputTail: output.slice(-2_000),
      })}.`
    );
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
} finally {
  await rm(probeDir, { recursive: true, force: true });
}

function run(command, args, cwd, label) {
  try {
    execFileSync(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = Buffer.isBuffer(error?.stderr)
      ? error.stderr.toString('utf8')
      : String(error?.stderr ?? '');
    const stdout = Buffer.isBuffer(error?.stdout)
      ? error.stdout.toString('utf8')
      : String(error?.stdout ?? '');
    throw new Error(`${label} failed: ${`${stdout}\n${stderr}`.slice(-4_000)}`);
  }
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
