#!/usr/bin/env node
// @ts-check
/**
 * Production node-providers smoke — synthetic monitoring of the deployed engine.
 *
 * Drives the node-providers model end to end against a LIVE, already-deployed
 * engine (default `cast.agentrelay.com`), self-minting a throwaway workspace so
 * no repository secrets are required and no real workspace is touched:
 *
 *   1. create a throwaway workspace
 *   2. `node up` — Rust broker provider + TS capability provider on one node
 *   3. GET /v1/nodes shows the node online with BOTH providers and correct kinds
 *   4. a second, HTTP-only caller invokes the node-addressed action to completion
 *      with a byte-exact echo round-trip
 *   5. the handler's `ctx.relay.sendMessage` lands in channel history (node-token
 *      message route)
 *   6. on `node up` teardown the node goes offline (per-provider liveness)
 *   7. the throwaway workspace is deleted
 *
 * Unlike `tests/e2e/fleet` (which boots a local engine as a per-PR gate), this
 * runs against whatever is deployed and is scheduled, not a merge gate. It fails
 * loudly (non-zero exit) and always tears down — the workspace id is logged so a
 * failed auto-cleanup is manually recoverable.
 *
 * Run: `npm run smoke:prod` (after `npm run build:core` + a broker build).
 * Params (env): PROD_SMOKE_BASE_URL, PROD_SMOKE_TIMEOUT_MS, BROKER_BINARY_PATH.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const CLI_ENTRY = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'cli', 'index.js');
const NODE_DEF = path.join(HERE, 'agent-relay.ts');
const REDACT_MODULE = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'cli', 'lib', 'redact.js');

const BASE_URL = (process.env.PROD_SMOKE_BASE_URL ?? 'https://cast.agentrelay.com').replace(/\/+$/, '');
const ONLINE_TIMEOUT_MS = Number(process.env.PROD_SMOKE_TIMEOUT_MS ?? 60_000);
const NODE_NAME = 'prod-smoke-node';
const ACTION = 'hello-prod';
const CHANNEL = 'prod-smoke';

// ---------------------------------------------------------------------------
// Output — token material never reaches a log. Structured response bodies go
// through the shipped structural redactor (credential-named keys → [redacted]);
// free-form text (the broker's own stdout, which echoes `--workspace-key …`) is
// scrubbed by token scheme. Nothing logs a slice of a live token, not even a
// prefix — the workspace id (non-secret) is the recoverable handle we print.
// ---------------------------------------------------------------------------
/** @type {<T>(v: T) => T} */
let redactSecrets = (v) => v;

/** Scrub credential material from free-form text, keeping only the scheme tag. */
const scrub = (text) =>
  String(text).replace(/(rk_live_|at_live_|nt_live_|ot_live_|ocl_node_enr_|br_)[A-Za-z0-9_-]+/g, '$1…');

const stamp = () => new Date().toISOString().slice(11, 23);
/** @param {string} msg */
const log = (msg) => console.log(`[${stamp()}] ${scrub(msg)}`);
/** @param {string} msg */
const fail = (msg) => console.error(`[${stamp()}] ✗ ${scrub(msg)}`);
/** @param {string} msg */
const pass = (msg) => console.log(`[${stamp()}] ✓ ${scrub(msg)}`);
/** Pretty-print a response body with credential fields structurally redacted. */
const show = (body) => scrub(JSON.stringify(redactSecrets(body), null, 2));

class SmokeError extends Error {}
/** @param {unknown} cond @param {string} msg */
function assert(cond, msg) {
  if (!cond) throw new SmokeError(msg);
}

/** Canonical JSON (recursively key-sorted) for order-insensitive value equality. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * HTTP against the deployed engine.
 * @param {string} method
 * @param {string} pathname
 * @param {{ token?: string; body?: unknown }} [opts]
 * @returns {Promise<{ status: number; body: any }>}
 */
async function req(method, pathname, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { _raw: text };
  }
  return { status: res.status, body };
}

/**
 * Poll `fn` until it returns a truthy value or the deadline elapses.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ timeoutMs: number; intervalMs?: number; desc: string }} o
 * @returns {Promise<T>}
 */
async function pollUntil(fn, o) {
  const deadline = Date.now() + o.timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(o.intervalMs ?? 1000);
  }
  throw new SmokeError(`timed out after ${o.timeoutMs}ms waiting for ${o.desc}`);
}

