import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const CASE_ID = '1613-matching-fleet-enrollment-identity';
const arm = process.env.RELAY_PR_PROOF_ARM;
const targetDir = process.env.RELAY_PR_PROOF_TARGET_DIR;
const resultPath = process.env.RELAY_PR_PROOF_RESULT_PATH;
const childEnv = { ...process.env };
delete childEnv.CODEX_MANAGED_BY_NPM;

assert.ok(arm === 'base' || arm === 'head', 'RELAY_PR_PROOF_ARM must be base or head');
assert.ok(targetDir, 'RELAY_PR_PROOF_TARGET_DIR is required');
assert.ok(resultPath, 'RELAY_PR_PROOF_RESULT_PATH is required');

const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
assert.ok(expectedSha, `missing expected ${arm} SHA`);
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
assert.equal(targetSha, expectedSha, `target checkout does not match exact ${arm} SHA`);

async function run(command, args, env = childEnv) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: targetDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const append = (chunk) => {
      output = `${output}${chunk}`.slice(-16_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed (${code ?? signal}):\n${output}`));
    });
  });
}

await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--include=optional'], {
  ...childEnv,
  NODE_OPTIONS: '--max-old-space-size=256',
});
await run('npm', ['run', 'build:core']);

const scratch = await mkdtemp(path.join(tmpdir(), `relayflow-${CASE_ID}-`));
const projectRoot = path.join(scratch, 'project');
const projectDataDir = path.join(projectRoot, '.agentworkforce', 'relay');
const relayHome = path.join(scratch, 'relay-home');
await mkdir(projectDataDir, { recursive: true });
await mkdir(relayHome, { recursive: true });

const workspaceKey = 'rk_live_relayflow_matching_enrollment';
const workspaceId = '50587328-441d-4acb-b8f3-dbe1b3c5de99';
const nodeId = 'node_relayflow_matching_enrollment';
const nodeToken = 'nt_relayflow_matching_enrollment';
const relaycastUrl = 'https://agentrelay.com';
const proofEnv = {
  AGENT_RELAY_HOME: relayHome,
  AGENT_RELAY_TELEMETRY_DISABLED: '1',
};

try {
  const targetRequire = createRequire(path.join(targetDir, 'package.json'));
  const commanderPath = targetRequire.resolve('commander');
  const { Command } = await import(pathToFileURL(commanderPath).href);
  const cloud = await import(pathToFileURL(path.join(targetDir, 'packages/cloud/dist/index.js')).href);
  const { withDefaults } = await import(
    pathToFileURL(path.join(targetDir, 'packages/cli/dist/cli/commands/core.js')).href
  );
  const { registerNodeCommands } = await import(
    pathToFileURL(path.join(targetDir, 'packages/cli/dist/cli/commands/node.js')).href
  );

  cloud.upsertFleetNodeEnrollment(
    {
      nodeId,
      nodeName: 'relayflow-matching-node',
      nodeToken,
      relayWorkspaceId: workspaceId,
      relaycastUrl,
      websocketUrl: `${relaycastUrl}/v1/node/ws`,
      enrolledAt: '2026-08-25T00:00:00.000Z',
    },
    proofEnv
  );
  cloud.writeProjectWorkspaceKey(projectDataDir, workspaceKey, {
    workspaceId,
    enrolledNodeId: nodeId,
  });

  let brokerEnv;
  const relay = {
    workspaceKey,
    workspaceId,
    apiPort: 43161,
    brokerPid: process.pid,
    spawn: async () => undefined,
    getStatus: async () => ({ status: 'running' }),
    shutdown: async () => undefined,
  };
  const core = withDefaults({
    env: proofEnv,
    getProjectPaths: () => ({ projectRoot, dataDir: projectDataDir }),
    loadTeamsConfig: () => null,
    execCommand: async () => ({ stdout: '', stderr: '' }),
    createRelay: async () => {
      brokerEnv = { ...proofEnv };
      return relay;
    },
    onSignal: () => undefined,
    holdOpen: async () => undefined,
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  });
  const program = new Command();
  program.exitOverride();
  registerNodeCommands(program, { core });
  await program.parseAsync(['node', 'up', '--workspace-key', workspaceKey], { from: 'user' });

  assert.ok(brokerEnv, 'production node up command did not reach broker creation');
  const identityPreserved =
    brokerEnv.RELAY_NODE_ID === nodeId &&
    brokerEnv.RELAY_NODE_TOKEN === nodeToken &&
    brokerEnv.AGENT_RELAY_ENROLLED_NODE_ID === nodeId;
  if (arm === 'base') {
    assert.equal(identityPreserved, false, 'base unexpectedly preserved the matching Fleet enrollment');
    assert.equal(brokerEnv.RELAY_NODE_ID, undefined);
    assert.equal(brokerEnv.RELAY_NODE_TOKEN, undefined);
    assert.equal(brokerEnv.AGENT_RELAY_ENROLLED_NODE_ID, undefined);
    await writeFile(
      resultPath,
      `${JSON.stringify({
        version: 1,
        caseId: CASE_ID,
        arm,
        outcome: 'bug',
        signature: 'matching_workspace_enrollment_identity_dropped',
        details:
          'The public node up command reached broker creation without the persisted Fleet node credentials even though the explicit workspace key matched the pinned workspace.',
      })}\n`
    );
  } else {
    assert.equal(identityPreserved, true, 'head did not preserve the matching Fleet enrollment');
    await writeFile(
      resultPath,
      `${JSON.stringify({
        version: 1,
        caseId: CASE_ID,
        arm,
        outcome: 'fixed',
        signature: 'matching_workspace_enrollment_identity_preserved',
        details:
          'The public node up command passed the persisted Fleet node credentials to broker creation when the explicit workspace key matched the pinned workspace.',
      })}\n`
    );
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
