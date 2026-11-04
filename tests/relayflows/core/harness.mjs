// A throwaway machine for driving Relay the way a person does: the built CLI's
// `relay init`, the core it starts, and the local Relaycast server it runs.
//
// Scenarios use only public surfaces: the CLI, the core's bridge socket, and the
// files and hooks each agent tool reads. They survive the core being replaced.
//
// Nothing here may reach the person's own Relay. HOME, the socket and every
// tool's folder live in a fresh directory, the environment is built from
// nothing, and `assertLocalOnly` fails a run that touched a hosted service.

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = path.join(repoRoot, 'packages/cli/dist/cli/index.js');
const engineCache = path.join(os.tmpdir(), `relay-core-lane-${process.getuid()}`);
const engineFile = 'relaycast-engine';
const BRIDGE_VERSION = 2;

/** The PR-built core from `prepare-core.mjs`, else undefined: `relay init` installs the pinned release. */
function builtCore() {
  const configured = process.env.RELAY_CORE_BIN?.trim();
  if (configured) return path.resolve(configured);
  const prepared = path.join(repoRoot, '.workflow-artifacts/core/agent-relay-node');
  return fs.existsSync(prepared) ? prepared : undefined;
}

export const TOOLS = ['claude', 'codex', 'opencode', 'grok', 'pi', 'devin', 'cursor'];

const HOSTED = /cast\.agentrelay\.com|(?:^|[/.])agentrelay\.com|posthog\.com/;

