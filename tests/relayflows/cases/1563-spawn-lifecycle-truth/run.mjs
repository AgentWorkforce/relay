/**
 * relay#1563 / PR #1751 — invocation-state lifecycle truth.
 *
 * Base bug: a spawn placement whose action invocation reached a terminal
 * "completed" status was trusted as a real launch even when the node never
 * proved `output.spawned === true && output.ready === true`. A dispatched
 * invocation that timed out unconfirmed also lacked the explicit
 * "do not retry blindly" guidance an operator needs before re-dispatching
 * onto a node that may already be running the worker. Fleet-wide rendering
 * (`fleet agent list`) also collapsed control-plane reachability and hosted
 * worker liveness into a single signal, so an offline/degraded node with
 * live child workers could not be told apart from one with none. The MCP
 * `spawn` tool wrapped the same ack/poll logic with its own untyped `Error`,
 * so none of the above survived across the MCP wire either.
 *
 * Head fix: `RelaycastMessagingClient.placement.spawn` (packages/sdk/src/
 * messaging/relaycast.ts) rejects a terminal "completed" invocation lacking
 * explicit spawned+ready proof as `spawn_failed`, preserving the structured
 * receipt (`receipt`, `invocationId`, `dispatchState`) on the thrown
 * `RelayPlacementError`; the unconfirmed-timeout path keeps that evidence and
 * now spells out "do not retry blindly". `buildRows` (packages/cli/src/cli/
 * commands/fleet-agent.ts) reports `controlPlane` and `workerLiveness` as two
 * independent axes on every row, both in the exact JSON body `fleet agent
 * list` emits through `printJson` and in `--pretty` (`formatPretty`'s
 * dedicated CONTROL PLANE / WORKERS columns). The MCP `spawn` tool
 * (packages/cli/src/cli/agent-relay-mcp.ts) now throws a typed
 * `VerifiedSpawnError` carrying `code`/`state`/`dispatchState`/`invocationId`/
 * `receipt`, surfaced as structured `structuredContent` on the MCP error
 * result instead of a bare error string.
 *
 * Observation drives three real, built package entry surfaces — no source
 * regex, no vitest-over-`src/`:
 *
 *   1. The SDK's public `@agent-relay/sdk` messaging entry
 *      (`dist/messaging/index.js`), constructing the real
 *      `RelaycastMessagingClient` the CLI's `fleet spawn --node` path and the
 *      MCP `spawn` tool both build through the SDK, with a mocked
 *      agent-actions transport (dependency injection the class itself
 *      exposes — not a source stand-in).
 *   2. The CLI's built `fleet agent list` JSON contract: the exact object
 *      shape `packages/cli/dist/cli/commands/fleet.ts` passes to
 *      `printJson` (`packages/cli/dist/cli/lib/sdk-command.js`), run through
 *      that real `printJson` function and parsed back out of the JSON text it
 *      emits — not just inspected as a return value from `buildRows`.
 *   3. The MCP `spawn` tool the PR's `fix(mcp)` commit changed
 *      (`packages/cli/dist/cli/agent-relay-mcp.js`), invoked over a real MCP
 *      client/server protocol pair (`InMemoryTransport`) via
 *      `mcp-spawn-probe.mjs`, which is copied into the target checkout so its
 *      `@modelcontextprotocol/sdk` import resolves against that checkout's
 *      own installed dependency. The tool's own spawn client makes real HTTP
 *      calls, so this case stands up a tiny HTTP server that speaks the
 *      exact `@relaycast/sdk` action-invocation wire contract
 *      (`POST /v1/actions/spawn/invoke`, `GET /v1/actions/spawn/invocations/
 *      :id`, `{ ok, data }` envelope, snake_case fields camelCased back) so
 *      each lifecycle branch (unproven-complete, unconfirmed, terminal
 *      failure) is forced deterministically without a live Relaycast.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CASE_ID = '1563-spawn-lifecycle-truth';
// Sanitized from the live accepted-but-unconfirmed reproduction supplied for
// relay#1563. The id is correlation evidence only; no live credentials or
// provider metadata are carried into this deterministic fixture.
const LIVE_UNCONFIRMED_INVOCATION_ID = 'inv_223936432626290688';
const arm = requiredValue('RELAY_PR_PROOF_ARM');
if (arm !== 'base' && arm !== 'head') {
  throw new Error(`RELAY_PR_PROOF_ARM must be base or head, received ${JSON.stringify(arm)}.`);
}
const targetDir = requiredValue('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredValue('RELAY_PR_PROOF_HARNESS_DIR');
const resultPath = requiredValue('RELAY_PR_PROOF_RESULT_PATH');
const caseDir = path.dirname(fileURLToPath(import.meta.url));

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

function run(command, args, cwd, label) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${result.status}`);
  }
  return result;
}

function runAsync(command, args, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...extraEnv } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', (code) => resolve({ status: code, stdout, stderr }));
  });
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`);
  }
}
function assertTrue(actual, label) {
  if (actual !== true) throw new Error(`${label}: expected true, received ${JSON.stringify(actual)}.`);
}
function assertContains(haystack, needle, label) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${label}: expected ${JSON.stringify(haystack)} to contain ${JSON.stringify(needle)}.`);
  }
}
function assertNotContains(haystack, needle, label) {
  if (String(haystack).includes(needle)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(haystack)} NOT to contain ${JSON.stringify(needle)}.`
    );
  }
}

/** A tiny server speaking the real `@relaycast/sdk` action-invocation wire contract. */
function startActionsServer() {
  const invocations = new Map();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try {
      const text = Buffer.concat(chunks).toString('utf8');
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const invoke = /^\/v1\/actions\/([^/]+)\/invoke$/.exec(req.url ?? '');
    const getInvocation = /^\/v1\/actions\/([^/]+)\/invocations\/([^/]+)$/.exec(req.url ?? '');

    if (req.method === 'POST' && invoke) {
      const input = body?.input && typeof body.input === 'object' ? body.input : {};
      const name = typeof input.name === 'string' ? input.name : '';
      const actionName = invoke[1];
      if (name.endsWith('unconfirmed')) {
        // No invocation id in the ack at all: the dispatch is unconfirmed
        // from the very first response, no polling required to observe it.
        send(200, { ok: true, data: { action_name: actionName, status: 'invoked' } });
        return;
      }
      const invocationId = `inv-${name}`;
      if (name.endsWith('no-route-failed')) {
        // relay#1563 Medium (MCP): the ack itself carries no node id and a
        // `pending` status — it has not routed yet. The later terminal read
        // ALSO carries no node id; only its `status` flips to `failed`. A
        // dispatchState classifier that trusts the later record's status
        // alone (ignoring that no node id ever appeared) would wrongly
        // upgrade `not_dispatched` to `dispatched`.
        invocations.set(invocationId, {
          invocation_id: invocationId,
          action_name: actionName,
          status: 'failed',
          error: 'never routed before failing',
        });
        send(200, {
          ok: true,
          data: {
            invocation_id: invocationId,
            action_name: actionName,
            status: 'pending',
          },
        });
        return;
      }
      const terminal = name.endsWith('failed')
        ? {
            invocation_id: invocationId,
            action_name: actionName,
            status: 'failed',
            handler_node_id: 'node_a',
            dispatched_node_id: 'node_a',
            error: 'harness exited before readiness',
          }
        : {
            invocation_id: invocationId,
            action_name: actionName,
            status: 'completed',
            handler_node_id: 'node_a',
            dispatched_node_id: 'node_a',
            output: { spawned: true, ready: false },
          };
      invocations.set(invocationId, terminal);
      send(200, {
        ok: true,
        data: {
          invocation_id: invocationId,
          action_name: actionName,
          status: 'invoked',
          handler_node_id: 'node_a',
          dispatched_node_id: 'node_a',
        },
      });
      return;
    }
    if (req.method === 'GET' && getInvocation) {
      const record = invocations.get(getInvocation[2]);
      if (!record) {
        send(404, { ok: false, error: { code: 'not_found', message: 'no such invocation' } });
        return;
      }
      send(200, { ok: true, data: record });
      return;
    }
    send(404, { ok: false, error: { code: 'not_found', message: 'no such route' } });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const proofDir = path.join(targetDir, '.relay-pr-proof');
let actionsServer;

try {
  const nodeModulesEntry = path.join(targetDir, 'node_modules', '.bin');
  if (!(await pathExists(nodeModulesEntry))) {
    run('npm', ['ci', '--no-audit', '--no-fund'], targetDir, 'workspace dependency installation');
  }

  // --- Focused build: only what these three surfaces need, in dependency
  // order, matching the root `build:core` script.
  for (const step of [
    'build:session',
    'build:config',
    'build:cloud',
    'build:utils',
    'build:policy',
    'build:sdk',
    'build:harness-driver',
    'build:harnesses',
    'build:fleet',
    'build:cli',
  ]) {
    run('npm', ['run', step], targetDir, `${step} build`);
  }

  // --- Focused typecheck: the CLI package's own `tsc --noEmit`, which
  // exercises `agent-relay-mcp.ts` and `fleet.ts`/`fleet-agent.ts` directly.
  run(
    process.execPath,
    [path.join(targetDir, 'node_modules/.bin/tsc'), '--noEmit'],
    path.join(targetDir, 'packages/cli'),
    'cli typecheck'
  );

  // --- Focused unit tests already covering the exact files this proof
  // drives, run from the target's own installed vitest.
  const vitestEntry = path.join(targetDir, 'node_modules', 'vitest', 'vitest.mjs');
  run(
    process.execPath,
    [
      vitestEntry,
      'run',
      'packages/cli/src/cli/agent-relay-mcp.protocol.test.ts',
      'packages/cli/src/cli/commands/fleet-agent.test.ts',
      '--reporter=verbose',
    ],
    targetDir,
    'focused vitest run'
  );

  const sdkMessagingEntry = path.join(targetDir, 'packages/sdk/dist/messaging/index.js');
  const fleetAgentEntry = path.join(targetDir, 'packages/cli/dist/cli/commands/fleet-agent.js');
  const sdkCommandEntry = path.join(targetDir, 'packages/cli/dist/cli/lib/sdk-command.js');
  const spawnLifecycleEntry = path.join(targetDir, 'packages/cli/dist/cli/lib/spawn-lifecycle.js');
  const mcpEntry = path.join(targetDir, 'packages/cli/dist/cli/agent-relay-mcp.js');
  // The lifecycle projection is introduced by the head under test. The base
  // arm must still execute its real SDK/CLI/MCP surfaces, but cannot require a
  // package entry that does not exist on the base commit.
  const requiredEntries = [sdkMessagingEntry, fleetAgentEntry, sdkCommandEntry, mcpEntry];
  if (arm === 'head') requiredEntries.push(spawnLifecycleEntry);
  for (const entry of requiredEntries) {
    if (!(await pathExists(entry))) {
      throw new Error(`Expected built package entry surface missing: ${entry}`);
    }
  }

  // === 1. SDK entry surface: RelaycastMessagingClient.placement.spawn ===
  const { RelaycastMessagingClient } = await import(pathToFileURL(sdkMessagingEntry).href);

  const READY_NODE = {
    id: 'node_a',
    name: 'node-a',
    status: 'online',
    live: true,
    handlers_live: true,
    capabilities: [{ name: 'spawn:claude', kind: 'spawn' }],
  };
  function createSdkClient(getInvocation, invokeAck) {
    const relaycast = {
      agents: {
        list: async () => [],
        get: async () => undefined,
        register: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
        presence: async () => [],
      },
      channels: { list: async () => [], get: async () => undefined },
      messages: {
        list: async () => [],
        get: async () => undefined,
        thread: async () => undefined,
        reactions: async () => [],
      },
      nodes: { list: async () => [READY_NODE], get: async () => READY_NODE },
    };
    const agentClient = {
      actions: {
        invoke: async (name) =>
          invokeAck ?? {
            invocation_id: 'inv_lifecycle_proof',
            action_name: name,
            handler_node_id: 'node_a',
            dispatched_node_id: 'node_a',
            status: 'invoked',
          },
        getInvocation,
        completeInvocation: async () => undefined,
      },
    };
    return new RelaycastMessagingClient({ relaycast, agentClient, placementTtlMs: 30 });
  }
  async function captureError(fn) {
    try {
      await fn();
      return undefined;
    } catch (error) {
      return error;
    }
  }

  const unproven = createSdkClient(async () => ({
    invocation_id: 'inv_lifecycle_proof',
    action_name: 'spawn:claude',
    status: 'completed',
    output: { spawned: true, ready: false },
  }));
  const unprovenError = await captureError(() =>
    unproven.placement.spawn({
      capability: 'spawn:claude',
      node: 'node-a',
      confirm: true,
      confirmTimeoutMs: 500,
      confirmPollIntervalMs: 10,
    })
  );

  const unconfirmed = createSdkClient(async () => undefined);
  const unconfirmedError = await captureError(() =>
    unconfirmed.placement.spawn({
      capability: 'spawn:claude',
      node: 'node-a',
      confirm: true,
      confirmTimeoutMs: 60,
      confirmPollIntervalMs: 10,
    })
  );

  // Live reproduction fixture: the node advertised capacity and accepted
  // this invocation, but never returned a terminal result. Keep the exact
  // invocation id so this proof cannot regress into an unrelated synthetic
  // timeout while retaining the generalized fixture above.
  const liveAccepted = createSdkClient(
    async (_name, invocationId) => ({
      invocation_id: invocationId,
      action_name: 'spawn:claude',
      handler_node_id: 'node_a',
      dispatched_node_id: 'node_a',
      status: 'accepted',
    }),
    {
      invocation_id: LIVE_UNCONFIRMED_INVOCATION_ID,
      action_name: 'spawn:claude',
      handler_node_id: 'node_a',
      dispatched_node_id: 'node_a',
      status: 'accepted',
    }
  );
  const liveAcceptedError = await captureError(() =>
    liveAccepted.placement.spawn({
      capability: 'spawn:claude',
      node: 'node-a',
      confirm: true,
      confirmTimeoutMs: 60,
      confirmPollIntervalMs: 10,
    })
  );

  const terminalFailed = createSdkClient(async () => ({
    invocation_id: 'inv_lifecycle_proof',
    action_name: 'spawn:claude',
    status: 'failed',
    error: 'harness exited before readiness',
  }));
  const terminalFailedError = await captureError(() =>
    terminalFailed.placement.spawn({
      capability: 'spawn:claude',
      node: 'node-a',
      confirm: true,
      confirmTimeoutMs: 500,
      confirmPollIntervalMs: 10,
    })
  );

  assertTrue(terminalFailedError !== undefined, 'SDK: terminal failure must always throw');
  assertEqual(terminalFailedError.code, 'spawn_failed', 'SDK: terminal failure code');
  assertContains(
    terminalFailedError.message ?? '',
    'harness exited before readiness',
    'SDK: terminal failure message'
  );

  // Confirm:false is also the CLI's --no-confirm path. A terminal denial in
  // the ack is already a known failure, and its invocation/receipt correlation
  // must survive without entering the confirmation poll.
  const immediateDenied = createSdkClient(async () => undefined, {
    invocation_id: 'inv_immediate_denied',
    action_name: 'spawn:claude',
    handler_node_id: 'node_a',
    status: 'denied',
    error: 'node denied the spawn',
  });
  const immediateDeniedError = await captureError(() =>
    immediateDenied.placement.spawn({
      capability: 'spawn:claude',
      node: 'node-a',
      confirm: false,
    })
  );

  // relay#1563 P1: dispatchState must reflect the ack's actual route
  // evidence, not a hardcoded 'dispatched'. A `pending` ack with no
  // `dispatchedNodeId`/`handlerNodeId` never routed to a node — the CLI's
  // shared spawn-lifecycle helper classifies that exact shape as
  // `not_dispatched`, and the SDK must agree whether the caller later
  // observes a confirmation timeout or a terminal read.
  const noRouteAck = {
    invocation_id: 'inv_no_route_proof',
    action_name: 'spawn:claude',
    status: 'pending',
    handler_node_id: null,
    dispatched_node_id: null,
  };
  const noRouteUnconfirmed = createSdkClient(async () => undefined, noRouteAck);
  const noRouteUnconfirmedError = await captureError(() =>
    noRouteUnconfirmed.placement.spawn({
      capability: 'spawn:claude',
      node: 'node-a',
      confirm: true,
      confirmTimeoutMs: 60,
      confirmPollIntervalMs: 10,
    })
  );

  const noRouteTerminalFailed = createSdkClient(
    async () => ({
      invocation_id: 'inv_no_route_proof',
      action_name: 'spawn:claude',
      status: 'failed',
      error: 'never routed before failing',
    }),
    noRouteAck
  );
  const noRouteTerminalFailedError = await captureError(() =>
    noRouteTerminalFailed.placement.spawn({
      capability: 'spawn:claude',
      node: 'node-a',
      confirm: true,
      confirmTimeoutMs: 500,
      confirmPollIntervalMs: 10,
    })
  );

  // === 2. CLI entry surface: the exact `fleet agent list` JSON body, through
  // the real `printJson`. ===
  const { buildRows, formatPretty } = await import(pathToFileURL(fleetAgentEntry).href);
  const { printJson } = await import(pathToFileURL(sdkCommandEntry).href);
  let automaticUnprovenReceipt;
  if (arm === 'head') {
    const { spawnPlacementReceipt } = await import(pathToFileURL(spawnLifecycleEntry).href);
    automaticUnprovenReceipt = spawnPlacementReceipt({
      invocation_id: 'inv_automatic_unproven',
      status: 'completed',
      output: { spawned: true, ready: false },
    });
  }

  const now = new Date();
  const output = buildRows(
    {
      contributions: [
        {
          node: {
            name: 'node-b',
            status: 'offline',
            live: false,
            handlersLive: false,
            capabilities: [],
            activeAgents: 1,
          },
          isLocal: true,
          liveAgents: [
            {
              name: 'worker-1',
              current_state: 'busy',
              pending_messages: 0,
              last_activity_at: now.toISOString(),
            },
          ],
          inventoryAgents: [],
        },
      ],
      roster: [],
    },
    now
  );
  let jsonText = '';
  printJson(
    { log: (text) => (jsonText = text) },
    {
      generatedAt: now.toISOString(),
      localNode: null,
      perNode: output.perNode,
      unplacedRoster: output.unplacedRoster,
      errors: output.errors,
    }
  );
  const emitted = JSON.parse(jsonText);
  assertEqual(
    Object.keys(emitted).sort().join(','),
    'errors,generatedAt,localNode,perNode,unplacedRoster',
    'fleet agent list JSON top-level contract'
  );
  const degradedRow = emitted.perNode.find((row) => row.name === 'worker-1');
  assertTrue(Boolean(degradedRow), 'fleet agent list JSON must include the degraded worker row');
  const prettyOutput = formatPretty(output);

  // === 3. MCP entry surface: the real `spawn` tool over the real MCP
  // protocol, backed by the real `@relaycast/sdk` action-invocation wire. ===
  await mkdir(proofDir, { recursive: true });
  const mcpProbePath = path.join(proofDir, 'mcp-spawn-probe.mjs');
  await copyFile(path.join(caseDir, 'mcp-spawn-probe.mjs'), mcpProbePath);

  actionsServer = await startActionsServer();
  const { port } = actionsServer.address();
  // `spawnSync` would block this process's event loop, and `actionsServer`
  // (an in-process HTTP server) would never get to accept the probe's
  // requests — the probe would hang until the MCP client's own call timeout.
  // Use the async `spawn` so the server keeps servicing requests while the
  // probe runs.
  const mcpProbeResult = await runAsync(process.execPath, [mcpProbePath], targetDir, {
    RELAY_PR_PROOF_1563_BASE_URL: `http://127.0.0.1:${port}`,
  });
  process.stdout.write(mcpProbeResult.stdout ?? '');
  process.stderr.write(mcpProbeResult.stderr ?? '');
  if (mcpProbeResult.status !== 0) {
    throw new Error(
      `MCP spawn tool probe failed (exit ${mcpProbeResult.status}): ${(mcpProbeResult.stderr || mcpProbeResult.stdout || '').slice(-4_000)}`
    );
  }
  const mcp = JSON.parse((mcpProbeResult.stdout ?? '').trim().split('\n').pop());

  if (arm === 'base') {
    // 1. Base trusted a terminal "completed" status at face value: no
    // spawned/ready check existed, so the ack is returned, not thrown.
    assertEqual(unprovenError, undefined, 'SDK base: unproven completed spawn must not throw');

    // 2. The unconfirmed-timeout error exists on base too, but its message
    // does not yet spell out the no-blind-retry guidance.
    assertTrue(unconfirmedError !== undefined, 'SDK base: unconfirmed spawn must still throw');
    assertEqual(unconfirmedError.code, 'spawn_unconfirmed', 'SDK base: unconfirmed code');
    assertNotContains(
      unconfirmedError.message ?? '',
      'do not retry blindly',
      'SDK base: unconfirmed message'
    );

    // 3. Terminal failure on base is a bare error: no invocationId,
    // dispatchState, or structured receipt survive onto the thrown error.
    assertEqual(
      'invocationId' in terminalFailedError,
      false,
      'SDK base: no invocationId on terminal failure'
    );
    assertEqual(
      'dispatchState' in terminalFailedError,
      false,
      'SDK base: no dispatchState on terminal failure'
    );
    assertEqual('receipt' in terminalFailedError, false, 'SDK base: no receipt on terminal failure');
    assertEqual(immediateDeniedError, undefined, 'SDK base: confirm:false terminal denial was not rejected');

    // 4. Base has no controlPlane/workerLiveness axis at all.
    assertEqual(degradedRow?.controlPlane, undefined, 'CLI base: no controlPlane axis in JSON');
    assertEqual(degradedRow?.workerLiveness, undefined, 'CLI base: no workerLiveness axis in JSON');
    assertNotContains(prettyOutput, 'CONTROL PLANE', 'CLI base: no CONTROL PLANE column in --pretty');
    assertNotContains(prettyOutput, 'WORKERS', 'CLI base: no WORKERS column in --pretty');

    // 5. The MCP `spawn` tool's own untyped `Error` carries no structured
    // evidence: `structuredContent` is absent from the error result (the MCP
    // framework only attaches the plain error text).
    for (const key of ['unproven', 'unconfirmed', 'failed', 'noRouteFailed']) {
      const result = mcp[key];
      assertTrue(result.isError === true, `MCP base: ${key} must be an error result`);
      assertTrue(
        result.structuredContent === undefined,
        `MCP base: ${key} must carry no structured spawn evidence`
      );
    }

    await writeResult({
      outcome: 'bug',
      signature: 'invocation_state_lifecycle_gaps',
      details:
        'The base SDK trusted a terminal "completed" spawn invocation without explicit spawned:true/' +
        'ready:true proof, gave no "do not retry blindly" guidance on an unconfirmed dispatch timeout, ' +
        'dropped invocationId/dispatchState/receipt off a terminal failure, and fleet agent list JSON ' +
        'had no controlPlane/workerLiveness axes. The MCP spawn tool mirrored the gap: every failure mode ' +
        'surfaced as a bare error with no structuredContent for a caller to act on.',
    });
  } else {
    // --- Head: every gap above is closed.
    assertTrue(unprovenError !== undefined, 'SDK head: unproven completed spawn must throw');
    assertEqual(unprovenError.code, 'spawn_failed', 'SDK head: unproven code');
    assertEqual(unprovenError.invocationId, 'inv_lifecycle_proof', 'SDK head: unproven invocationId');
    assertEqual(unprovenError.dispatchState, 'dispatched', 'SDK head: unproven dispatchState');
    assertEqual(unprovenError.receipt?.status, 'completed', 'SDK head: unproven receipt status');
    assertEqual(unprovenError.receipt?.output?.ready, false, 'SDK head: unproven receipt output.ready');

    assertTrue(unconfirmedError !== undefined, 'SDK head: unconfirmed spawn must throw');
    assertEqual(unconfirmedError.code, 'spawn_unconfirmed', 'SDK head: unconfirmed code');
    assertEqual(unconfirmedError.invocationId, 'inv_lifecycle_proof', 'SDK head: unconfirmed invocationId');
    assertEqual(unconfirmedError.dispatchState, 'dispatched', 'SDK head: unconfirmed dispatchState');
    assertContains(unconfirmedError.message ?? '', 'do not retry blindly', 'SDK head: unconfirmed message');

    assertTrue(liveAcceptedError !== undefined, 'SDK head: live accepted spawn must fail nonzero');
    assertEqual(
      liveAcceptedError.code,
      'spawn_unconfirmed',
      'SDK head: live accepted spawn must be unconfirmed'
    );
    assertEqual(liveAcceptedError.state, 'unconfirmed_may_be_running', 'SDK head: live accepted spawn state');
    assertEqual(
      liveAcceptedError.invocationId,
      LIVE_UNCONFIRMED_INVOCATION_ID,
      'SDK head: live accepted invocation correlation'
    );
    assertEqual(liveAcceptedError.dispatchState, 'dispatched', 'SDK head: live accepted dispatchState');
    assertContains(
      liveAcceptedError.message ?? '',
      'do not retry blindly',
      'SDK head: live accepted no-blind-retry guidance'
    );

    assertEqual(
      terminalFailedError.invocationId,
      'inv_lifecycle_proof',
      'SDK head: terminal failure invocationId'
    );
    assertEqual(terminalFailedError.dispatchState, 'dispatched', 'SDK head: terminal failure dispatchState');
    assertEqual(terminalFailedError.receipt?.status, 'failed', 'SDK head: terminal failure receipt status');
    assertEqual(
      terminalFailedError.receipt?.error,
      'harness exited before readiness',
      'SDK head: terminal failure receipt error'
    );
    assertTrue(immediateDeniedError !== undefined, 'SDK head: confirm:false denial must throw');
    assertEqual(immediateDeniedError.code, 'spawn_failed', 'SDK head: immediate denial code');
    assertEqual(
      immediateDeniedError.invocationId,
      'inv_immediate_denied',
      'SDK head: immediate denial invocationId'
    );
    assertEqual(immediateDeniedError.dispatchState, 'dispatched', 'SDK head: immediate denial dispatchState');
    assertEqual(immediateDeniedError.receipt?.status, 'denied', 'SDK head: immediate denial receipt');

    // relay#1563 P1 (this fix): dispatchState must come from the ack's real
    // route evidence, not a hardcoded 'dispatched'. A pending ack with a null
    // dispatchedNodeId/handlerNodeId proves the CLI's `not_dispatched` shape;
    // an ack that carries a real node id proves `dispatched` — both for a
    // confirmation timeout and for a later terminal read.
    assertTrue(noRouteUnconfirmedError !== undefined, 'SDK head: no-route unconfirmed must throw');
    assertEqual(
      noRouteUnconfirmedError.dispatchState,
      'not_dispatched',
      'SDK head: no-route unconfirmed dispatchState'
    );
    assertTrue(noRouteTerminalFailedError !== undefined, 'SDK head: no-route terminal failure must throw');
    assertEqual(
      noRouteTerminalFailedError.dispatchState,
      'not_dispatched',
      'SDK head: no-route terminal failure dispatchState'
    );
    // The routed shapes above (unprovenError/unconfirmedError/terminalFailedError)
    // already prove dispatchState === 'dispatched' when the ack carries a real
    // node id, so together these four assertions cover both shapes across
    // both outcomes.

    assertEqual(degradedRow?.controlPlane, 'offline', 'CLI head: controlPlane axis in JSON');
    assertEqual(degradedRow?.workerLiveness, 'live', 'CLI head: workerLiveness axis in JSON');
    assertEqual(
      automaticUnprovenReceipt.state,
      'failed',
      'CLI head: automatic unproven completion is terminal failure'
    );
    assertContains(prettyOutput, 'CONTROL PLANE', 'CLI head: CONTROL PLANE column in --pretty');
    assertContains(prettyOutput, 'WORKERS', 'CLI head: WORKERS column in --pretty');

    // 5. The MCP `spawn` tool now returns a typed `VerifiedSpawnError`
    // rendered as structured JSON content — `code`, `state`, `dispatchState`,
    // `invocationId`, and (where applicable) `receipt` all survive onto the
    // MCP wire, and the unconfirmed/timeout path spells out the same
    // no-blind-retry guidance as the SDK.
    const unprovenMcp = structuredSpawnError(mcp.unproven);
    assertEqual(unprovenMcp.code, 'spawn_failed', 'MCP head: unproven code');
    assertEqual(unprovenMcp.dispatchState, 'dispatched', 'MCP head: unproven dispatchState');
    assertEqual(unprovenMcp.invocationId, 'inv-relayflow-1563-unproven', 'MCP head: unproven invocationId');
    assertEqual(unprovenMcp.receipt?.output?.ready, false, 'MCP head: unproven receipt output.ready');

    const unconfirmedMcp = structuredSpawnError(mcp.unconfirmed);
    assertEqual(unconfirmedMcp.code, 'spawn_unconfirmed', 'MCP head: unconfirmed code');
    assertContains(unconfirmedMcp.message ?? '', 'Do not retry blindly', 'MCP head: unconfirmed message');

    const failedMcp = structuredSpawnError(mcp.failed);
    assertEqual(failedMcp.code, 'spawn_failed', 'MCP head: failed code');
    assertEqual(failedMcp.dispatchState, 'dispatched', 'MCP head: failed dispatchState');
    assertEqual(failedMcp.message, 'harness exited before readiness', 'MCP head: failed safe outer message');
    assertEqual(failedMcp.receipt?.status, 'failed', 'MCP head: failed receipt status');
    assertEqual(
      failedMcp.receipt?.invocationId,
      'inv-relayflow-1563-failed',
      'MCP head: failed receipt invocationId'
    );
    assertEqual(failedMcp.receipt?.error, undefined, 'MCP head: failed receipt must not restore raw error');
    assertEqual(
      failedMcp.receipt?.output,
      undefined,
      'MCP head: failed receipt must not expose non-allowlisted output'
    );

    // relay#1563 Medium (this fix): dispatchState must be preserved from the
    // original ack, not recomputed from a later invocation record whose
    // status alone changed. The ack here was `pending` with no node id; the
    // later terminal `failed` read also carries no node id, so dispatchState
    // must stay `not_dispatched`, never manufactured as `dispatched`.
    const noRouteFailedMcp = structuredSpawnError(mcp.noRouteFailed);
    assertEqual(noRouteFailedMcp.code, 'spawn_failed', 'MCP head: no-route failed code');
    assertEqual(
      noRouteFailedMcp.dispatchState,
      'not_dispatched',
      'MCP head: no-route failed dispatchState must not be manufactured from the later record'
    );

    await writeResult({
      outcome: 'fixed',
      signature: 'invocation_state_lifecycle_closed',
      details:
        'The head SDK rejects a terminal "completed" invocation lacking explicit spawned:true/ready:true ' +
        'proof as spawn_failed while preserving invocationId, dispatchState, and the structured receipt; ' +
        'the unconfirmed-timeout path keeps the same evidence and states "do not retry blindly"; and ' +
        'fleet agent list JSON/--pretty report controlPlane and workerLiveness as independent axes. The SDK ' +
        'also rejects terminal denied acknowledgements with confirm:false while retaining invocationId/' +
        'receipt correlation; and the MCP spawn tool mirrors every one of those: its structured error result carries code/state/dispatchState/' +
        'invocationId/receipt over the real MCP protocol, backed by the real @relaycast/sdk action-invocation ' +
        'wire contract.',
    });
  }

  process.stdout.write(
    `${arm === 'base' ? 'invocation_state_lifecycle_gaps' : 'invocation_state_lifecycle_closed'}\n`
  );
} finally {
  if (actionsServer) await new Promise((resolve) => actionsServer.close(resolve));
  await rm(proofDir, { recursive: true, force: true }).catch(() => undefined);
}

function structuredSpawnError(toolResult) {
  if (!toolResult?.isError) {
    throw new Error(`Expected an MCP error result, received ${JSON.stringify(toolResult)}.`);
  }
  const structured = toolResult.structuredContent?.error;
  if (!structured) {
    throw new Error(
      `Expected structuredContent.error on the MCP result, received ${JSON.stringify(toolResult)}.`
    );
  }
  return structured;
}

async function writeResult({ outcome, signature, details }) {
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
}

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}
function isWithin(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
