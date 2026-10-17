import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const caseId = '1963-standalone-update';
const arm = process.env.RELAY_PR_PROOF_ARM;
const targetDir = process.env.RELAY_PR_PROOF_TARGET_DIR;
const harnessDir = process.env.RELAY_PR_PROOF_HARNESS_DIR;
const resultPath = process.env.RELAY_PR_PROOF_RESULT_PATH;
if (!['base', 'head'].includes(arm) || !targetDir || !harnessDir || !resultPath) {
  throw new Error('Missing RelayFlow proof environment.');
}

const expectedSha = process.env[arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA'];
const actualSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!expectedSha || actualSha !== expectedSha) throw new Error('Target SHA mismatch.');
const runnerPath = fileURLToPath(import.meta.url);
if (path.relative(harnessDir, runnerPath).startsWith('..'))
  throw new Error('Runner is outside the head checkout.');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: targetDir,
    encoding: 'utf8',
    timeout: 8 * 60_000,
    env: { ...process.env, AGENT_RELAY_TELEMETRY_DISABLED: '1' },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr}`);
  }
}

if (!existsSync(path.join(targetDir, 'node_modules', 'vitest'))) run('npm', ['ci', '--ignore-scripts']);
const modulePath = path.join(targetDir, 'packages', 'cli', 'dist', 'cli', 'lib', 'core-maintenance.js');
if (!existsSync(modulePath)) run('npm', ['run', 'build:core']);
const { runUpdateCommand } = await import(pathToFileURL(modulePath).href);

const installDir = path.join(targetDir, '.tmp', 'proof-1963-standalone');
let command = '';
const makeDeps = (fail) => ({
  getVersion: () => '1.0.0',
  checkForUpdates: async () => ({ updateAvailable: true, latestVersion: '2.0.0' }),
  log: () => {},
  error: () => {},
  env: { AGENT_RELAY_INSTALL_DIR: installDir },
  execPath: path.join(installDir, 'bin', 'agent-relay'),
  fs: { realpathSync: (value) => value },
  execCommand: async (value) => {
    command = value;
    if (fail) throw new Error('simulated installer failure');
    return { stdout: '', stderr: '' };
  },
  exit: (code) => {
    throw Object.assign(new Error('CLI exit'), { code });
  },
});

await runUpdateCommand({}, makeDeps(false));
const selectedCommand = command;
command = '';
let failureExit;
try {
  await runUpdateCommand({}, makeDeps(true));
} catch (error) {
  failureExit = error.code;
}
if (command !== selectedCommand || failureExit !== 1) {
  throw new Error('Update did not preserve the chosen installer or exit 1 on failure.');
}

const standalone =
  selectedCommand.includes('AGENT_RELAY_INSTALL_STANDALONE_ONLY=1') &&
  selectedCommand.includes("AGENT_RELAY_VERSION='2.0.0'") &&
  selectedCommand.includes('install.sh') &&
  !selectedCommand.includes('npm install');
const npm = selectedCommand === 'npm install -g agent-relay@latest';
if (!standalone && !npm) throw new Error(`Unrecognized update command: ${selectedCommand}`);
const outcome = standalone ? 'fixed' : 'bug';
const signature = standalone ? 'standalone_update_uses_verified_installer' : 'standalone_update_runs_npm';
writeFileSync(
  resultPath,
  JSON.stringify({
    version: 1,
    caseId,
    arm,
    outcome,
    signature,
    details: `Running from a standalone binary selected ${standalone ? 'the pinned verified installer' : 'npm'}; an installer failure exited 1.`,
  }) + '\n'
);
