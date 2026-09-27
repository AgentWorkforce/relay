#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1614-mcp-bootstrap-registration-error';
const target = path.resolve(required('RELAY_PR_PROOF_TARGET_DIR'));
const harness = path.resolve(required('RELAY_PR_PROOF_HARNESS_DIR'));
const arm = required('RELAY_PR_PROOF_ARM');
if (!['base', 'head'].includes(arm)) throw new Error('Invalid arm');
const sha = execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (sha !== required(arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA')) {
  throw new Error('Target SHA differs from the expected exact SHA');
}
if (!fileURLToPath(import.meta.url).startsWith(`${harness}${path.sep}`)) {
  throw new Error('Runner must come from the head harness');
}
const source = await readFile(
  path.join(harness, 'packages/cli/src/cli/agent-relay-mcp.startup.test.ts'),
  'utf8'
);
// Import the common production-boundary test fixture from head into the target.
// The fixture mocks the remote registration endpoint, not the bootstrap code.
const end = source.indexOf('\nbeforeEach(() => {');
if (end < 0 || !source.slice(0, end).includes("const mod = await import('./agent-relay-mcp.js')")) {
  throw new Error('MCP startup fixture shape changed');
}
const probe = `import { writeFile } from 'node:fs/promises';\n${source.slice(0, end)}\n\nit('records actual MCP bootstrap failure behavior', async () => {
  const { mod, mocks } = await loadAgentRelayMcpModule();
  mocks.behavior.registerImpl = vi.fn(async () => {
    throw new Error('upstream secret header: Bearer rk_live_private');
  });
  let message = '';
  try {
    await mod.startAgentRelayMcpStdio({ apiKey: 'rk_live_private', agentName: 'WorkerA' });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  await writeFile(process.env.RELAY_PR1614_OBSERVATION_PATH!, JSON.stringify({ message, connections: mocks.serverInstances.length }));
});\n`;
const probePath = path.join(target, 'packages/cli/src/cli/.relayflow-1614-bootstrap.test.ts');
const configPath = path.join(target, '.relayflow-1614-vitest.config.mjs');
const observationPath = path.join(target, '.relayflow-1614-observation.json');
try {
  run(
    'npm',
    ['ci', '--ignore-scripts', '--workspace', 'packages/cli', '--include-workspace-root=false'],
    target
  );
  run('npm', ['run', 'build:core'], target);
  await writeFile(probePath, probe);
  await writeFile(
    configPath,
    "export default { test: { environment: 'node', include: ['packages/cli/src/cli/.relayflow-1614-bootstrap.test.ts'], setupFiles: [] } };\n"
  );
  run('npm', ['exec', '--', 'vitest', 'run', '--config', path.basename(configPath)], target, {
    RELAY_PR1614_OBSERVATION_PATH: observationPath,
  });
  const { message, connections } = JSON.parse(await readFile(observationPath, 'utf8'));
  if (typeof message !== 'string' || connections !== 0) throw new Error('Unexpected bootstrap observation');
  const baseObserved = message === 'upstream secret header: Bearer rk_live_private';
  const headObserved =
    message ===
    'Relaycast MCP bootstrap registration for "WorkerA" failed: Registration failed before the MCP server could connect.';
  if (!baseObserved && !headObserved) throw new Error(`Unexpected error: ${message}`);
  const outcome = baseObserved ? 'bug' : 'fixed';
  const signature = baseObserved
    ? 'mcp_bootstrap_registration_error_unattributed'
    : 'mcp_bootstrap_registration_error_attributed';
  await mkdir(path.dirname(required('RELAY_PR_PROOF_RESULT_PATH')), { recursive: true });
  await writeFile(
    required('RELAY_PR_PROOF_RESULT_PATH'),
    JSON.stringify({
      version: 1,
      caseId: CASE_ID,
      arm,
      outcome,
      signature,
      details: baseObserved
        ? 'An untyped registration failure escaped without the configured agent name or operation.'
        : 'MCP bootstrap attributed registration failure to the configured agent without exposing the upstream credential-bearing message.',
    }) + '\n'
  );
} finally {
  await Promise.all([probePath, configPath, observationPath].map((file) => rm(file, { force: true })));
}
function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    timeout: 360_000,
  });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${result.error?.message ?? result.status}`);
}
