import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const caseId = '1818-installer-broker-version';
const arm = process.env.RELAY_PR_PROOF_ARM;
const targetDir = process.env.RELAY_PR_PROOF_TARGET_DIR;
const resultPath = process.env.RELAY_PR_PROOF_RESULT_PATH;
if (!['base', 'head'].includes(arm) || !targetDir || !resultPath) {
  throw new Error('Missing RelayFlow proof inputs');
}
const expectedSha = process.env[arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA'];
const actualSha = spawnSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
if (actualSha.status !== 0 || actualSha.stdout.trim() !== expectedSha) {
  throw new Error('The target checkout is not at the expected commit');
}
const scratch = await mkdtemp(path.join(tmpdir(), 'relay-install-1818-'));
try {
  const installDir = path.join(scratch, 'install');
  const binDir = path.join(scratch, 'bin');
  await mkdir(path.join(installDir, 'bin'), { recursive: true });
  await mkdir(binDir);
  const brokerPath = path.join(installDir, 'bin', 'agent-relay-broker');
  const cliPath = path.join(binDir, 'agent-relay');
  const makeExecutable = async (file, value) => {
    await writeFile(file, `#!/bin/sh\nprintf '%s\\n' '${value}'\n`);
    await chmod(file, 0o755);
  };
  await makeExecutable(cliPath, 'agent-relay 12.4.1');
  // Simulate a successful CLI upgrade followed by a broker download failure.
  // The old executable still exists at the managed broker path.
  await makeExecutable(brokerPath, 'agent-relay-broker 12.3.1');
  const source = await readFile(path.join(targetDir, 'install.sh'), 'utf8');
  if (!source.trimEnd().endsWith('main "$@"')) throw new Error('Installer entrypoint changed');
  const library = path.join(scratch, 'install-functions.sh');
  await writeFile(library, source.replace(/main "\$@"\s*$/, ''));
  const probe = `source "$1"; VERSION=12.4.1; INSTALL_DIR="$2"; BIN_DIR="$3"; ORIGINAL_PATH="$PATH"; verify_installation`;
  const run = () => spawnSync('bash', ['-c', probe, 'probe', library, installDir, binDir], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, AGENT_RELAY_TELEMETRY_DISABLED: '1' },
  });
  const stale = run();
  if (stale.error || stale.signal) throw new Error(`Probe failed: ${stale.error ?? stale.signal}`);
  let outcome, signature;
  if (stale.status === 0 && stale.stdout.includes('installed successfully')) {
    outcome = 'bug'; signature = 'stale_broker_accepted';
  } else if (stale.status !== 0 && /Expected broker 12\.4\.1/.test(stale.stdout + stale.stderr)) {
    await makeExecutable(brokerPath, 'agent-relay-broker 12.4.1');
    const current = run();
    if (current.status !== 0 || !current.stdout.includes('installed successfully')) {
      throw new Error(`Current broker was rejected: ${current.stdout} ${current.stderr}`);
    }
    await makeExecutable(cliPath, 'agent-relay 12.3.1');
    const staleCli = run();
    if (staleCli.status === 0 || !/Expected CLI 12\.4\.1/.test(staleCli.stdout + staleCli.stderr)) {
      throw new Error(`Stale CLI was not rejected: ${staleCli.status} ${staleCli.stdout} ${staleCli.stderr}`);
    }
    outcome = 'fixed'; signature = 'stale_broker_rejected';
  } else {
    throw new Error(`Unexpected install verification: ${stale.status} ${stale.stdout} ${stale.stderr}`);
  }
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify({ version: 1, caseId, arm, outcome, signature,
    details: 'A stale managed broker survives a failed download; only the patched verifier rejects it. A matching broker passes.' })}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
