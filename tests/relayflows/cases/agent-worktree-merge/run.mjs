/**
 * RelayFlow proof: per-agent git worktrees.
 *
 * Drives the target checkout's built public CLI against a throwaway git repo.
 * A stand-in broker (an HTTP server answering /api/spawn and release, found
 * through the project's connection.json exactly like a real one) records what
 * the CLI asks it to spawn, so the real `spawn --worktree` wiring is exercised
 * without starting a broker, a harness or a model.
 *
 *   base — `node agent spawn` has no `--worktree`; `diff` / `merge` do not exist.
 *   head — `spawn --worktree` sends each agent's own checkout as its cwd; two
 *          agents edit the same line there, and:
 *            - the main checkout stays untouched and `git status` stays clean;
 *            - `diff` shows committed, uncommitted and new-file agent work;
 *            - `merge` of the first agent succeeds;
 *            - `merge` of the second stops on a real conflict, and re-running
 *              it resumes that paused merge instead of refusing;
 *            - `release` removes a merged checkout and keeps unmerged work.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = 'agent-worktree-merge';
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const GIT_TIMEOUT_MS = 60 * 1000;
const BROKER_API_KEY = 'relayflow-proof-broker-key';
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
  timeout: GIT_TIMEOUT_MS,
}).trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
}

const runnerPath = fileURLToPath(import.meta.url);
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

const cliEntry = path.join(targetDir, 'packages/cli/dist/cli/index.js');
// Resolve symlinks (macOS /var -> /private/var) so paths match what git reports.
const repoParent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'relayflow-agent-worktree-')));
const repo = path.join(repoParent, 'project');
/** Every /api/spawn body the stand-in broker received, in order. */
const spawnRequests = [];
let broker;

try {
  if (!existsSync(path.join(targetDir, 'node_modules', '.bin'))) {
    run('npm', ['ci', '--no-audit', '--no-fund'], targetDir, 'workspace dependency installation');
  }
  for (const step of [
    'build:session',
    'build:config',
    'build:cloud',
    'build:utils',
    'build:policy',
    'build:sdk',
    'build:harness-driver',
    'build:harnesses',
    'build:integration-prompts',
    'build:evals',
    'build:fleet',
    'build:cli-surface',
    'build:cli',
  ]) {
    run('npm', ['run', step], targetDir, `${step} build`);
  }

  await mkdir(repo, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'RelayFlow Proof']);
  git(['config', 'user.email', 'relayflow-proof@example.invalid']);
  await writeFile(path.join(repo, 'index.html'), '<h1>My Tasks</h1>\n<p>Things to do.</p>\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'initial']);
  broker = await startStandInBroker();

  const spawnAlpha = await cli(['node', 'agent', 'spawn', 'claude', '--name', 'alpha', '--worktree']);
  if (/unknown option '--worktree'/i.test(spawnAlpha.output)) {
    const diffProbe = await cli(['node', 'agent', 'diff', 'alpha']);
    check(/unknown command/i.test(diffProbe.output), 'base has no diff command either');
    check(spawnRequests.length === 0, 'base never reached the broker with a worktree spawn');
    await writeResult(
      'absent',
      'agent_worktree_commands_missing',
      'The built CLI rejects `node agent spawn --worktree` and has no `node agent diff` or `merge`, so agent work cannot be isolated, reviewed or merged per agent.'
    );
  } else {
    check(spawnAlpha.status === 0, `spawn --worktree succeeds (${spawnAlpha.output})`);
    const spawnBeta = await cli(['node', 'agent', 'spawn', 'claude', '--name', 'beta', '--worktree']);
    check(spawnBeta.status === 0, `second spawn --worktree succeeds (${spawnBeta.output})`);

    const checkoutOf = (name) => path.join(repo, '.agentworkforce', 'relay', 'worktrees', name);
    const sentCwd = Object.fromEntries(spawnRequests.map((body) => [body.name, body.cwd]));
    check(
      sentCwd.alpha === checkoutOf('alpha') && sentCwd.beta === checkoutOf('beta'),
      `the broker was asked to start each agent in its own checkout (${JSON.stringify(sentCwd)})`
    );
    check(
      git(['branch', '--show-current'], checkoutOf('alpha')).trim() === 'relay/alpha',
      'agent checkouts are on relay/<name>'
    );

    // alpha commits its own edit; beta leaves an edit and a new file uncommitted.
    await writeFile(
      path.join(checkoutOf('alpha'), 'index.html'),
      '<h1>Alpha heading</h1>\n<p>Things to do.</p>\n'
    );
    git(['add', '-A'], checkoutOf('alpha'));
    git(['commit', '-q', '-m', 'alpha edit'], checkoutOf('alpha'));
    await writeFile(
      path.join(checkoutOf('beta'), 'index.html'),
      '<h1>Beta heading</h1>\n<p>Things to do.</p>\n'
    );
    await writeFile(path.join(checkoutOf('beta'), 'beta-notes.txt'), 'new file from beta\n');

    const mainHtml = await readFile(path.join(repo, 'index.html'), 'utf8');
    check(mainHtml.startsWith('<h1>My Tasks</h1>'), 'main checkout is untouched while agents work');
    check(
      !git(['status', '--porcelain', '--untracked-files=all']).includes('worktrees/'),
      'agent checkouts do not show up in git status'
    );

    const diff = await cli(['node', 'agent', 'diff', 'beta', '--stat']);
    check(diff.status === 0, `diff exits 0 (${diff.output})`);
    check(
      diff.output.includes('index.html') && diff.output.includes('beta-notes.txt'),
      'diff shows uncommitted edits and new files'
    );

    const mergeAlpha = await cli(['node', 'agent', 'merge', 'alpha']);
    check(
      mergeAlpha.status === 0 && mergeAlpha.output.includes('Merged relay/alpha'),
      'alpha merges cleanly'
    );
    check(
      (await readFile(path.join(repo, 'index.html'), 'utf8')).startsWith('<h1>Alpha heading</h1>'),
      'alpha work is in the main checkout'
    );

    const mergeBeta = await cli(['node', 'agent', 'merge', 'beta']);
    check(mergeBeta.status === 1, `beta merge reports the conflict with exit 1 (${mergeBeta.output})`);
    check(
      mergeBeta.output.includes('Conflict') && mergeBeta.output.includes('index.html'),
      'conflict names the clashing file'
    );
    check(gitStatus(['rev-parse', '-q', '--verify', 'MERGE_HEAD']) === 0, 'merge is paused, not lost');
    check(
      git(['log', '-1', '--format=%an', 'relay/beta']).trim() === 'beta (relay agent)',
      "beta's uncommitted work was committed as the agent"
    );

    const resumed = await cli(['node', 'agent', 'merge', 'beta']);
    check(
      resumed.status === 1 && resumed.output.includes('paused mid-merge'),
      're-running merge resumes the paused merge instead of refusing'
    );
    git(['merge', '--abort']);

    const releaseAlpha = await cli(['node', 'agent', 'release', 'alpha']);
    check(
      releaseAlpha.status === 0 && !existsSync(checkoutOf('alpha')),
      `release removes a merged checkout (${releaseAlpha.output})`
    );
    const releaseBeta = await cli(['node', 'agent', 'release', 'beta']);
    check(
      releaseBeta.output.includes('Kept the worktree for beta') && existsSync(checkoutOf('beta')),
      `release keeps unmerged work (${releaseBeta.output})`
    );

    await writeResult(
      'fixed',
      'agent_worktrees_isolate_diff_and_merge_with_conflicts',
      'spawn --worktree started each agent in its own checkout without touching the main one; diff showed committed, uncommitted and new-file work; the first merge succeeded, the same-line clash stopped as a resumable git conflict, and release removed merged work while keeping unmerged work.'
    );
  }
} finally {
  await new Promise((resolve) => (broker ? broker.close(resolve) : resolve()));
  await rm(repoParent, { recursive: true, force: true });
}

