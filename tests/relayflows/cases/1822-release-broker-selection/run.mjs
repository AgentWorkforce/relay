import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const caseId = '1822-release-broker-selection';
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
const probePath = path.join(proofDir, '1822-release-broker-selection.test.mts');
const configPath = path.join(proofDir, '1822-release-broker-selection.config.mts');
await mkdir(proofDir, { recursive: true });
await copyFile(path.join(caseDir, 'probe.test.mts'), probePath);
await writeFile(configPath,
  `import { defineConfig } from 'vitest/config';\nimport targetConfig from '../vitest.config.ts';\nexport default defineConfig({ resolve: targetConfig.resolve, test: { environment: 'node', include: ['.relay-pr-proof/1822-release-broker-selection.test.mts'] } });\n`
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
let outcome, signature;
if (test.status !== 0 && output.includes("unknown option '--state-dir'") && output.includes("unknown option '--broker-url'")) {
  outcome = 'bug'; signature = 'release_cannot_select_broker';
} else if (test.status === 0 && output.includes('2 passed')) {
  outcome = 'fixed'; signature = 'release_targets_selected_broker';
} else {
  throw new Error(`Unexpected release probe status ${test.status}: ${output.slice(-3500)}`);
}
await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(resultPath, `${JSON.stringify({ version: 1, caseId, arm, outcome, signature,
  details: 'Release from an unrelated directory is refused on base for both explicit broker selectors; head routes both selectors to the chosen broker and calls release.' })}\n`);
