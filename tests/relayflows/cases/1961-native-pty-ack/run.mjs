import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const caseId = '1961-native-pty-ack';
const arm = process.env.RELAY_PR_PROOF_ARM;
const target = process.env.RELAY_PR_PROOF_TARGET_DIR;
const harness = process.env.RELAY_PR_PROOF_HARNESS_DIR;
const resultPath = process.env.RELAY_PR_PROOF_RESULT_PATH;
const broker = process.env.RELAY_PR_PROOF_BROKER_BINARY;
if (!['base', 'head'].includes(arm) || !target || !harness || !resultPath || !broker)
  throw new Error('Missing proof environment or exact-SHA broker artifact');
await rm(resultPath, { force: true });
const sha = execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (sha !== process.env[arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA'])
  throw new Error('Target SHA mismatch');
if (path.relative(harness, fileURLToPath(import.meta.url)).startsWith('..'))
  throw new Error('Runner is outside the harness checkout');

// The recipient consumes a submitted body and emits a native acknowledgement.
// It never echoes the body, emits activity, or repaints its initial prompt.
const recipient = String.raw`#!/usr/bin/env python3
import json, os, pathlib, tty
tty.setraw(0)
os.write(1, ('OpenAI Codex\r\n› ' if os.environ['PROOF_CLI']=='codex' else 'Claude Code v2.1.261\r\n❯ ').encode())
data=b''
while True:
 data+=os.read(0,65536)
 if data.endswith(b'\r'):
  directory=os.environ.get('RELAY_PTY_ACK_DIR')
  if directory:
   for pending in pathlib.Path(directory).glob('*.pending'):
    entry=json.loads(pending.read_text())
    if entry['messageId'].encode() in data:
     pending.with_name(pending.stem+'.'+entry['nonce']+'.read').write_text(entry['nonce'])
  data=b''
`;

/** Observe a terminal broker verdict from a recipient that never repaints. */
async function observe(cli) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-native-ack-proof-'));
  const executable = path.join(dir, cli);
  await writeFile(executable, recipient);
  await chmod(executable, 0o755);
  const child = spawn(broker, ['pty', '--agent-name', 'proof-recipient', executable], {
    cwd: dir,
    env: { ...process.env, PROOF_CLI: cli, AGENT_RELAY_TELEMETRY_DISABLED: '1', AGENT_RELAY_LOCAL_ONLY: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const lines = createInterface({ input: child.stdout });
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${cli} timed out: ${stderr}`)), 65_000);
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`${cli} broker exited ${code}: ${stderr}`)));
      lines.on('line', (line) => {
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          return;
        }
        if (frame.type === 'worker_ready') {
          if (!frame.payload.readiness_proven) {
            reject(new Error(`${cli} readiness was not proven`));
            return;
          }
          child.stdin.write(
            JSON.stringify({
              v: 2,
              type: 'deliver_relay',
              payload: {
                delivery_id: 'proof-delivery',
                event_id: 'proof-message',
                from: 'sender',
                target: 'proof-recipient',
                body: 'Read this message without echoing or repainting.',
                priority: 2,
                injection_mode: 'wait',
              },
            }) + '\n'
          );
        }
        if (frame.payload?.event_id !== 'proof-message') return;
        if (frame.type === 'delivery_failed')
          reject(new Error(`${cli} delivery failed: ${JSON.stringify(frame)}`));
        if (frame.type === 'delivery_verified') {
          if (frame.payload.evidence !== 'native_mcp_ack')
            reject(new Error('Screen evidence was treated as confirmed delivery'));
          else resolve('native');
        }
        if (frame.type === 'delivery_unconfirmed' && frame.payload.terminal === true) resolve('unconfirmed');
      });
      child.stdin.write(JSON.stringify({ v: 2, type: 'resize_pty', payload: { rows: 24, cols: 80 } }) + '\n');
      child.stdin.write(
        JSON.stringify({ v: 2, type: 'init_worker', payload: { agent: { name: 'proof-recipient' } } }) + '\n'
      );
    });
  } finally {
    clearTimeout(timer);
    lines.close();
    child.kill('SIGKILL');
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', resolve);
    });
    await rm(dir, { recursive: true, force: true });
  }
}

const observations = { claude: await observe('claude'), codex: await observe('codex') };
if (observations.claude !== observations.codex)
  throw new Error(`Harness outcomes differ: ${JSON.stringify(observations)}`);
const fixed = observations.claude === 'native';
await writeFile(
  resultPath,
  JSON.stringify({
    version: 1,
    caseId,
    arm,
    outcome: fixed ? 'fixed' : 'bug',
    signature: fixed ? 'native_ack_confirms_without_repaint' : 'native_ack_not_observed',
    details: JSON.stringify(observations),
  }) + '\n'
);
