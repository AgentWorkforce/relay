/**
 * RelayFlow proof: per-agent git worktrees.
 *
 * Drives the target checkout's built public CLI against a throwaway git repo:
 *
 *   base — `agent-relay node agent diff` / `merge` do not exist.
 *   head — two agents get their own checkouts (created by the same
 *          `createAgentWorktree` that `node agent spawn --worktree` calls),
 *          edit the same line, and:
 *            - the main checkout stays untouched and `git status` stays clean;
 *            - `diff` shows committed, uncommitted and new-file agent work;
 *            - `merge` of the first agent succeeds;
 *            - `merge` of the second stops on a real conflict, and re-running
 *              it resumes that paused merge instead of refusing.
 *
 * No broker, network or model is involved; agent edits are written directly.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CASE_ID = 'agent-worktree-merge';
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
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
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
}

const runnerPath = fileURLToPath(import.meta.url);
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

const cliEntry = path.join(targetDir, 'packages/cli/dist/cli/index.js');
const worktreeModule = path.join(targetDir, 'packages/cli/dist/cli/lib/agent-worktree.js');
const repoParent = await mkdtemp(path.join(os.tmpdir(), 'relayflow-agent-worktree-'));
const repo = path.join(repoParent, 'project');

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

  const probe = cli(['node', 'agent', 'diff', 'alpha']);
  if (/unknown command/i.test(probe.output)) {
    await writeResult(
      'absent',
      'agent_worktree_commands_missing',
      'The built CLI has no `node agent diff` (and no `merge`), so agent work cannot be isolated, reviewed or merged per agent.'
    );
  } else {
    const { createAgentWorktree } = await import(pathToFileURL(worktreeModule).href);
    const alpha = createAgentWorktree(repo, 'alpha');
    const beta = createAgentWorktree(repo, 'beta');
    check(alpha.branch === 'relay/alpha' && beta.branch === 'relay/beta', 'agent branches are relay/<name>');

    // alpha commits its own edit; beta leaves an edit and a new file uncommitted.
    await writeFile(path.join(alpha.path, 'index.html'), '<h1>Alpha heading</h1>\n<p>Things to do.</p>\n');
    git(['add', '-A'], alpha.path);
    git(['commit', '-q', '-m', 'alpha edit'], alpha.path);
    await writeFile(path.join(beta.path, 'index.html'), '<h1>Beta heading</h1>\n<p>Things to do.</p>\n');
    await writeFile(path.join(beta.path, 'beta-notes.txt'), 'new file from beta\n');

    const mainHtml = await readFile(path.join(repo, 'index.html'), 'utf8');
    check(mainHtml.startsWith('<h1>My Tasks</h1>'), 'main checkout is untouched while agents work');
    check(git(['status', '--porcelain']).trim() === '', 'agent checkouts do not show up in git status');

    const diff = cli(['node', 'agent', 'diff', 'beta', '--stat']);
    check(diff.status === 0, `diff exits 0 (${diff.output})`);
    check(
      diff.output.includes('index.html') && diff.output.includes('beta-notes.txt'),
      'diff shows uncommitted edits and new files'
    );

    const mergeAlpha = cli(['node', 'agent', 'merge', 'alpha']);
    check(
      mergeAlpha.status === 0 && mergeAlpha.output.includes('Merged relay/alpha'),
      'alpha merges cleanly'
    );
    check(
      (await readFile(path.join(repo, 'index.html'), 'utf8')).startsWith('<h1>Alpha heading</h1>'),
      'alpha work is in the main checkout'
    );

    const mergeBeta = cli(['node', 'agent', 'merge', 'beta']);
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

    const resumed = cli(['node', 'agent', 'merge', 'beta']);
    check(
      resumed.status === 1 && resumed.output.includes('paused mid-merge'),
      're-running merge resumes the paused merge instead of refusing'
    );
    git(['merge', '--abort']);

    await writeResult(
      'fixed',
      'agent_worktrees_isolate_diff_and_merge_with_conflicts',
      'Agents worked in separate checkouts without touching the main one; diff showed committed, uncommitted and new-file work; the first merge succeeded and the same-line clash stopped as a resumable git conflict.'
    );
  }
} finally {
  await rm(repoParent, { recursive: true, force: true });
}

function cli(args) {
  const completed = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, AGENT_RELAY_TELEMETRY_DISABLED: '1', NO_COLOR: '1' },
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (completed.error) throw new Error(`CLI could not start: ${completed.error.message}`);
  return { status: completed.status ?? 1, output: `${completed.stdout ?? ''}${completed.stderr ?? ''}` };
}

function git(args, cwd = repo) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function gitStatus(args) {
  return spawnSync('git', args, { cwd: repo }).status;
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