/**
 * Minimal broker stand-in: accepts spawns and releases with the right API key
 * and records spawn bodies. Everything else (event replay, etc.) is a 404,
 * which the client already treats as optional.
 */
async function startStandInBroker() {
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const reply = (status, body) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (request.headers['x-api-key'] !== BROKER_API_KEY) return reply(401, { error: 'unauthorized' });
      if (request.method === 'POST' && request.url === '/api/spawn') {
        const body = JSON.parse(raw || '{}');
        spawnRequests.push(body);
        return reply(200, { success: true, name: body.name, runtime: 'pty', pid: process.pid });
      }
      const release = request.url?.match(/^\/api\/spawned\/([^/?]+)/);
      if (request.method === 'DELETE' && release) {
        return reply(200, { name: decodeURIComponent(release[1]) });
      }
      return reply(404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const stateDir = path.join(repo, '.agentworkforce', 'relay');
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, 'connection.json'),
    JSON.stringify({ url: `http://127.0.0.1:${port}`, port, api_key: BROKER_API_KEY, pid: process.pid })
  );
  return server;
}

/** Run the public CLI asynchronously so the in-process stand-in broker can answer it. */
function cli(args) {
  return new Promise((resolve, reject) => {
    // Only the project's connection.json may point the CLI at a broker.
    const env = { ...process.env, AGENT_RELAY_TELEMETRY_DISABLED: '1', NO_COLOR: '1', LC_ALL: 'C' };
    for (const key of ['AGENT_RELAY_STATE_DIR', 'RELAY_BROKER_URL', 'RELAY_BROKER_API_KEY']) delete env[key];
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: repo,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), COMMAND_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`CLI could not start: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? 1, output });
    });
  });
}

function git(args, cwd = repo) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, LC_ALL: 'C' },
  });
}

function gitStatus(args) {
  return spawnSync('git', args, { cwd: repo, timeout: GIT_TIMEOUT_MS }).status;
}

function check(condition, description) {
  if (!condition) throw new Error(`Proof expectation failed: ${description}.`);
}

async function writeResult(outcome, signature, details) {
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

function run(command, args, cwd, label) {
  const completed = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (completed.error) throw new Error(`${label} could not start: ${completed.error.message}`);
  if (completed.status !== 0) {
    throw new Error(
      `${label} failed with ${
        completed.signal ? `signal ${completed.signal}` : `exit code ${completed.status ?? 'unknown'}`
      }.`
    );
  }
}
