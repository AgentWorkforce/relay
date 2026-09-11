// This case replaces the retired `1603-raw-spawn-readiness` case (see PR
// #1750). That case proved a *different*, already-fixed bug — raw CLI spawn
// readiness — via the MCP `spawn` tool against a mocked HTTP actions API. On
// current `main` the readiness-wait behavior it asserted against `base` is
// already present, so its `base` arm no longer reproduces anything, and it
// never touched a real broker/Relaycast boundary at all, so it could not
// stand in as proof of issue #1603's actual fix here: durable, restart-safe
// delivery of the hosted `agent_exited` event.
//
// This case is an honest, binary-boundary proof of exactly that restart
// durability, scoped to what it can truthfully drive without a real
// Relaycast fleet-control WebSocket (spawning a worker through the real
// spawn/fleet protocol end-to-end is out of scope for a RelayFlow case —
// that requires the full Relaycast WS control-plane, which is faked at the
// HTTP layer only in local e2e, not something this harness fakes at the
// WS layer). Instead of driving a live worker exit, it seeds the exact
// on-disk `crash-insights.json` format `CrashInsights::save` writes with one
// `Pending` hosted-delivery record — the durable outbox's own on-disk
// contract — and starts the *real compiled* `agent-relay-broker` binary
// against it, pointed at a fake local Relaycast HTTP server:
//
//   - `base` (pre-fix): `run_init` loads `crash-insights.json` but has no
//     concept of replaying a pending hosted delivery on restart at all (the
//     durable outbox — `HostedDeliveryState`, `reload_pending_hosted_agent_exit_backlog`
//     — does not exist in this crate yet). The seeded record is inert:
//     zero HTTP calls are ever made to Relaycast for it.
//   - `head` (post-fix): `run_init` calls
//     `reload_pending_hosted_agent_exit_backlog`, which reconstructs the
//     pending delivery from the seeded record and hands it to
//     `run_hosted_agent_event_publisher`. That publisher POSTs a real HTTP
//     request to this case's fake Relaycast server's
//     `POST /v1/agents/:name/events` endpoint (see `emit_agent_event` /
//     `HOSTED_PUBLISH_MAX_ATTEMPTS` in `crates/broker/src/runtime/event_loop.rs`),
//     which answers the first attempt with a transient 503 and the retry
//     with 200 — exercising the exact in-process retry-then-succeed path
//     covered by `publisher_recovers_and_reports_success_after_transient_5xx`,
//     but through the real compiled binary and a real (locally faked) HTTP
//     boundary rather than an in-process Rust unit test.
//
// The narrower Rust-level regression tests remain the authoritative, more
// exhaustive coverage for this feature (in-process retry exhaustion,
// dedupe-on-replay, `>256`-record backlog draining without duplicates, and
// retention-pressure eviction policy for the durable outbox itself):
// `crates/broker/src/runtime/event_loop.rs`
// (`publisher_reports_failure_after_exhausting_retries_on_persistent_5xx`,
// `publisher_recovers_and_reports_success_after_transient_5xx`) and
// `crates/broker/src/runtime/tests.rs`
// (`delivered_dedupe_key_is_excluded_from_replay`,
// `restart_before_drain_replays_pending_delivery_from_disk`,
// `replenish_backlog_drains_a_large_pending_backlog_without_restart_or_duplicates`).
// This case does not re-test those; it only proves the one thing they cannot
// prove on their own — that the real compiled broker binary actually wires
// this behavior together end to end at process startup against a real HTTP
// transport.
import { execFileSync, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1603-hosted-exit-durable-delivery';
const TRANSIENT_STATUS = 503;
const AGENT_NAME = 'relayflow-1603-crashed-worker';
const GENERATION = 'relayflow-1603-generation';
const DEDUPE_KEY = `${AGENT_NAME}::${GENERATION}`;
const INSTANCE_NAME = 'relayflow-1603-broker';
// The whole startup + replay + retry-through-transient-failure sequence must
// land far inside this.
const STARTUP_WINDOW_MS = 60_000;
// Emitted by connect_relay once registration and the workspace session are
// established, on both arms.
const HANDSHAKE_MARKER = 'connect_relay completed';
// Once the handshake completes, this is how long we wait to see whether the
// seeded pending delivery is ever replayed. The real retry-then-succeed path
// (200ms base delay, one retry) completes in well under a second; this bound
// only needs to be long enough that a `base` binary's true, permanent
// absence of the replay mechanism is not mistaken for a slow `head`.
const REPLAY_OBSERVATION_WINDOW_MS = 8_000;

const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
const binaryPath = await requiredExecutable('RELAY_PR_PROOF_BROKER_BINARY');
const resultPath = requiredValue('RELAY_PR_PROOF_RESULT_PATH');
const arm = requiredValue('RELAY_PR_PROOF_ARM');

if (arm !== 'base' && arm !== 'head') {
  throw new Error(`RELAY_PR_PROOF_ARM must be base or head, received ${JSON.stringify(arm)}.`);
}

const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
if (!expectedSha) throw new Error(`Missing expected ${arm} SHA.`);
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
}

