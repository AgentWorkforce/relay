import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const identityProof = process.argv.includes('--persisted-identity');
const CASE_ID = identityProof ? '1736-persisted-broker-identity' : '1736-scoped-orphan-cleanup';
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
let identityPath;

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

  // Seed through the actual target implementation when it supports persisted
  // ownership. The old base has no record support and uses process discovery.
  const identityModule = path.join(targetDir, 'packages/cli/dist/cli/lib/broker-process-identity.js');
  if (fs.existsSync(identityModule)) {
    const { persistBrokerIdentity, brokerIdentityPath, readBrokerProcessIdentity } = await import(
      pathToFileURL(identityModule).href
    );
    const paths = { projectRoot: targetDir, dataDir: candidateState };
    await persistBrokerIdentity(paths, children[0].pid, 'fixture', {
      fs,
      pid: process.pid,
      execCommand: fixedIdentityCommand,
    });
    identityPath = brokerIdentityPath(paths, undefined, 'fixture');
    if (!fs.existsSync(identityPath))
      throw new Error(
        `The live fixture did not produce a verified broker identity: ${JSON.stringify({ process: await readBrokerProcessIdentity(children[0].pid, { fs, pid: process.pid, execCommand: fixedIdentityCommand }), descriptors: fixedIdentityCommand(`lsof -nP -a -p ${children[0].pid} -FfnDi`).stdout })}`
      );
  }
  if (identityProof) {
    // Simulate a second broker launch reusing the runtime lock. Even the same
    // PID/start-second/executable must no longer match the persisted instance.
    await new Promise((resolve) => setTimeout(resolve, 30));
    fs.closeSync(fs.openSync(path.join(candidateState, 'broker-fixture.lock'), 'w'));
  }

  const cliPath = path.join(targetDir, 'packages/cli/dist/cli/index.js');
  const down = await runCli(
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
  const expectedExit = identityProof && arm === 'head' ? 1 : 0;
  if (down.status !== expectedExit) {
    throw new Error(`node down failed with ${down.status}: ${down.stderr}`);
  }

  await waitForExit(children[0]);
  const selectedStopped = !isAlive(children[0]);
  const survivors = children.slice(1).filter(isAlive);
  const nonSelectedStopped = children.slice(1).some((child) => !isAlive(child));
  const headObserved =
    (identityProof ? !selectedStopped : selectedStopped) && survivors.length === children.length - 1;
  const baseObserved = identityProof ? selectedStopped : selectedStopped && nonSelectedStopped;
  const outcome = arm === 'base' ? (baseObserved ? 'bug' : null) : headObserved ? 'fixed' : null;
  const signature = identityProof
    ? arm === 'base'
      ? 'unverified_orphan_is_killed'
      : 'unverified_orphan_is_preserved'
    : arm === 'base'
      ? 'isolated_cleanup_kills_peer_or_worker'
      : 'isolated_cleanup_preserves_peer_and_worker';
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
      details: identityProof
        ? 'The runtime lock was reopened after identity capture; cleanup must preserve that unverified process and every peer.'
        : arm === 'base'
          ? 'The base cleanup matched project-root paths rather than the selected state directory and signalled an unrelated peer, default broker, PTY worker, shell mention, or ambiguous process.'
          : 'The head cleanup stopped only the broker declaring the selected state directory and preserved the peer broker, default broker, PTY worker, shell mention, and ambiguous process.',
    })}\n`,
    'utf8'
  );
} finally {
  for (const child of children) stopFixture(child);
  if (identityPath) await rm(identityPath, { force: true });
  await rm(fixtureRoot, { recursive: true, force: true });
}

function fixedIdentityCommand(command) {
  const ps = /^LC_ALL=C TZ=UTC ps -p ([1-9]\d*) -o lstart=$/.exec(command);
  if (ps)
    return {
      stdout: execFileSync('ps', ['-p', ps[1], '-o', 'lstart='], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      }),
      stderr: '',
    };
  const lsof = /^lsof -nP -a -p ([1-9]\d*) (?:-d txt -FDi|-FfnDi)$/.exec(command);
  if (!lsof) throw new Error('Unexpected process identity command');
  const fields = command.endsWith('-FDi') ? ['-d', 'txt', '-FDi'] : ['-FfnDi'];
  return {
    stdout: execFileSync('lsof', ['-nP', '-a', '-p', lsof[1], ...fields], { encoding: 'utf8' }),
    stderr: '',
  };
}

function runCli(command, args, options) {
  // Keep the event loop free to reap fixture children when cleanup signals
  // them. A synchronous CLI invocation leaves zombies visible to kill(pid, 0)
  // and cannot prove the matched broker actually exited.
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
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
      // Positional arguments make the CLI command visible to ps without
      // executing paths supplied by the fixture environment.
      'sleep 600; :',
      'fixture-shell',
      path.join(targetDir, 'bin', 'agent-relay'),
      'up',
      '--state-dir',
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
    if (
      children.every((child) => isAlive(child) && listing.includes(childCommandMarker(child))) &&
      fs.existsSync(path.join(candidateState, 'broker-fixture.lock')) &&
      fs.existsSync(path.join(peerState, 'broker-fixture.lock'))
    )
      return;
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
