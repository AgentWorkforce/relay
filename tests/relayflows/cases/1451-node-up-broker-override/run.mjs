import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const caseId = '1451-node-up-broker-override';
const arm = process.env.RELAY_PR_PROOF_ARM;
const targetDir = process.env.RELAY_PR_PROOF_TARGET_DIR;
const resultPath = process.env.RELAY_PR_PROOF_RESULT_PATH;
const caseDir = path.dirname(fileURLToPath(import.meta.url));
if (!['base', 'head'].includes(arm) || !targetDir || !resultPath) throw new Error('Missing proof inputs');
await rm(resultPath, { force: true });
const expectedSha = process.env[arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA'];
const sha = spawnSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
if (sha.status !== 0 || sha.stdout.trim() !== expectedSha) throw new Error('Unexpected target commit');
const vitestEntry = path.join(targetDir, 'node_modules', 'vitest', 'vitest.mjs');
try { await access(vitestEntry); } catch {
  const install = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: targetDir, encoding: 'utf8', timeout: 120_000,
  });
  if (install.status !== 0) throw new Error(`npm ci failed: ${install.stderr?.slice(-2000)}`);
}
const proofDir = path.join(targetDir, '.relay-pr-proof');
const probePath = path.join(proofDir, '1451-node-up-broker-override.test.mts');
const configPath = path.join(proofDir, '1451-node-up-broker-override.config.mts');
await mkdir(proofDir, { recursive: true });
await copyFile(path.join(caseDir, 'probe.test.mts'), probePath);
await writeFile(configPath,
  `import { defineConfig } from 'vitest/config';\nimport targetConfig from '../vitest.config.ts';\nexport default defineConfig({ resolve: targetConfig.resolve, test: { environment: 'node', include: ['.relay-pr-proof/1451-node-up-broker-override.test.mts'] } });\n`
);
let test;
try {
  test = spawnSync(process.execPath, [vitestEntry, 'run', '--config', configPath, '--reporter=verbose', '--no-color'], {
    cwd: targetDir, encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
  });
} finally {
  await rm(probePath, { force: true });
  await rm(configPath, { force: true });
}
if (test.error || test.signal) throw new Error(`Probe did not complete: ${test.error ?? test.signal}`);
const output = `${test.stdout ?? ''}\n${test.stderr ?? ''}`;
if (test.status !== 0) throw new Error(`Unexpected probe status ${test.status}: ${output.slice(-3500)}`);
const signature = output.includes('PROOF:rejects_cli_override')
  ? 'rejects_cli_override'
  : output.includes('PROOF:spawns_cli_override')
    ? 'spawns_cli_override'
    : null;
if (!signature) throw new Error(`Probe has no supported outcome: ${output.slice(-3500)}`);
const outcome = signature === 'rejects_cli_override' ? 'fixed' : 'bug';
await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(resultPath, `${JSON.stringify({ version: 1, caseId, arm, outcome, signature,
  details: 'Base forwards a legacy CLI executable as a broker; head routes through resolver and rejects the invalid override.' })}\n`);
