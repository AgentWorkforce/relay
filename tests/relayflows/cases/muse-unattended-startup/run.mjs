import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = 'muse-unattended-startup';
const WORKER_NAME = 'muse-unattended-proof';
const TASK_MARKER = 'MUSE_STARTUP_TASK_9f61c2';
const API_KEY = 'br_muse_unattended_proof';

const required = (name) => {
  const value = process.env[name];
  assert(value, `Missing ${name}`);
  return value;
};
const arm = required('RELAY_PR_PROOF_ARM');
assert(['base', 'head'].includes(arm));
const binary = path.resolve(required('RELAY_PR_PROOF_BROKER_BINARY'));
const targetDir = path.resolve(required('RELAY_PR_PROOF_TARGET_DIR'));
const harnessDir = path.resolve(required('RELAY_PR_PROOF_HARNESS_DIR'));
const resultPath = path.resolve(required('RELAY_PR_PROOF_RESULT_PATH'));
const expectedSha = required(arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA');
assert.equal(
  execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  expectedSha,
  `The supplied broker must belong to the exact ${arm} checkout`
);
const runnerPath = fileURLToPath(import.meta.url);
const relativeRunner = path.relative(harnessDir, runnerPath);
assert(relativeRunner && !relativeRunner.startsWith('..') && !path.isAbsolute(relativeRunner));
await access(binary, fsConstants.X_OK);

const directory = await mkdtemp(path.join(tmpdir(), 'relayflow-muse-startup-'));
const stateDir = path.join(directory, 'state');
const fakeMuse = path.join(directory, 'muse');
const promptMarker = path.join(directory, 'prompt.txt');
const yoloMarker = path.join(directory, 'yolo-count.txt');
const toolMarker = path.join(directory, 'tool.txt');
let broker;
let brokerLogs = '';

async function waitFor(probe, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (broker?.exitCode !== null && broker?.exitCode !== undefined) {
      throw new Error(`Broker exited before ${description}: ${brokerLogs}`);
    }
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}: ${brokerLogs}`);
}

async function readIfPresent(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function stopBroker() {
  if (!broker || broker.exitCode !== null || broker.signalCode !== null) return;
  const child = broker;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

try {
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    fakeMuse,
    `#!/bin/sh
set -eu
yolo_count=0
last_arg=''
for arg in "$@"; do
  if [ "$arg" = '--yolo' ]; then
    yolo_count=$((yolo_count + 1))
  fi
  last_arg=$arg
done
printf '%s' "$yolo_count" > "$MUSE_YOLO_MARKER"
printf '%s' "$last_arg" > "$MUSE_PROMPT_MARKER"
case "$last_arg" in
  *"$MUSE_TASK_MARKER"*) has_task=1 ;;
  *) has_task=0 ;;
esac
if [ "$yolo_count" -ne 1 ] || [ "$has_task" -ne 1 ]; then
  sleep 60
  exit 2
