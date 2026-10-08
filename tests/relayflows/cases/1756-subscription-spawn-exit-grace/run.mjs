/**
 * RelayFlow case 1756-subscription-spawn-exit-grace.
 *
 * On the subscription `--spawn` path the broker reports two exit events: a
 * PTY-close `agent_exit` carrying only `reason`, then the reaper's
 * code-bearing `agent_exited` (up to ~500ms later). `waitForReady` settles on
 * whichever arrives first, so the launch could report a detail-free exit.
 *
 * Base arm: the launch threw with `{"reason":"exited"}` — the reaped status
 * was dropped before the worker was even released.
 * Head arm: the launch holds a bounded grace on `owned.exit` while the worker
 * is still registered, so the reported failure keeps the authoritative
 * `{"reason":"exited","code":1,"signal":null}`.
 *
 * The broker boundary is mocked exactly at `connectProjectBrokerClient`: the
 * fake handle replays the real event ordering (detail-free readiness, then a
 * late code-bearing `exit`), and a module-resolution hook keeps every other
 * import — session checks, workspace-key resolution, the launch code itself —
 * genuine.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CASE_ID = '1756-subscription-spawn-exit-grace';
const arm = requiredValue('RELAY_PR_PROOF_ARM');
if (arm !== 'base' && arm !== 'head') {
  throw new Error(`RELAY_PR_PROOF_ARM must be base or head, received ${JSON.stringify(arm)}.`);
}
const targetDir = requiredValue('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredValue('RELAY_PR_PROOF_HARNESS_DIR');
const resultPath = requiredValue('RELAY_PR_PROOF_RESULT_PATH');

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

function run(command, args, cwd, label) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${result.status}`);
  }
  return result;
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function assertTrue(actual, label) {
  if (actual !== true) throw new Error(`${label}: expected true, received ${JSON.stringify(actual)}.`);
}
function assertContains(haystack, needle, label) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${label}: expected ${JSON.stringify(haystack)} to contain ${JSON.stringify(needle)}.`);
  }
}
function assertNotContains(haystack, needle, label) {
  if (String(haystack).includes(needle)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(haystack)} to not contain ${JSON.stringify(needle)}.`
    );
  }
}

const proofDir = path.join(targetDir, '.relay-pr-proof');
const fakeClientPath = path.join(proofDir, 'fake-broker-client.mjs');
const hooksPath = path.join(proofDir, 'hooks.mjs');

try {
  const nodeModulesEntry = path.join(targetDir, 'node_modules', '.bin');
  if (!(await pathExists(nodeModulesEntry))) {
    run('npm', ['ci', '--no-audit', '--no-fund'], targetDir, 'workspace dependency installation');
  }
  // Focused build: only what the launch surface needs, in dependency order,
  // matching the root `build:core` script.
  for (const step of [
    'build:session',
    'build:config',
    'build:cloud',
    'build:utils',
    'build:policy',
    'build:sdk',
    'build:harness-driver',
    'build:harnesses',
    'build:fleet',
    'build:cli',
  ]) {
    run('npm', ['run', step], targetDir, `${step} build`);
  }

  const recipientEntry = path.join(targetDir, 'packages/cli/dist/cli/commands/integration-recipient.js');
  if (!(await pathExists(recipientEntry))) {
    throw new Error(`Expected built package entry surface missing: ${recipientEntry}`);
  }

  // The fake broker handle replays the real race: `waitForReady` settles on
  // the detail-free PTY-close shape, then `exit` gains the reaped code 250ms
  // later — inside the 500ms reap tick, far inside any reasonable grace.
  await mkdir(proofDir, { recursive: true });
  await writeFile(
    fakeClientPath,
    `const stateKey = '__relay_pr_proof_1756__';
const state = (globalThis[stateKey] ??= { releases: [], waitForReadyCalls: 0 });
let enriched = false;
setTimeout(() => {
  enriched = true;
}, 250).unref();
const handle = {
  channels: [],
  get exit() {
    return enriched ? { reason: 'exited', code: 1, signal: null } : { reason: 'exited' };
  },
  async waitForReady() {
    state.waitForReadyCalls += 1;
    return { reason: 'exited', exit: { reason: 'exited' } };
  },
  async release(reason, options) {
    state.releases.push({ reason, options });
  },
};
export function connectProjectBrokerClient() {
  return {
    async getSession() {
      return {
        workspace_key: 'rk_live_case_workspace',
        spawn_capabilities: { explicit_empty_channels: true, create_only_identity: true },
      };
    },
    async listAgents() {
      return [];
    },
    async spawnCli() {
      return handle;
    },
    disconnect() {},
  };
}
export function getProjectBrokerConnectionPath() {
  return '/nonexistent/connection.json';
}
`,
    'utf8'
  );
  // Redirect only the broker-connection module; every other import the launch
  // pulls — config, sdk-client, harness-driver — resolves for real.
  await writeFile(
    hooksPath,
    `const FAKE = ${JSON.stringify(pathToFileURL(fakeClientPath).href)};
export async function resolve(specifier, context, next) {
  if (specifier.endsWith('project-broker-client.js')) {
    return { url: FAKE, shortCircuit: true };
  }
  return next(specifier, context);
}
`,
    'utf8'
  );

  register(pathToFileURL(hooksPath));
  const { launchSubscriptionRecipient } = await import(pathToFileURL(recipientEntry).href);

  const state = (globalThis.__relay_pr_proof_1756__ ??= { releases: [], waitForReadyCalls: 0 });
  const startedAt = Date.now();
  const failure = await launchSubscriptionRecipient({
    name: 'case-recipient',
    cli: 'claude',
    provider: 'github',
    resource: '/github/repos/o/r/pulls/1/**',
    options: { workspaceKey: 'rk_live_case_workspace' },
  }).catch((error) => error);
  const elapsedMs = Date.now() - startedAt;

  assertTrue(failure instanceof Error, 'recipient launch must reject on early exit');
  assertContains(failure.message, 'failed startup: exited', 'startup failure message');
  assertTrue(state.waitForReadyCalls === 1, 'waitForReady must be awaited exactly once');
  assertTrue(
    state.releases.length === 1 && state.releases[0].reason === 'subscription startup failed',
    'the owned worker must be released on startup failure'
  );

  if (arm === 'base') {
    // The throw fires on the detail-free PTY-close shape before the reaper's
    // code-bearing event can ever arrive: the reported exit has no status.
    assertContains(
      failure.message,
      '({"reason":"exited"})',
      'base: reported exit keeps only the PTY-close reason'
    );
    assertNotContains(failure.message, '"code"', 'base: no exit code survives into the error');
    assertTrue(elapsedMs < 200, 'base: no grace wait is held for the richer event');
    await writeResult({
      outcome: 'bug',
      signature: 'pty_close_exit_drops_reaped_status',
      details:
        'The base launch settled on the PTY-close `agent_exit` and threw ' +
        '`failed startup: exited ({"reason":"exited"})` — the reaper\'s ' +
        'code-bearing `agent_exited` was never awaited, so the reported exit ' +
        'carried no status an operator could act on.',
    });
  } else {
    // The head holds the bounded grace while the worker is still registered,
    // so the same event ordering reports the authoritative reaped status.
    assertContains(
      failure.message,
      '({"reason":"exited","code":1,"signal":null})',
      'head: reported exit keeps the reaped status'
    );
    assertTrue(
      elapsedMs >= 200 && elapsedMs < 3000,
      `head: grace held only until the richer event arrived (observed ${elapsedMs}ms)`
    );
    await writeResult({
      outcome: 'fixed',
      signature: 'reaped_exit_status_survives_pty_close',
      details:
        'The head launch held its bounded exit grace while the worker was ' +
        "still registered, caught the reaper's code-bearing `agent_exited`, " +
        'and threw `failed startup: exited ({"reason":"exited","code":1,' +
        '"signal":null})` — the reported startup failure retains the ' +
        'authoritative status instead of the detail-free PTY-close shape.',
    });
  }
} finally {
  // Nothing else to stop: the fake broker client owns no real processes.
}

async function writeResult({ outcome, signature, details }) {
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
}

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}
function isWithin(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
