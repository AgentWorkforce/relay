import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1736-scoped-orphan-cleanup';
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

const fixtureRoot = path.join(targetDir, '.relayflow-1736-scoped-orphan-cleanup');
const helperPath = path.join(fixtureRoot, 'agent-relay-broker');
const candidateState = path.join(fixtureRoot, 'candidate  state');
const peerState = path.join(fixtureRoot, 'peer-state');
const projectName = path.basename(targetDir);
const children = [];

try {
  run('npm', ['ci', '--ignore-scripts'], targetDir, 'workspace dependency installation');
  run('npm', ['run', 'build:session'], targetDir, 'session package build');
  run('npm', ['run', 'build:config'], targetDir, 'configuration package build');
  run('npm', ['run', 'build:cloud'], targetDir, 'Cloud package build');
  run('npm', ['run', 'build:utils'], targetDir, 'utilities package build');
  run('npm', ['run', 'build:policy'], targetDir, 'policy package build');
  run('npm', ['run', 'build:sdk'], targetDir, 'SDK package build');
  run('npm', ['run', 'build:harness-driver'], targetDir, 'harness driver package build');
  run('npm', ['run', 'build:harnesses'], targetDir, 'harnesses package build');
  run('npm', ['run', 'build:fleet'], targetDir, 'fleet package build');
  run('npm', ['run', 'build:cli'], targetDir, 'CLI package build');

  await mkdir(fixtureRoot, { recursive: true });
  await mkdir(candidateState, { recursive: true });
  await mkdir(peerState, { recursive: true });
  compileHelper();

  children.push(
    spawnFixture(['init', '--state-dir', candidateState, '--name', projectName, '--persist'], 'selected'),
    spawnFixture(['init', '--state-dir', peerState, '--name', projectName, '--persist'], 'peer'),
    spawnFixture(['init', '--name', projectName, '--persist'], 'default'),
    spawnFixture(['pty', '--agent-name', 'chief', '--', 'claude'], 'pty'),
    spawnFixture(
      ['init', '--state-dir', candidateState, '--state-dir', peerState, '--name', projectName],
      'ambiguous'
    )
  );
  children.push(spawnShellMention());
  await waitForFixtureProcesses();

  const cliPath = path.join(targetDir, 'packages/cli/dist/cli/index.js');
  const down = spawnSync(
    process.execPath,
    [cliPath, 'node', 'down', '--force', '--state-dir', candidateState],
    {
      cwd: targetDir,
      env: {
        ...process.env,
        AGENT_RELAY_PROJECT: targetDir,
        AGENT_RELAY_TELEMETRY_DISABLED: '1',
        HOME: path.join(fixtureRoot, 'home'),
      },
      encoding: 'utf8',
      timeout: 30_000,
    }
  );
  if (down.error) throw new Error(`node down could not start: ${down.error.message}`);
  if (down.status !== 0) {
    throw new Error(`node down failed with ${down.status}: ${down.stderr}`);
  }

  await waitForExit(children[0]);
  const selectedStopped = !isAlive(children[0]);
  const survivors = children.slice(1).filter(isAlive);
  const nonSelectedStopped = children.slice(1).some((child) => !isAlive(child));
  const headObserved = selectedStopped && survivors.length === children.length - 1;
  const baseObserved = selectedStopped && nonSelectedStopped;
  const outcome = arm === 'base' ? (baseObserved ? 'bug' : null) : headObserved ? 'fixed' : null;
  const signature =
    arm === 'base' ? 'isolated_cleanup_kills_peer_or_worker' : 'isolated_cleanup_preserves_peer_and_worker';
  if (!outcome) {
    throw new Error(
      `Unexpected scoped cleanup observation: ${JSON.stringify({
        arm,
        selectedStopped,
        survivorLabels: survivors.map((child) => child.label),
        stdout: down.stdout,
        stderr: down.stderr,
      })}.`
    );
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({
      version: 1,
      caseId: CASE_ID,
      arm,
      outcome,
      signature,
      details:
        arm === 'base'
          ? 'The base cleanup matched project-root paths rather than the selected state directory and signalled an unrelated peer, default broker, PTY worker, shell mention, or ambiguous process.'
          : 'The head cleanup stopped only the broker declaring the selected state directory and preserved the peer broker, default broker, PTY worker, shell mention, and ambiguous process.',
    })}\n`,
    'utf8'
  );
} finally {
  for (const child of children) stopFixture(child);
  await rm(fixtureRoot, { recursive: true, force: true });
}

function compileHelper() {
  const source = `#include <unistd.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  int count = 0; const char *state = NULL;
  for (int i = 2; i + 1 < argc; i++) {
    if (!strcmp(argv[i], "--state-dir")) { count++; state = argv[i+1]; }
  }
  if (argc > 1 && !strcmp(argv[1], "init") && count == 1) {
    char filename[4096];
    snprintf(filename, sizeof(filename), "%s/broker-fixture.lock", state);
    if (open(filename, O_CREAT | O_RDWR, 0600) < 0) return 2;
  }
  for (;;) pause();
}\n`;
  const completed = spawnSync('cc', ['-O2', '-x', 'c', '-o', helperPath, '-'], {
    input: source,
    cwd: fixtureRoot,
    stdio: ['pipe', 'ignore', 'pipe'],
    encoding: 'utf8',
  });
  if (completed.error || completed.status !== 0) {
    throw new Error(`fixture helper compilation failed: ${completed.error?.message ?? completed.stderr}`);
  }
}

function spawnFixture(args, label) {
  const child = spawn(helperPath, args, {
    cwd: targetDir,
    detached: true,
    stdio: 'ignore',
  });
  child.label = label;
  return child;
}

function spawnShellMention() {
  const shell = spawn(
    '/bin/sh',
    [
      '-c',
      '"$1" up --state-dir "$2"; sleep 600',
      'fixture-shell',
      path.join(targetDir, 'bin', 'agent-relay'),
      candidateState,
    ],
    {
      cwd: targetDir,
      detached: true,
      stdio: 'ignore',
    }
  );
  shell.label = 'shell-mention';
  return shell;
}

async function waitForFixtureProcesses() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const listing = spawnSync('ps', ['aux'], { encoding: 'utf8' }).stdout ?? '';
    if (children.every((child) => isAlive(child) && listing.includes(childCommandMarker(child)))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('fixture processes did not all appear in ps aux');
}

function childCommandMarker(child) {
  return child.label === 'shell-mention' ? path.join(targetDir, 'bin', 'agent-relay') : helperPath;
}

async function waitForExit(child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && isAlive(child)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function isAlive(child) {
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopFixture(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {}
  }
}

function run(command, args, cwd, label) {
  const completed = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 15 * 60 * 1000,
  });
  if (completed.error) throw new Error(`${label} could not start: ${completed.error.message}`);
  if (completed.status !== 0) {
    throw new Error(
      `${label} failed with ${completed.signal ? `signal ${completed.signal}` : `exit code ${completed.status}`}`
    );
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