fi
/bin/pwd > "$MUSE_TOOL_MARKER"
printf '%s\n' '->pty:ready'
sleep 60
`
  );
  await access('/bin/chmod', fsConstants.X_OK);
  execFileSync('/bin/chmod', ['755', fakeMuse], { env: {} });

  // The allowlist deliberately excludes dynamic-loader and live Relay credentials.
  const env = {
    PATH: `${directory}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: directory,
    TMPDIR: directory,
    NO_COLOR: '1',
    RELAY_BROKER_API_KEY: API_KEY,
    AGENT_RELAY_BROKER_LOG: 'stderr',
    AGENT_RELAY_TELEMETRY_DISABLED: '1',
    RELAY_SKIP_TELEMETRY: '1',
    AGENT_RELAY_NO_DEBUG_FILES: '1',
    MUSE_PROMPT_MARKER: promptMarker,
    MUSE_YOLO_MARKER: yoloMarker,
    MUSE_TOOL_MARKER: toolMarker,
    MUSE_TASK_MARKER: TASK_MARKER,
  };
  broker = spawn(
    binary,
    [
      'init',
      '--local-only',
      '--instance-name',
      'muse-unattended-proof-broker',
      '--state-dir',
      stateDir,
      '--api-port',
      '0',
      '--api-bind',
      '127.0.0.1',
      '--channels',
      '',
    ],
    { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  for (const stream of [broker.stdout, broker.stderr]) {
    stream.on('data', (chunk) => {
      brokerLogs = `${brokerLogs}${chunk}`.slice(-20_000);
    });
  }

  const brokerUrl = await waitFor(async () => {
    try {
      const connection = JSON.parse(await readFile(path.join(stateDir, 'connection.json'), 'utf8'));
      const url = new URL(connection.url);
      const port = Number(url.port);
      if (
        url.protocol !== 'http:' ||
        url.hostname !== '127.0.0.1' ||
        !Number.isInteger(port) ||
        port <= 0 ||
        port > 65535
      ) {
        throw new Error(`bad connection url ${connection.url}`);
      }
      // Only the validated port comes from on-disk state. Rebuild the origin
      // so a stale or tampered connection file cannot redirect the harness.
      return `http://127.0.0.1:${port}`;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }, 'broker connection metadata');
  const api = async (method, pathname, body) => {
    const response = await fetch(`${brokerUrl}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    // The broker answers `Broker is starting, please retry` as plain text
    // before its API is up -- exactly what the readiness probe below waits to
    // stop seeing. Parsing unconditionally threw out of the probe instead of
    // letting it retry, failing the case on a startup race. Keep the raw text
    // as the body so an assertion message still shows what came back.
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  };
  await waitFor(
    () => api('GET', '/api/session').then(({ status }) => status === 200),
    'broker API readiness'
  );
  const spawned = await api('POST', '/api/spawn', {
    name: WORKER_NAME,
    cli: 'muse',
    transport: 'pty',
    cwd: directory,
    channels: [],
    task: `Run the harmless pwd tool, then become ready. ${TASK_MARKER}`,
    skip_relay_prompt: true,
  });
  assert.equal(spawned.status, 200, JSON.stringify(spawned.body));
  assert.equal(spawned.body.success, true, JSON.stringify(spawned.body));

  const prompt = await waitFor(() => readIfPresent(promptMarker), 'Muse argv capture');
  const yoloCount = Number(await readFile(yoloMarker, 'utf8'));
  const agents = async () => (await api('GET', '/api/spawned')).body.agents;

  let outcome;
  let signature;
  let details;
  if (arm === 'base') {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const worker = (await agents()).find((agent) => agent.name === WORKER_NAME);
    assert(worker, 'Base broker must have spawned the real PTY worker');
    assert.equal(yoloCount, 0, 'Base bug must omit --yolo');
    assert(!prompt.includes(TASK_MARKER), 'Base bug must omit the assigned argv startup prompt');
    assert.equal(await readIfPresent(toolMarker), undefined, 'Tool must remain blocked before the fix');
    assert.equal(worker.ready, false, 'Muse must remain idle instead of falsely becoming ready');
    outcome = 'bug';
    signature = 'muse_waits_without_startup_task_or_unattended_mode';
    details =
      'The exact base broker spawned Muse without --yolo or the assigned argv prompt; the harmless pwd tool did not run and the worker remained unready.';
  } else {
    const toolOutput = await waitFor(() => readIfPresent(toolMarker), 'unattended harmless pwd tool');
    const worker = await waitFor(async () => {
      const candidate = (await agents()).find((agent) => agent.name === WORKER_NAME);
      return candidate?.ready ? candidate : undefined;
    }, 'Muse readiness after startup task');
    assert.equal(yoloCount, 1, 'Broker must add --yolo exactly once');
    assert(prompt.includes(TASK_MARKER), 'Muse must receive its assigned task as the argv prompt');
    assert.equal(toolOutput.trim(), directory, 'The fake Muse tool must execute in the assigned cwd');
    assert.equal(worker.runtime_kind, 'pty');
    outcome = 'fixed';
    signature = 'muse_runs_startup_task_unattended_then_ready';
    details =
      'The exact head broker supplied one --yolo plus the assigned argv prompt; Muse ran pwd without an approval stop and then reported ready.';
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details }) + '\n'
  );
} finally {
  await stopBroker();
  await rm(directory, { recursive: true, force: true });
}