const runnerPath = fileURLToPath(import.meta.url);
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

const probeDir = await mkdtemp(path.join(tmpdir(), 'relayflow-1603-'));
const stateDir = path.join(probeDir, 'state');
const serverPath = path.join(probeDir, 'fake-relaycast.mjs');
// Fake Relaycast: accepts the registration handshake exactly like
// `1700-broker-startup-transient-relaycast-retry`'s probe server, and adds a
// `/v1/agents/:name/events` route (the real hosted-delivery publish
// endpoint — see `RelaycastHttpClient::emit_agent_event`) that fails the
// first delivery attempt with a transient 503 and succeeds on the retry.
const serverSource = String.raw`import http from 'node:http';

let registrationCount = 0;
let eventAttempts = 0;
const eventBodies = [];
const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/observations') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ registrationCount, eventAttempts, eventBodies }));
    return;
  }
  if (request.method === 'POST' && request.url === '/v1/agents') {
    request.resume();
    request.once('end', () => {
      registrationCount += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        data: {
          id: 'a_relayflow_1603',
          workspace_id: 'ws_relayflow_1603',
          name: '${INSTANCE_NAME}',
          token: 'at_live_relayflow_1603',
          status: 'online',
          created_at: '2025-01-01T00:00:00Z',
        },
      }));
    });
    return;
  }
  if (request.method === 'POST' && request.url === '/v1/agents/${AGENT_NAME}/events') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.once('end', () => {
      eventAttempts += 1;
      const attempt = eventAttempts;
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        parsed = null;
      }
      eventBodies.push(parsed);
      if (attempt === 1) {
        response.writeHead(${TRANSIENT_STATUS}, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          ok: false,
          error: { code: 'database_overloaded', message: 'The database is temporarily overloaded.' },
        }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        data: { id: 'evt_relayflow_1603', agent_id: 'a_relayflow_1603', type: 'agent_exited', payload: parsed?.payload ?? {}, created_at: '2025-01-01T00:00:01Z' },
      }));
    });
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: request.url } }));
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address.');
  process.stdout.write(JSON.stringify({ port: address.port }) + '\n');
});
process.once('SIGTERM', () => server.close(() => process.exit(0)));
`;

