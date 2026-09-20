/**
 * RelayFlow proof that the mounted product groups work in the standalone binary.
 *
 * The claim: `agent-relay file|flows|sessions` mount and reach their real
 * implementations when `agent-relay` is the compiled single-file binary, not
 * only when it is an npm install.
 *
 * Why this case needs a compiled binary rather than `dist/cli/index.js`: the
 * bug is a property of compilation. `scripts/build-standalone.sh` bundles with
 * esbuild and compiles with `bun`, and a bundled entry point cannot resolve the
 * product SDKs — the payloads are a Go binary and a dlopened addon, and all
 * three surfaces read files relative to `import.meta.url`. An unbundled entry
 * point has a node_modules beside it and shows nothing.
 *
 * Why it does not stop at `--help`: help renders from a JavaScript command
 * tree while the implementations are native. A help-only assertion passes while
 * every real command fails, which is exactly how an earlier attempt (#1796)
 * read as correct.
 *
 * The probe logic lives here rather than shelling out to
 * `scripts/standalone-mount-probe.sh`, because that script is added by the head
 * arm and does not exist on base.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const CASE_ID = '1795-standalone-mount';
const BUILD_TIMEOUT_MS = 20 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/** One real command per group, chosen to reach the implementation, not the help text. */
const GROUPS = [
  { name: 'file', real: ['integration', 'available'] },
  { name: 'flows', real: ['check', 'probe.flow.ts'] },
  { name: 'sessions', real: ['stats'] },
];

/** Payload absence, by name. A structured refusal naming user input is the surface working. */
const PAYLOAD_MISSING =
  /needs @?[a-z/-]+, which is not installed|could not be prepared|installed but incomplete|@relayfile\/cli-|ai-hist-native|command-spec\.json/;

const targetDir = required('RELAY_PR_PROOF_TARGET_DIR');
const resultPath = required('RELAY_PR_PROOF_RESULT_PATH');
const arm = required('RELAY_PR_PROOF_ARM');
if (arm !== 'base' && arm !== 'head') {
  throw new Error(`RELAY_PR_PROOF_ARM must be base or head, received ${JSON.stringify(arm)}.`);
}

const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
if (!expectedSha) throw new Error(`Missing expected ${arm} SHA.`);
const actualSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (actualSha !== expectedSha) {
  throw new Error(`${arm} arm is at ${actualSha}, expected ${expectedSha}.`);
}

await main();

async function main() {
  // Match the repository's cleanroom install. Running dependency lifecycle
  // scripts builds ssh2's optional native addon, which makes the CLI's legacy
  // CJS bundle try to ingest a `.node` file before this case ever reaches the
  // standalone mount behavior it is meant to prove.
  build(['ci', '--ignore-scripts'], 'npm ci --ignore-scripts');
  build(['run', 'build'], 'npm run build');
  runShell('bash', ['scripts/build-standalone.sh'], 'standalone build');

  const binary = path.join(targetDir, 'bin', 'agent-relay-standalone');
  // A sandbox under the system temp dir, so no ancestor node_modules can
  // satisfy an import and make a broken binary look mounted.
  const sandbox = mkdtempSync(path.join(os.tmpdir(), `${CASE_ID}-`));
  const home = path.join(sandbox, 'home');
  await mkdir(home, { recursive: true });
  await writeFile(path.join(sandbox, 'probe.flow.ts'), 'export default { }\n', 'utf8');

  const details = [];
  let broken = false;

  for (const group of GROUPS) {
    const help = invoke(binary, [group.name, '--help'], sandbox, home);
    if (help.status !== 0 || !help.stdout.includes(`Usage: agent-relay ${group.name}`)) {
      broken = true;
      details.push(`${group.name}: help did not render (exit ${help.status}) ${firstLine(help.combined)}`);
      continue;
    }
    const real = invoke(binary, [group.name, ...group.real], sandbox, home);
    if (PAYLOAD_MISSING.test(real.combined)) {
      broken = true;
      details.push(
        `${group.name}: help renders but the implementation is absent — ${firstLine(real.combined)}`
      );
      continue;
    }
    details.push(`${group.name}: mounted, and \`${group.real.join(' ')}\` reached the product`);
  }

  await rm(sandbox, { recursive: true, force: true });

  const outcome = broken ? 'bug' : 'fixed';
  const signature = broken ? 'standalone_groups_unmountable' : 'standalone_groups_mounted';
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
  for (const line of details) console.log(`  ${line}`);
  console.log(`${arm}: ${outcome} (${signature})`);
}

function invoke(binary, args, cwd, home) {
  const completed = spawnSync(binary, args, {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
  });
  const stdout = completed.stdout ?? '';
  const stderr = completed.stderr ?? '';
  return { status: completed.status, stdout, combined: `${stdout}\n${stderr}` };
}

function build(args, label) {
  runShell('npm', args, label);
}

function runShell(command, args, label) {
  const completed = spawnSync(command, args, {
    cwd: targetDir,
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: BUILD_TIMEOUT_MS,
  });
  if (completed.error) throw new Error(`${label} could not start: ${completed.error.message}`);
  if (completed.status !== 0) {
    throw new Error(`${label} failed with exit code ${completed.status ?? 'unknown'}.`);
  }
}

function firstLine(text) {
  return (text.trim().split('\n')[0] ?? '').slice(0, 160);
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}