/** Locate the built broker binary, mirroring the fleet harness resolution order. */
function resolveBrokerBinary() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    process.env.BROKER_BINARY_PATH,
    process.env.AGENT_RELAY_BIN,
    path.join(REPO_ROOT, 'target', 'release', `agent-relay-broker${ext}`),
    path.join(REPO_ROOT, 'target', 'debug', `agent-relay-broker${ext}`),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(/** @type {string} */ (p))) ?? null;
}

/**
 * One `agent-relay node up` host (broker provider + TS capability provider),
 * hermetic: ambient RELAY_* / AGENT_RELAY_* are never inherited (env is built
 * from scratch), with its own HOME, project dir, and state dir. The broker
 * self-mints the node token from the workspace key (no pre-enrollment).
 */
class NodeUp {
  /** @param {{ workspaceKey: string; brokerBinary: string; tmpRoot: string }} o */
  constructor(o) {
    this.o = o;
    this.projectDir = path.join(o.tmpRoot, 'node');
    this.home = path.join(o.tmpRoot, 'home');
    this.stateDir = path.join(this.projectDir, '.agentworkforce', 'relay');
    mkdirSync(this.stateDir, { recursive: true });
    mkdirSync(this.home, { recursive: true });
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null;
    this.logBuf = '';
  }

