import { execFileSync, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// relay#1615: Relaycast pushes ephemeral `context.update` frames to every
// ws-kind node. The base broker's `ServerToNode` union had no variant for them,
// so every frame failed to parse and was logged as `invalid fleet node ws
// frame` — including the `delivery.failed` / `delivery.deferred` events that
// tell a sending agent its message never landed. The head broker parses the
// frame and routes it into the runtime's delivery-problem handler.
const CASE_ID = '1615-context-update-frames';
const INVALID_FRAME_MARKER = 'invalid fleet node ws frame';
const ROUTED_MARKER = 'ignoring relaycast context.update';
const OBSERVATION_TIMEOUT_MS = 60_000;

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

const probeDir = await mkdtemp(path.join(tmpdir(), 'relayflow-1615-'));
const stateDir = path.join(probeDir, 'state');
const serverPath = path.join(probeDir, 'fake-relaycast.mjs');

// A dependency-free Relaycast stand-in: the handful of HTTP routes the broker
// touches on the way to node control, plus an RFC 6455 server on
// /v1/node/ws that answers `node.register` and then pushes exactly one
// `context.update` (topic `agent`, event `delivery.failed`).
const serverSource = String.raw`import crypto from 'node:crypto';
import http from 'node:http';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CONTEXT_UPDATE = {
  v: 1,
  type: 'context.update',
  topic: 'agent',
  event: 'delivery.failed',
  channel_id: null,
  agent_ids: ['agt_relayflow_sender'],
  data: {
    delivery_id: 'del_relayflow_probe',
    message_id: 'msg_relayflow_probe',
    target_agent_id: 'agt_relayflow_target',
    target_agent_name: 'planner',
    reason: 'recipient_offline',
    error: 'agent has no live node',
    retryable: false,
  },
};

function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function createFrameReader(onText) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        length = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }
      let mask = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      if (opcode === 0x1) onText(payload.toString('utf8'));
    }
  };
}

const server = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    const url = request.url.split('?')[0];
    const send = (data) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, data }));
    };
    if (request.method === 'POST' && url === '/v1/agents') {
      let parsed = {};
      try {
        parsed = JSON.parse(body || '{}');
      } catch {}
      send({
        id: 'agt_relayflow_broker',
        workspace_id: 'ws_relayflow',
        name: parsed.name ?? 'broker',
        token: 'at_relayflow_broker',
        status: 'online',
        created_at: '2026-09-01T00:00:00.000Z',
      });
      return;
    }
    if (url === '/v1/agents' || url === '/v1/channels') {
      send([]);
      return;
    }
    if (url.startsWith('/v1/agents/')) {
      send({ id: 'agt_relayflow_other', name: 'other', status: 'offline', metadata: {} });
      return;
    }
    send({});
  });
});

server.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  // Only the node-control socket drives the probe; the broker also opens a
  // separate terminal socket, which is accepted and then left idle.
  const isNodeControl = request.url.split('?')[0] === '/v1/node/ws';
  let pushed = false;
  socket.on('error', () => {});
  socket.on(
    'data',
    createFrameReader((text) => {
      if (!isNodeControl) return;
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      if (frame.type !== 'node.register' || pushed) return;
      pushed = true;
      socket.write(
        encodeTextFrame(
          JSON.stringify({ v: 1, type: 'reply', id: frame.id ?? 'node-register', ok: true, data: {} })
        )
      );
      // Give the broker's control client a beat to finish the registration
      // handshake before the ephemeral frame arrives.
      setTimeout(() => {
        socket.write(encodeTextFrame(JSON.stringify(CONTEXT_UPDATE)));
        process.stdout.write(JSON.stringify({ pushed: true }) + '\n');
      }, 500);
    })
  );
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address.');
  process.stdout.write(JSON.stringify({ port: address.port }) + '\n');
});

process.once('SIGTERM', () => server.close(() => process.exit(0)));
`;

let server;
let broker;
try {
  await mkdir(stateDir, { recursive: true });
  await writeFile(serverPath, serverSource, { encoding: 'utf8', mode: 0o600 });
  server = spawn(process.execPath, [serverPath], {
    cwd: probeDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverStderr = '';
  server.stderr.on('data', (chunk) => {
    serverStderr += chunk.toString();
  });
  const pushedFrame = { seen: false };
  const port = await waitForServerReady(server, pushedFrame);

  broker = spawn(
    binaryPath,
    [
      'init',
      '--instance-name',
      'relayflow-1615-node',
      '--api-port',
      '0',
      '--channels',
      'general',
      '--state-dir',
      stateDir,
    ],
    {
      cwd: probeDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RELAY_API_KEY: 'rk_relayflow_1615_probe',
        RELAYCAST_BASE_URL: `http://127.0.0.1:${port}`,
        RELAY_NODE_TOKEN: 'nt_relayflow_1615_probe',
        AGENT_RELAY_BROKER_LOG: 'stderr',
        // `invalid fleet node ws frame` is a warning; the accepted-frame path
        // logs at debug because an ephemeral frame is never an error. The
        // event's tracing target is its module path (`relay_broker::runtime::
        // fleet`) — the `target = "relay_broker::fleet"` in the macro is a
        // structured field, not the metadata target — so enable both prefixes
        // rather than betting the proof on which one the call site uses.
        RUST_LOG: 'info,relay_broker::runtime::fleet=debug,relay_broker::fleet=debug',
        RELAY_TELEMETRY_DISABLED: '1',
      },
    }
  );

  let brokerStderr = '';
  let brokerStdout = '';
  broker.stdout.on('data', (chunk) => {
    brokerStdout += chunk.toString();
  });
  broker.stderr.on('data', (chunk) => {
    brokerStderr += chunk.toString();
  });

  const observedAt = await waitForObservation(
    () => {
      if (brokerStderr.includes(INVALID_FRAME_MARKER)) return 'rejected';
      if (pushedFrame.seen && brokerStderr.includes(ROUTED_MARKER)) return 'routed';
      return null;
    },
    broker,
    OBSERVATION_TIMEOUT_MS
  );

  let outcome;
  let signature;
  let details;
  if (observedAt === 'rejected') {
    outcome = 'bug';
    signature = 'context_update_rejected_as_invalid_frame';
    details =
      'The compiled base broker could not parse the Relaycast context.update (topic agent, event ' +
      `delivery.failed) and logged it as "${INVALID_FRAME_MARKER}", so the sending agent was never told ` +
      'its message failed to land.';
  } else if (observedAt === 'routed') {
    outcome = 'fixed';
    signature = 'context_update_accepted_and_routed';
    details =
      'The compiled head broker parsed the Relaycast context.update (topic agent, event ' +
      'delivery.failed) and routed it into the runtime delivery-problem handler; no ' +
      `"${INVALID_FRAME_MARKER}" was logged.`;
  } else {
    throw new Error(
      `Unexpected compiled context.update observation: ${JSON.stringify({
        arm,
        pushed: pushedFrame.seen,
        brokerExit: broker.exitCode,
        stdout: brokerStdout.slice(-2_000),
        stderr: brokerStderr.slice(-4_000),
        serverStderr: serverStderr.slice(-2_000),
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
  await terminate(broker);
  await terminate(server);
  await rm(probeDir, { recursive: true, force: true });
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

async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

// The fake Relaycast announces its port on the first stdout line and the
// context.update push on the second, so the probe never guesses at timing.
function waitForServerReady(child, pushedFrame) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let resolved = false;
    const timer = setTimeout(
      () => reject(new Error('fake Relaycast did not report a listening port')),
      15_000
    );

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) return;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          clearTimeout(timer);
          reject(new Error(`fake Relaycast emitted invalid readiness: ${error.message}`));
          return;
        }
        if (parsed.pushed) {
          pushedFrame.seen = true;
          continue;
        }
        if (!Number.isInteger(parsed.port) || parsed.port <= 0) {
          clearTimeout(timer);
          reject(new Error(`fake Relaycast reported an invalid port ${JSON.stringify(parsed.port)}`));
          return;
        }
        clearTimeout(timer);
        resolved = true;
        resolve(parsed.port);
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (!resolved) {
        reject(new Error(`fake Relaycast exited before readiness (${signal ?? code ?? 'unknown'})`));
      }
    });
  });
}

// Poll the accumulated broker log until one of the two mutually exclusive
// markers appears, the broker dies, or the bound elapses.
function waitForObservation(check, child, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const observation = check();
      if (observation) {
        resolve(observation);
        return;
      }
      if (child.exitCode !== null || Date.now() >= deadline) {
        resolve(null);
        return;
      }
      setTimeout(poll, 250);
    };
    poll();
  });
}