let server;
try {
  await mkdir(stateDir, { recursive: true });
  await seedCrashInsights(stateDir);
  await writeFile(serverPath, serverSource, { encoding: 'utf8', mode: 0o600 });
  server = spawn(process.execPath, [serverPath], {
    cwd: probeDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const { port, stderr: serverStderr } = await waitForServerReady(server);

  const startedAt = Date.now();
  const observed = await runBrokerAgainstSeededOutbox({
    binaryPath,
    cwd: probeDir,
    stateDir,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: probeDir,
      TMPDIR: probeDir,
      NO_COLOR: '1',
      RELAYCAST_BASE_URL: `http://127.0.0.1:${port}`,
      AGENT_RELAY_WORKSPACE_KEY: 'rk_relayflow_1603',
      AGENT_RELAY_STARTUP_DEBUG: '1',
      AGENT_RELAY_TELEMETRY_DISABLED: '1',
    },
  });
  const elapsedMs = Date.now() - startedAt;
  const stderr = observed.stderr;

  if (!stderr.includes(HANDSHAKE_MARKER)) {
    throw new Error(
      `Unexpected compiled startup observation: handshake never completed. ${JSON.stringify({
        arm,
        timedOut: observed.timedOut,
        elapsedMs,
        stdout: observed.stdout.slice(-2_000),
        stderr: `${serverStderr}${stderr}`.slice(-2_000),
      })}.`
    );
  }

  const final = await readObservations(port);

  let outcome;
  let signature;
  let details;
  if (final.eventAttempts === 0) {
    // Base has no `reload_pending_hosted_agent_exit_backlog` (the durable
    // outbox does not exist in this crate at all) — the seeded pending
    // record is inert, so no HTTP delivery is ever attempted.
    outcome = 'bug';
    signature = 'restart_never_replays_pending_hosted_exit';
    details = `The base broker completed the Relaycast handshake but never issued an HTTP request to Relaycast for the seeded Pending hosted agent_exited record after ${elapsedMs}ms; the durable-outbox restart replay mechanism does not exist on this arm.`;
  } else if (
    final.eventAttempts === 2 &&
    final.eventBodies[0]?.payload?.dedupe_key === DEDUPE_KEY &&
    final.eventBodies[1]?.payload?.dedupe_key === DEDUPE_KEY
  ) {
    // Head replays the seeded Pending record on startup, the first delivery
    // attempt hits the transient 503, and the in-process retry (see
    // HOSTED_PUBLISH_MAX_ATTEMPTS / HOSTED_PUBLISH_RETRY_BASE_DELAY) succeeds
    // without a second broker restart.
    outcome = 'fixed';
    signature = 'restart_replays_pending_hosted_exit_through_transient_failure';
    details = `The head broker replayed the seeded Pending hosted agent_exited record on startup, retried through one transient ${TRANSIENT_STATUS} from Relaycast, and delivered it successfully in ${elapsedMs}ms (2 POST attempts to /v1/agents/${AGENT_NAME}/events, both carrying dedupe_key ${DEDUPE_KEY}).`;
  } else {
    throw new Error(
      `Unexpected compiled replay observation: ${JSON.stringify({
        arm,
        elapsedMs,
        final,
        stdout: observed.stdout.slice(-2_000),
        stderr: `${serverStderr}${stderr}`.slice(-2_000),
      })}.`
    );
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  await rm(probeDir, { recursive: true, force: true });
}

/**
 * Write `crash-insights.json` in the exact on-disk shape
 * `CrashInsights::save` produces (see `crates/relay-pty/src/crash_insights.rs`),
 * seeded with one record whose hosted delivery is `Pending`. Written to the
 * same path `run_init` loads from (`{state_dir}/crash-insights.json`).
 * Deliberately written before the broker ever starts, so the "restart" this
 * case exercises is really this process's first startup finding durable
 * state a previous (unmodeled) session already left behind.
 */
async function seedCrashInsights(directory) {
  const record = {
    agent_name: AGENT_NAME,
    exit_code: 1,
    signal: null,
    timestamp: 1_700_000_000,
    uptime_secs: 42,
    category: 'error',
    description: 'Nonzero exit code (application error)',
    workspace_id: null,
    spawn_invocation_id: null,
    generation: GENERATION,
    became_ready: true,
    spawned_at: 1_699_999_950,
    ready_at: 1_699_999_955,
    exited_at: 1_699_999_992,
    exit_reason: 'nonzero exit',
    fleet_node_name: null,
    hosted_delivery: 'pending',
  };
  const crashInsights = { records: [record], max_records: 500 };
  await writeFile(
    path.join(directory, 'crash-insights.json'),
    `${JSON.stringify(crashInsights, null, 2)}\n`,
    'utf8'
  );
}

/**
 * `init` is a long-lived server: on the fixed arm it keeps running once the
 * pending delivery is either replayed to completion or (on base) never
 * replayed at all. Settle once the handshake marker appears AND the
 * observation window has elapsed with a stable result, or the process
 * exits, so neither arm has to wait out the full wall-clock timeout.
 */
function runBrokerAgainstSeededOutbox({ binaryPath, cwd, stateDir, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      binaryPath,
      [
        'init',
        '--instance-name',
        INSTANCE_NAME,
        '--channels',
        'general',
        '--persist',
        '--state-dir',
        stateDir,
      ],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    let settleTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(settleTimer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ stdout, stderr, status: null, signal: null, timedOut: true }),
      STARTUP_WINDOW_MS
    );
    const armSettleTimer = () => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(
        () => finish({ stdout, stderr, status: null, signal: null, timedOut: false }),
        REPLAY_OBSERVATION_WINDOW_MS
      );
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.includes(HANDSHAKE_MARKER)) armSettleTimer();
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(settleTimer);
      reject(new Error(`compiled broker probe could not start: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      finish({ stdout, stderr, status: code, signal, timedOut: false });
    });
  });
}

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function requiredDirectory(name) {
  return path.resolve(requiredValue(name));
}

async function requiredExecutable(name) {
  const candidate = path.resolve(requiredValue(name));
  try {
    await access(candidate, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    throw new Error(`${name} must name a readable executable file.`);
  }
  return candidate;
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

async function readObservations(port) {
  const response = await fetch(`http://127.0.0.1:${port}/observations`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`startup probe observation endpoint returned ${response.status}`);
  }
  const observation = await response.json();
  if (!Number.isInteger(observation?.eventAttempts) || observation.eventAttempts < 0) {
    throw new Error(`startup probe returned an invalid observation ${JSON.stringify(observation)}`);
  }
  return observation;
}

function waitForServerReady(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('startup probe server did not start')), 10_000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        const ready = JSON.parse(stdout.slice(0, newline));
        if (!Number.isInteger(ready.port) || ready.port <= 0) {
          throw new Error(`invalid port ${JSON.stringify(ready.port)}`);
        }
        resolve({ port: ready.port, stderr });
      } catch (error) {
        reject(new Error(`startup probe server emitted invalid readiness: ${error.message}`));
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(`startup probe server exited before readiness (${signal ?? code ?? 'unknown'}): ${stderr}`)
      );
    });
  });
}
