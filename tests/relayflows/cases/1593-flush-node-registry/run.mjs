/**
 * relay#1593 (row 10) — `node agent message flush` could not reach an agent on
 * another node, while `node agent list` and `node agent attach` both could.
 *
 * `flush`, `hold` and `auto` went straight to `runLocalBroker` and accepted no
 * `--node`, so they only ever consulted the LOCAL broker's worker registry.
 * `attach` has always taken `--node` and reaches remote agents through the
 * fleet-node proxy. The result was two disjoint name registries behind one CLI:
 * a name that `list` and `attach` resolved returned `agent_not_found` from
 * `flush`, and there was no way to wake a parked agent on another machine
 * without hand-driving its PTY.
 *
 * Observation: the CLI's own command surface, built from the target checkout.
 * On base the three delivery-mode commands reject `--node` outright ("unknown
 * option"), which is the operator-visible defect — no amount of correct
 * arguments can target another node. On head they accept it and route through
 * the same authenticated proxy `attach --node` uses.
 *
 * Deliberately NOT asserted here: a live cross-node flush against a real
 * Relaycast. The self-hostable `@relaycast/engine` has no
 * `/v1/nodes/{node}/terminal/sessions` route — terminal sessions are
 * cloud-only — so the transport this depends on cannot be stood up in the
 * proof sandbox without faking the very routing under test. The wire path is
 * covered by unit tests instead (`attach-fleet-node.test.ts`, "flush route"),
 * which are mutation-verified: disabling the route fails all three.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1593-flush-node-registry';
const targetDir = requiredValue('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredValue('RELAY_PR_PROOF_HARNESS_DIR');
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

function run(command, args, cwd, label) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (exit ${result.status}): ${(result.stderr || result.stdout || '').slice(-2_000)}`
    );
  }
  return result;
}

/** Ask the built CLI for a command's help and report whether it offers --node. */
function offersNodeOption(cliEntry, subcommand) {
  const result = spawnSync(process.execPath, [cliEntry, 'node', 'agent', 'message', subcommand, '--help'], {
    cwd: targetDir,
    encoding: 'utf8',
    // spawnSync is synchronous: an unbounded --help that stalls would block
    // until the case's whole 900s budget expired, surfacing as a timeout with
    // no indication of which probe hung.
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  // A spawn failure is NOT an observation. Without this, a timed-out or
  // un-spawnable `--help` yields empty output and reports `offered: false` —
  // which on the head arm looks exactly like the base defect and could report
  // `flush_cannot_target_a_remote_node` for a CLI that actually has the option.
  if (result.error) {
    throw new Error(
      `--help probe for '${subcommand}' failed to run: ${result.error.message}${
        result.signal ? ` (signal ${result.signal})` : ''
      }`
    );
  }
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { offered: /--node\s+<node>/.test(text), text };
}

/**
 * Run the command with `--node` and report whether the CLI parses it at all.
 * A base CLI exits non-zero with "unknown option '--node'" before it ever
 * contacts a broker; that parse rejection IS the defect, and it is observable
 * without any Relaycast at all.
 */
function acceptsNodeArgument(cliEntry, subcommand) {
  const result = spawnSync(
    process.execPath,
    [cliEntry, 'node', 'agent', 'message', subcommand, 'probe-agent', '--node', 'probe-node'],
    {
      cwd: targetDir,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, RELAY_SKIP_TELEMETRY: '1' },
    }
  );
  // Same reasoning as the help probe: a spawn failure here would report
  // `rejectedAsUnknown: false`, which on the base arm mimics the fixed
  // behaviour. Only a real, parsed CLI response may become an observation.
  // A `timeout` kill is expected on head (the command reaches a real proxy
  // attempt), so a killed process is tolerated — but an inability to spawn at
  // all is not.
  if (result.error && !result.signal) {
    throw new Error(`--node parse probe for '${subcommand}' failed to run: ${result.error.message}`);
  }
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { rejectedAsUnknown: /unknown option .*--node/i.test(text), text };
}

try {
  run('npm', ['ci', '--ignore-scripts'], targetDir, 'workspace dependency installation');
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

  const cliEntry = path.join(targetDir, 'packages/cli/dist/cli/index.js');
  const subcommands = ['flush', 'hold', 'auto'];
  const help = Object.fromEntries(subcommands.map((c) => [c, offersNodeOption(cliEntry, c)]));
  const parse = Object.fromEntries(subcommands.map((c) => [c, acceptsNodeArgument(cliEntry, c)]));

  const offeredCount = subcommands.filter((c) => help[c].offered).length;
  const rejectedCount = subcommands.filter((c) => parse[c].rejectedAsUnknown).length;
  const detail = `--node advertised by ${offeredCount}/3 commands; rejected as unknown by ${rejectedCount}/3`;

  let outcome;
  let signature;
  let details;
  if (offeredCount === 0 && rejectedCount === 3) {
    outcome = 'bug';
    signature = 'flush_cannot_target_a_remote_node';
    details =
      `The base CLI offers no --node on message flush/hold/auto and rejects it outright (${detail}). ` +
      'An agent that `node agent list` and `node agent attach --node` both resolve therefore cannot be ' +
      'flushed or woken from another machine at all.';
  } else if (offeredCount === 3 && rejectedCount === 0) {
    outcome = 'fixed';
    signature = 'flush_reaches_the_agents_own_node';
    details =
      `The head CLI advertises and parses --node on all three delivery-mode commands (${detail}), ` +
      'routing them through the same authenticated fleet-node proxy `attach --node` uses, so both ' +
      'surfaces resolve agent names against the same registry.';
  } else {
    throw new Error(`Inconsistent observation (${detail}). flush help: ${help.flush.text.slice(-400)}`);
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
  process.stdout.write(`${signature}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  throw error;
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
