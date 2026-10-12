#!/usr/bin/env node
// The Node relay daemon: one per user, started detached by `connect join`
// under the Node that is already running npx. It serves the /connect/*
// routes on a 0600 Unix socket, polls Relaycast for each joined Connect,
// injects into the session, and exits once no Connect is left.

import { constants } from 'node:fs';
import { chmod, open, readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ConnectError, ConnectService } from './connect.js';
import { VERSION } from './cloud.js';
import { privateDirectory, relayPaths } from './paths.js';
import { RelayState } from './state.js';

export const POLL_MS = 3_000;
export const IDLE_AFTER_LAST_MS = 60_000;
export const IDLE_NEVER_USED_MS = 15 * 60_000;
const MAX_BODY_BYTES = 1_000_000;
const TARGET = /^(claude|codex):([A-Za-z0-9][A-Za-z0-9_-]{7,63})$/;

function log(line) {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** The reply command shown above an injected message: this runtime's CLI, under this Node. */
export function replyHintFor(sender, nodePath = process.execPath, cliPath = fileURLToPath(new URL('../cli.js', import.meta.url))) {
  return `[reply: printf '%s' 'your reply' | ${shellQuote(nodePath)} ${shellQuote(cliPath)} send --to ${shellQuote(sender)}]`;
}

function respond(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ConnectError(413, 'too_large', 'The request is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function targetOf(request) {
  const match = TARGET.exec(String(request.headers['x-agent-relay-target'] || ''));
  if (!match) {
    throw new ConnectError(403, 'not_a_relay_session', 'This command is not running inside a supported live Agent Relay session.');
  }
  return { kind: match[1], id: match[2] };
}

/** Takes the single-instance lock, replacing a stale one. Resolves a release function or null. */
async function acquireLock(path) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return async () => {
        const owner = await readFile(path, 'utf8').catch(() => '');
        if (owner.trim() === String(process.pid)) await rm(path, { force: true });
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const owner = Number.parseInt(await readFile(path, 'utf8').catch(() => ''), 10);
      let alive = false;
      if (Number.isInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0);
          alive = true;
        } catch (killError) {
          alive = killError?.code === 'EPERM';
        }
      }
      if (alive) return null;
      await rm(path, { force: true });
    }
  }
  return null;
}

export async function startDaemon({ home = os.homedir(), env = process.env, injector, fetchImpl, now = Date.now } = {}) {
  const paths = relayPaths(home);
  await privateDirectory(paths.root);
  await privateDirectory(paths.run);
  const release = await acquireLock(paths.lock);
  if (!release) {
    const error = new Error('Another Agent Relay Connect relay is already running for this user.');
    error.code = 'already_running';
    throw error;
  }

  const state = await RelayState.load(paths.state, { now });
  let everUsed = state.sessions().length > 0;
  let lastActiveAt = now();
  const service = new ConnectService({
    state,
    injector: injector || (await import('./injector.js')).createInjector({ home, env, platform: process.platform }),
    log,
    env,
    now,
    fetchImpl,
    replyHint: (sender) => replyHintFor(sender),
    onChange: () => {
      if (state.sessions().length) everUsed = true;
      schedule(0);
    },
  });

  let timer = null;
  let polling = false;
  let stopped = false;
  const schedule = (delay = POLL_MS) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, delay);
    timer.unref?.();
  };
  const busy = () => state.sessions().length > 0 || state.data.notices.length > 0;
  async function tick() {
    timer = null;
    if (stopped) return;
    if (!polling) {
      polling = true;
      try {
        await service.pollAll();
      } catch (error) {
        log(`relay connect poll failed cause=${error?.code || error?.name || 'error'}`);
      } finally {
        polling = false;
      }
    }
    if (busy()) {
      lastActiveAt = now();
    } else if (now() - lastActiveAt >= (everUsed ? IDLE_AFTER_LAST_MS : IDLE_NEVER_USED_MS)) {
      log('relay connect idle; exiting');
      await stop();
      return;
    }
    schedule();
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://relay');
      const route = `${request.method} ${url.pathname}`;
      if (route === 'GET /health') {
        respond(response, 200, { ok: true, data: { version: VERSION, pid: process.pid, sessions: state.sessions().length } });
        return;
      }
      if (route === 'POST /shutdown') {
        if (busy() && url.searchParams.get('force') !== '1') {
          throw new ConnectError(409, 'relay_busy', 'The relay still has an active Connect.');
        }
        respond(response, 200, { ok: true, data: { stopping: true } });
        setImmediate(() => stop());
        return;
      }
      const target = targetOf(request);
      const body = await readBody(request);
      let data;
      if (route === 'POST /connect/join') {
        let fields;
        try {
          fields = JSON.parse(body.toString('utf8') || '{}');
        } catch {
          throw new ConnectError(400, 'invalid_request', 'The body must be JSON.');
        }
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
          throw new ConnectError(400, 'invalid_request', 'The body must be a JSON object.');
        }
        data = await service.join(target, fields);
      } else if (route === 'POST /connect/send') {
        const to = url.searchParams.getAll('to');
        if (to.length > 1) throw new ConnectError(400, 'invalid_request', 'Use at most one to.');
        let text;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(body);
        } catch {
          throw new ConnectError(400, 'invalid_text', 'The message must be non-empty UTF-8 text.');
        }
        data = await service.send(target, text, {
          to: to[0],
          requestKey: String(request.headers['x-agent-relay-request'] || '') || undefined,
        });
      } else if (route === 'GET /connect/status') {
        data = await service.status(target);
      } else if (route === 'POST /connect/leave') {
        data = await service.leave(target);
      } else {
        throw new ConnectError(404, 'not_found', 'Unknown route.');
      }
      lastActiveAt = now();
      respond(response, 200, { ok: true, data });
    } catch (error) {
      const status = error instanceof ConnectError ? error.status : 500;
      const code = error instanceof ConnectError ? error.code : 'relay_error';
      const message = error instanceof ConnectError ? error.message : 'The relay could not handle this request.';
      if (!(error instanceof ConnectError)) log(`relay connect route failed cause=${error?.code || error?.name || 'error'}`);
      respond(response, status, { ok: false, error: { code, message } });
    }
  });

  // A socket left by a relay that died is replaced; the lock says it is ours.
  await rm(paths.socket, { force: true });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.socket, resolve);
  });
  await chmod(paths.socket, 0o600);
  const socketInfo = await stat(paths.socket);

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    await new Promise((resolve) => server.close(() => resolve()));
    try {
      const current = await stat(paths.socket);
      if (current.ino === socketInfo.ino) await rm(paths.socket, { force: true });
    } catch {
      // Already gone.
    }
    await release();
    stopResolve();
  }
  let stopResolve;
  const stopped$ = new Promise((resolve) => {
    stopResolve = resolve;
  });

  log(`relay connect started version=${VERSION} pid=${process.pid} sessions=${state.sessions().length}`);
  schedule(0);
  return { socket: paths.socket, stop, stopped: stopped$, service, state };
}

async function main() {
  let daemon;
  try {
    daemon = await startDaemon();
  } catch (error) {
    const message = error?.message || String(error);
    log(`relay connect failed to start: ${message}`);
    if (process.send) process.send({ type: 'error', code: error?.code || 'start_failed', message });
    process.exitCode = error?.code === 'already_running' ? 0 : 1;
    process.disconnect?.();
    return;
  }
  if (process.send) {
    process.send({ type: 'ready', version: VERSION, socket: daemon.socket, pid: process.pid });
    process.disconnect?.();
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => daemon.stop());
  }
  await daemon.stopped;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