  start() {
    // `node up` discovers `agent-relay.{ts,…}` at the resolved PROJECT ROOT
    // (findProjectRoot walks up to .git/package.json/etc.), so a definition that
    // lives outside that root is silently NOT served. Pass `--config` to point at
    // it explicitly AND pin AGENT_RELAY_PROJECT to the hermetic project dir so the
    // broker's node identity + state stay isolated from the surrounding repo.
    this.child = spawn(
      process.execPath,
      [CLI_ENTRY, 'node', 'up', '--config', NODE_DEF, '--broker-name', NODE_NAME, '--no-spawn'],
      {
        cwd: REPO_ROOT,
        env: {
          PATH: process.env.PATH,
          HOME: this.home,
          LANG: process.env.LANG,
          TMPDIR: process.env.TMPDIR,
          BROKER_BINARY_PATH: this.o.brokerBinary,
          RELAY_BASE_URL: BASE_URL,
          RELAYCAST_BASE_URL: BASE_URL,
          RELAY_WORKSPACE_KEY: this.o.workspaceKey,
          RELAY_API_KEY: this.o.workspaceKey,
          AGENT_RELAY_PROJECT: this.projectDir,
          AGENT_RELAY_STATE_DIR: this.stateDir,
          AGENT_RELAY_TELEMETRY_DISABLED: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const record = (d) => {
      this.logBuf += d.toString();
    };
    this.child.stdout?.on('data', record);
    this.child.stderr?.on('data', record);
  }

  /** Redacted recent output, for failure diagnostics. */
  get log() {
    return scrub(this.logBuf);
  }

  /** Kill the broker (by connection.json pid) then the `node up` child. */
  async stop() {
    const connPath = path.join(this.stateDir, 'connection.json');
    try {
      const conn = JSON.parse(readFileSync(connPath, 'utf-8'));
      if (typeof conn.pid === 'number') {
        try {
          process.kill(conn.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* no connection file */
    }
    if (this.child) {
      const child = this.child;
      this.child = null;
      await new Promise((resolve) => {
        child.once('exit', () => resolve(undefined));
        child.kill('SIGKILL');
        setTimeout(() => resolve(undefined), 3000);
      });
    }
    await sleep(500);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // Preflight — this is a monitor, so a missing build is a loud failure, not a skip.
  assert(existsSync(CLI_ENTRY), `relay CLI not built (${CLI_ENTRY}); run \`npm run build:core\``);
  assert(existsSync(NODE_DEF), `node definition missing (${NODE_DEF})`);
  const brokerBinary = resolveBrokerBinary();
  assert(
    brokerBinary,
    'agent-relay-broker binary not found; set BROKER_BINARY_PATH or `cargo build --release --bin agent-relay-broker`'
  );
  if (existsSync(REDACT_MODULE)) {
    ({ redactSecrets } = await import(pathToFileUrl(REDACT_MODULE)));
  }

  log(`Target engine: ${BASE_URL}`);
  const health = await req('GET', '/health');
  assert(health.status === 200, `engine /health not OK (status ${health.status})`);
  pass(`engine reachable (/health ${health.status})`);

  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'prod-smoke-'));
  /** @type {{ workspaceKey?: string; workspaceId?: string; node?: NodeUp }} */
  const state = {};

  const teardown = async () => {
    if (state.node) {
      try {
        await state.node.stop();
        log('node up stopped');
      } catch (err) {
        fail(`node up stop failed: ${String(err)}`);
      }
      state.node = undefined;
    }
    if (state.workspaceKey) {
      try {
        const del = await req('DELETE', '/v1/workspace', { token: state.workspaceKey });
        if (del.status === 204 || del.status === 200) {
          log(`throwaway workspace deleted (id ${state.workspaceId})`);
        } else {
          fail(`workspace DELETE returned ${del.status} — MANUALLY DELETE workspace id ${state.workspaceId}`);
        }
      } catch (err) {
        fail(`workspace DELETE failed (${String(err)}) — MANUALLY DELETE workspace id ${state.workspaceId}`);
      }
      state.workspaceKey = undefined;
    }
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  // Trap: signals run teardown then exit non-zero. try/finally covers failures.
  let signalled = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (signalled) return;
      signalled = true;
      fail(`received ${sig} — tearing down`);
      teardown().finally(() => process.exit(1));
    });
  }

  try {
    // 1) Throwaway workspace (no auth). Log the id BEFORE anything else can fail,
    //    so a crash leaves a recoverable trail.
    const wsName = `prod-smoke-${Date.now()}`;
    const ws = await req('POST', '/v1/workspaces', { body: { name: wsName } });
    assert(ws.status < 300 && ws.body?.ok, `workspace create failed (${ws.status}): ${show(ws.body)}`);
    state.workspaceKey = ws.body.data.api_key;
    state.workspaceId = ws.body.data.workspace_id;
    const workspaceKey = /** @type {string} */ (state.workspaceKey);
    assert(workspaceKey?.startsWith('rk_live_'), 'workspace key missing or wrong scheme');
    log(`workspace created: id=${state.workspaceId} (name ${wsName})`);

    // 2) node up — broker provider + TS capability provider on one node.
    const node = new NodeUp({ workspaceKey, brokerBinary, tmpRoot });
    state.node = node;
    node.start();
    log('node up started; waiting for both providers to attach…');

    // 3) Node online with BOTH providers and correct kinds.
    const online = await pollUntil(
      async () => {
        if (node.child === null) throw new SmokeError(`node up exited early:\n${node.log}`);
        const { body } = await req('GET', `/v1/nodes?name=${NODE_NAME}`, { token: workspaceKey });
        const n = body?.data?.[0];
        if (!n || n.status !== 'online' || !n.live) return null;
        const caps = n.capabilities ?? [];
        const hasAction = caps.some((c) => c.name === ACTION && c.kind === 'action');
        const hasCapacity = caps.some((c) => c.kind === 'capacity');
        return hasAction && hasCapacity ? n : null;
      },
      { timeoutMs: ONLINE_TIMEOUT_MS, desc: 'node online with both providers' }
    );
    const capNames = (kind) => online.capabilities.filter((c) => c.kind === kind).map((c) => c.name);
    assert(online.handlers_live === true, `expected handlers_live=true, got ${online.handlers_live}`);
    pass(
      `node "${online.name}" (${online.id}) online, handlers_live=true; ` +
        `capacity=[${capNames('capacity').join(', ')}] action=[${capNames('action').join(', ')}]`
    );

    // 4) Second caller (HTTP only) — register an agent, invoke, poll to completed.
    const agentReg = await req('POST', '/v1/agents', {
      token: workspaceKey,
      body: { name: 'prod-smoke-caller', type: 'agent' },
    });
    assert(agentReg.status < 300, `agent register failed (${agentReg.status}): ${show(agentReg.body)}`);
    const agentToken = agentReg.body.data.token ?? agentReg.body.data.agent_token;
    assert(agentToken?.startsWith('at_live_'), 'agent token missing or wrong scheme');
    log('caller agent registered: name=prod-smoke-caller');

    const sentEcho = { marker: `echo-${Date.now()}`, nested: { n: 42 }, list: [1, 2, 3] };
    const invoke = await req('POST', `/v1/nodes/${NODE_NAME}/actions/${ACTION}/invoke`, {
      token: agentToken,
      body: { input: { echo: sentEcho } },
    });
    assert(invoke.status < 300, `invoke failed (${invoke.status}): ${show(invoke.body)}`);
    const invId = invoke.body.data.invocation_id;
    assert(invId, `invoke returned no invocation_id: ${show(invoke.body)}`);
    log(`invoked ${ACTION} on ${NODE_NAME}: invocation ${invId} (${invoke.body.data.status})`);

    const done = await pollUntil(
      async () => {
        const { body } = await req('GET', `/v1/actions/${ACTION}/invocations/${invId}`, {
          token: agentToken,
        });
        const inv = body?.data;
        if (!inv) return null;
        if (inv.status === 'completed') return inv;
        if (inv.status === 'failed') throw new SmokeError(`invocation failed: ${show(inv)}`);
        return null;
      },
      { timeoutMs: 30_000, desc: 'invocation completed' }
    );
    assert(done.output?.ok === true, `expected output.ok=true, got: ${show(done.output)}`);
    assert(
      canonical(done.output.echo) === canonical(sentEcho),
      `echo NOT byte-exact — sent ${canonical(sentEcho)} got ${canonical(done.output?.echo)}`
    );
    assert(done.caller_name === 'prod-smoke-caller', `unexpected caller_name ${done.caller_name}`);
    pass(`remote invoke completed with byte-exact echo round-trip (caller prod-smoke-caller)`);

    // 5) ctx.relay.sendMessage — node-token message route → channel history.
    const chan = await req('POST', '/v1/channels', {
      token: workspaceKey,
      body: { name: CHANNEL, topic: 'production node-providers smoke' },
    });
    assert(chan.status < 300, `channel create failed (${chan.status}): ${show(chan.body)}`);
    const notifyMarker = `notify-${Date.now()}`;
    const notifyInvoke = await req('POST', `/v1/nodes/${NODE_NAME}/actions/${ACTION}/invoke`, {
      token: agentToken,
      body: {
        input: { echo: { marker: notifyMarker }, notify: { channel: CHANNEL, from: 'prod-smoke-caller' } },
      },
    });
    assert(
      notifyInvoke.status < 300,
      `notify invoke failed (${notifyInvoke.status}): ${show(notifyInvoke.body)}`
    );
    const notifyId = notifyInvoke.body.data.invocation_id;
    await pollUntil(
      async () => {
        const { body } = await req('GET', `/v1/actions/${ACTION}/invocations/${notifyId}`, {
          token: agentToken,
        });
        const inv = body?.data;
        if (inv?.status === 'completed') return inv;
        if (inv?.status === 'failed') throw new SmokeError(`notify invocation failed: ${show(inv)}`);
        return null;
      },
      { timeoutMs: 30_000, desc: 'notify invocation completed' }
    );
    const history = await req('GET', `/v1/channels/${CHANNEL}/messages`, { token: workspaceKey });
    const messages = Array.isArray(history.body?.data)
      ? history.body.data
      : (history.body?.data?.messages ?? []);
    const landed = messages.find((m) => typeof m.text === 'string' && m.text.includes(notifyMarker));
    assert(landed, `handler message not found in #${CHANNEL} history: ${show(messages)}`);
    const fromName = landed.from_name ?? landed.sender_name ?? landed.from ?? landed.agent_name;
    assert(
      fromName === 'prod-smoke-caller',
      `handler message attributed to ${fromName}, expected prod-smoke-caller`
    );
    pass(`ctx.sendMessage landed in #${CHANNEL} attributed to prod-smoke-caller`);

    // 6) Teardown liveness — stopping node up drops the node offline.
    await node.stop();
    state.node = undefined;
    await pollUntil(
      async () => {
        const { body } = await req('GET', `/v1/nodes?name=${NODE_NAME}`, { token: workspaceKey });
        const n = body?.data?.[0];
        return n && n.status === 'offline' && n.live === false && n.handlers_live === false ? n : null;
      },
      { timeoutMs: 30_000, desc: 'node offline after teardown' }
    );
    pass('node went offline after node up teardown (per-provider liveness)');

    log('ALL CHECKS PASSED');
  } catch (err) {
    // Surface the (redacted) node up output to CI stdout before teardown wipes
    // the temp dir — the buffered broker/provider log is the first thing to read.
    if (state.node) fail(`node up output (redacted):\n${state.node.log}`);
    throw err;
  } finally {
    await teardown();
  }
}

/** Node import() needs a file:// URL for absolute paths on Windows. */
function pathToFileUrl(p) {
  return new URL(`file://${path.resolve(p)}`).href;
}

main()
  .then(() => {
    log('prod-smoke: PASS');
    process.exit(0);
  })
  .catch((err) => {
    fail(`prod-smoke: FAIL — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