/** Polls until `read` returns something truthy. */
export async function waitFor(what, read, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * A Node built against a shared `libnode` (Homebrew's) looks for it in `../lib`
 * beside its executable, so a copy needs that library beside it too. A
 * self-contained Node, as CI uses, has none to copy.
 */
function provideNodeLibrary(root) {
  const library = path.join(path.dirname(process.execPath), '..', 'lib');
  if (!fs.existsSync(library)) return;
  for (const file of fs.readdirSync(library).filter((name) => /^libnode\..*(dylib|so)/.test(name))) {
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    const target = path.join(root, 'lib', file);
    if (!fs.existsSync(target)) fs.copyFileSync(path.join(library, file), target);
  }
}

/** A process running under the sandbox's HOME, whose output is kept. */
export class SandboxProcess {
  constructor(child, label) {
    this.child = child;
    this.label = label;
    this.output = '';
    child.stdout?.on('data', (data) => (this.output += data));
    child.stderr?.on('data', (data) => (this.output += data));
  }

  /** Stops it; a sandbox never leaves a process behind. */
  stop() {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
  }
}

export class Sandbox {
  constructor(root, port) {
    this.root = root;
    this.port = port;
    this.home = path.join(root, 'h');
    this.project = path.join(root, 'p');
    this.bin = path.join(root, 'b');
    this.tmp = path.join(root, 't');
    this.socket = path.join(this.home, '.agentworkforce/desktop/core.sock');
    this.relayHome = path.join(this.home, '.agentworkforce/relay');
    this.processes = [];
    this.env = {
      HOME: this.home,
      USERPROFILE: this.home,
      PATH: `${this.bin}:/usr/bin:/bin`,
      TMPDIR: this.tmp,
      AGENT_RELAY_CORE_SOCKET: this.socket,
      AGENT_RELAY_TELEMETRY_DISABLED: '1',
      AGENT_RELAY_DISABLE_UPDATE_CHECK: '1',
      // The core keeps temporary folders out of automatic activation, and this is one.
      AGENT_RELAY_AUTO_ACTIVATE_EXCLUDED_DIRS: '/var/empty',
      // Exactly this Codex, so the core neither needs nor finds a real one.
      RELAY_DESKTOP_CODEX: path.join(repoRoot, 'tests/relayflows/core/fake-codex.mjs'),
      NO_COLOR: '1',
      CI: '1',
    };
    const core = builtCore();
    if (core) this.env.AGENT_RELAY_NODE_PATH = core;
  }

  path(...segments) {
    return path.join(this.home, ...segments);
  }

  read(...segments) {
    return fs.readFileSync(this.path(...segments), 'utf8');
  }

  exists(...segments) {
    return fs.existsSync(this.path(...segments));
  }

  write(relative, contents) {
    const file = this.path(relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return file;
  }

  /** Marks a tool as run on this machine, the way the core detects it. */
  markInstalled(tool) {
    const folders = {
      claude: ['.claude'],
      codex: ['.codex'],
      opencode: ['.config/opencode'],
      grok: ['.grok'],
      pi: ['.pi/agent'],
      devin: ['.local/share/devin', '.config/devin'],
      cursor: ['.cursor'],
    };
    for (const folder of folders[tool]) fs.mkdirSync(this.path(folder), { recursive: true });
    if (tool === 'cursor') this.write('.cursor/cli-config.json', '{}\n');
  }

  /** Runs the built CLI in the project, returning its output whatever it exits with. */
  relay(args, { timeoutMs = 180_000 } = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd: this.project,
        env: this.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (data) => (output += data));
      child.stderr.on('data', (data) => (output += data));
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
  }

  /** Runs the CLI and fails the scenario when it fails. */
  async relayOk(args, options) {
    const result = await this.relay(args, options);
    assert.equal(result.code, 0, `relay ${args.join(' ')} failed:\n${result.output}`);
    return result.output;
  }

  init(tools) {
    return this.relayOk(['init', '--tools', tools.join(','), '--port', String(this.port)]);
  }

  /** One round trip on the core's bridge. */
  call(method, params) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socket);
      const pending = new Map();
      let buffer = '';
      let id = 0;
      const send = (name, body, settle) => {
        id += 1;
        pending.set(id, settle);
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: name, params: body })}\n`);
      };
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`${method} timed out`));
      }, 15_000);
      const finish = (settle, value) => {
        clearTimeout(timer);
        socket.end();
        settle(value);
      };
      socket.setEncoding('utf8');
      socket.on('error', (error) => finish(reject, error));
      socket.on('connect', () =>
        send('hello', { bridge_version: BRIDGE_VERSION }, () =>
          send(method, params ?? {}, (reply) =>
            reply.error
              ? finish(reject, new Error(reply.error.message ?? JSON.stringify(reply.error)))
              : finish(resolve, reply.result)
          )
        )
      );
      socket.on('data', (data) => {
        buffer += data;
        for (;;) {
          const end = buffer.indexOf('\n');
          if (end < 0) break;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          const reply = JSON.parse(line);
          const settle = pending.get(reply.id);
          if (settle) {
            pending.delete(reply.id);
            settle(reply);
          }
        }
      });
    });
  }

  /** Starts a process that dies with the sandbox. */
  spawn(file, args, label, options = {}) {
    const running = new SandboxProcess(
      spawn(file, args, {
        cwd: this.project,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...options,
      }),
      label
    );
    this.processes.push(running);
    return running;
  }

  /** Starts a process named `name` that holds `files` open, for the core to discover. */
  fakeTool(name, files) {
    const executable = path.join(this.bin, name);
    if (!fs.existsSync(executable)) {
      fs.copyFileSync(process.execPath, executable);
      // The core refuses a tool's binary that anyone else could write to.
      fs.chmodSync(executable, 0o755);
      provideNodeLibrary(this.root);
      const check = spawnSync(executable, ['-e', ''], { encoding: 'utf8' });
      if (check.status !== 0) {
        throw new Error(
          `A copy of ${process.execPath} cannot run as ${name}, so no session can be faked. ` +
            `Use a self-contained Node, such as the official build.\n${check.stderr}`
        );
      }
    }
    return this.spawn(
      executable,
      [path.join(repoRoot, 'tests/relayflows/core/fake-tool.mjs'), ...files],
      name
    );
  }

  /** The agents the core has registered on this machine. */
  async agents() {
    const listed = await this.call('agents.list');
    return Array.isArray(listed) ? listed : (listed.agents ?? []);
  }

  /** Fails unless everything stayed on this machine. */
  async assertLocalOnly() {
    const status = await this.call('status.get');
    const origin = status.workspace?.origin ?? status.workspace?.relaycast_url ?? '';
    assert.match(JSON.stringify(status.workspace ?? {}), /127\.0\.0\.1|localhost/, 'workspace is not local');
    assert.doesNotMatch(String(origin), HOSTED);
    const log = path.join(this.relayHome, 'local/core.log');
    if (fs.existsSync(log)) {
      assert.doesNotMatch(fs.readFileSync(log, 'utf8'), HOSTED, 'the core log names a hosted service');
    }
  }

  /** Prints what the core saw, for a failed scenario. Keys never appear in these. */
  async report() {
    const log = path.join(this.relayHome, 'local/core.log');
    for (const method of ['sessions.list', 'agents.list']) {
      const seen = await this.call(method).catch((error) => error.message);
      console.error(`${method}: ${JSON.stringify(seen).slice(0, 2000)}`);
    }
    if (fs.existsSync(log)) console.error(fs.readFileSync(log, 'utf8').slice(-2000));
  }

  /** Stops everything this sandbox started and removes it. */
  async dispose() {
    for (const running of this.processes) running.stop();
    if (fs.existsSync(cli))
      await this.relay(['init', '--stop'], { timeoutMs: 30_000 }).catch(() => undefined);
    const engine = path.join(this.relayHome, 'bin', engineFile);
    if (fs.existsSync(engine) && !fs.existsSync(path.join(engineCache, engineFile))) {
      fs.mkdirSync(engineCache, { recursive: true, mode: 0o700 });
      fs.copyFileSync(engine, path.join(engineCache, engineFile));
    }
    fs.rmSync(this.root, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * A fresh machine. Lives directly under /tmp: the core's sockets sit beneath
 * HOME, and a Unix socket path is limited to about 100 characters.
 */
export async function createSandbox() {
  const root = fs.mkdtempSync('/tmp/rcl-');
  const sandbox = new Sandbox(root, await freePort());
  assert.notEqual(sandbox.home, os.homedir(), 'a sandbox must never be the real home');
  assert.ok(sandbox.socket.startsWith(`${root}/`), 'the core socket must stay in the sandbox');
  for (const directory of [sandbox.home, sandbox.project, sandbox.bin, sandbox.tmp]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.symlinkSync(process.execPath, path.join(sandbox.bin, 'node'));
  execFileSync('git', ['init', '-q', sandbox.project], { env: { PATH: process.env.PATH } });
  // The core's analytics opt-out, where each platform keeps it.
  const optOut = '{"analytics_enabled":false}\n';
  sandbox.write('.config/com.agentrelay.desktop/preferences.json', optOut);
  sandbox.write('Library/Application Support/com.agentrelay.desktop/preferences.json', optOut);
  const cachedEngine = path.join(engineCache, engineFile);
  if (fs.existsSync(cachedEngine)) {
    const target = path.join(sandbox.relayHome, 'bin', engineFile);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(cachedEngine, target);
  }
  return sandbox;
}

/** Runs a scenario in a fresh sandbox, disposing of it however the scenario ends. */
export async function withSandbox(run) {
  const sandbox = await createSandbox();
  try {
    return await run(sandbox);
  } catch (error) {
    await sandbox.report();
    throw error;
  } finally {
    await sandbox.dispose();
  }
}

/**
 * Reruns a scenario as an ordinary user when started as root, as a CI runner may
 * be. The core refuses to bind a Grok session owned by root, and no person runs
 * Grok as root.
 */
export function leaveRoot(script) {
  if (process.getuid() !== 0) return;
  const { status } = spawnSync(
    'setpriv',
    ['--reuid=65534', '--regid=65534', '--clear-groups', process.execPath, fileURLToPath(script)],
    { stdio: 'inherit', env: { ...process.env, HOME: '/tmp', TMPDIR: '/tmp' } }
  );
  process.exit(status ?? 1);
}

/** Runs named checks in order and prints a line for each. */
export async function scenario(name, run) {
  const started = Date.now();
  await run();
  console.log(`PASS ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}
