import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const caseId = '1400-fleet-rollout-contract';
const arm = required('RELAY_PR_PROOF_ARM');
const targetDir = path.resolve(required('RELAY_PR_PROOF_TARGET_DIR'));
const harnessDir = path.resolve(required('RELAY_PR_PROOF_HARNESS_DIR'));
const resultPath = path.resolve(required('RELAY_PR_PROOF_RESULT_PATH'));
const expectedSha = required(arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA');

if (arm !== 'base' && arm !== 'head') throw new Error(`invalid proof arm: ${arm}`);
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (targetSha !== expectedSha) throw new Error(`target ${targetSha} does not match ${expectedSha}`);
if (!isWithin(harnessDir, fileURLToPath(import.meta.url))) {
  throw new Error('runner must execute from the exact PR-head harness checkout');
}

const readTarget = (relativePath) => readFile(path.join(targetDir, relativePath), 'utf8');
const [fleetSource, facadeSource, messagingSource, manifest] = await Promise.all([
  readTarget('packages/cli/src/cli/commands/fleet.ts'),
  readTarget('packages/sdk/src/facade.ts'),
  readTarget('packages/sdk/src/messaging/relaycast.ts'),
  readTarget('.agentworkforce/features/manifest.yaml'),
]);

let outcome;
let signature;
let details;
if (arm === 'base') {
  if (!fleetSource.includes('workspace.fleetNodes') || !facadeSource.includes('fleetNodes')) {
    throw new Error('base does not contain the obsolete Fleet rollout dependency');
  }
  outcome = 'bug';
  signature = 'obsolete_fleet_rollout_controls_advertised';
  details =
    'Base still advertises and delegates workspace.fleetNodes rollout controls that the Relaycast engine no longer serves.';
} else {
  const productionHasFleetNodes = /fleetNodes|FleetNodes/.test(`${facadeSource}\n${messagingSource}`);
  const manifestHasRetiredFeature = /fleet-(?:config|enable|disable|inherit)/.test(manifest);
  const hasMigrationShim =
    fleetSource.includes('FLEET_ROLLOUT_REMOVED_MESSAGE') &&
    fleetSource.includes('Fleet node delivery is always on') &&
    fleetSource.includes('.command(legacyCommand, { hidden: true })');
  if (productionHasFleetNodes || manifestHasRetiredFeature || !hasMigrationShim) {
    throw new Error(
      `head contract mismatch: ${JSON.stringify({ productionHasFleetNodes, manifestHasRetiredFeature, hasMigrationShim })}`
    );
  }
  outcome = 'fixed';
  signature = 'fleet_rollout_contract_removed_with_migration_shims';
  details =
    'Head removes workspace.fleetNodes from the SDK/Relaycast adapter and manifest while keeping credential-free hidden legacy diagnostics.';
}

await writeFile(resultPath, `${JSON.stringify({ version: 1, caseId, arm, outcome, signature, details })}\n`);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
