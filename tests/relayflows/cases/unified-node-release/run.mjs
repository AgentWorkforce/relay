#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const CASE_ID = 'unified-node-release';
const arm = process.env.RELAY_PR_PROOF_ARM;
const targetDir = process.env.RELAY_PR_PROOF_TARGET_DIR;
const resultPath = process.env.RELAY_PR_PROOF_RESULT_PATH;
if (!['base', 'head'].includes(arm) || !targetDir || !resultPath) {
  throw new Error('RelayFlow proof environment is incomplete');
}
await rm(resultPath, { force: true });

const targetRoot = path.resolve(targetDir);
const targetRequire = createRequire(path.join(targetRoot, 'package.json'));
let jitiEntry;
try {
  jitiEntry = targetRequire.resolve('jiti');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  const installed = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: targetRoot,
    stdio: 'inherit',
    timeout: 10 * 60 * 1000,
  });
  if (installed.error) throw installed.error;
  if (installed.status !== 0) throw new Error(`Target dependency installation failed: ${installed.status}`);
  jitiEntry = targetRequire.resolve('jiti');
}

// Load the target's production implementation, with no mocks or head-only test code.
const { createJiti } = targetRequire(jitiEntry);
const jiti = createJiti(path.join(targetRoot, 'package.json'), { fsCache: false, moduleCache: false });
const implementation = path.join(targetRoot, 'packages/cli/src/cli/lib/relay-node.ts');
const { relayNodeAssetName, relayNodeAssetUrl } = await jiti.import(implementation);
const platforms = [
  ['linux', 'x64', 'linux-x64'],
  ['linux', 'arm64', 'linux-arm64'],
  ['darwin', 'x64', 'darwin-x64'],
  ['darwin', 'arm64', 'darwin-arm64'],
  ['win32', 'x64', 'windows-x64.exe'],
];
const observations = [];
for (const version of ['16.0.1', '16.1.0-next.6']) {
  for (const [platform, arch, suffix] of platforms) {
    const asset = relayNodeAssetName(version, { platform, arch, musl: false });
    assert.equal(asset, `agent-relay-node-${version}-${suffix}`);
    const url = relayNodeAssetUrl(version, asset);
    const releaseBase = 'https://github.com/AgentWorkforce/relay/releases/download';
    observations.push({
      version,
      asset,
      url,
      unified: url === `${releaseBase}/v${version}/${asset}`,
      legacy: url === `${releaseBase}/relay-node-v${version}/${asset}`,
    });
  }
}

// Classify observed behavior independently of the requested arm. Import errors,
// unexpected URLs, and mixed results fail the runner instead of proving a bug.
const fixed = observations.every((entry) => entry.unified);
const bug = observations.every((entry) => entry.legacy);
assert.ok(fixed || bug, `Unexpected node download behavior: ${JSON.stringify(observations)}`);
console.log(JSON.stringify({ implementation, observations }, null, 2));
const observation = {
  version: 1,
  caseId: CASE_ID,
  arm,
  outcome: fixed ? 'fixed' : 'bug',
  signature: fixed
    ? 'node_download_uses_matching_cli_release_tag'
    : 'node_download_uses_separate_release_tag',
  details: `${observations.length} production URL selections across five platforms and stable/prerelease versions ${fixed ? 'use matching v<CLI version> releases' : 'use separate relay-node-v<version> releases, missing the unified release assets'}. Example: ${observations[0].url}`,
};
await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(resultPath, `${JSON.stringify(observation, null, 2)}\n`);
