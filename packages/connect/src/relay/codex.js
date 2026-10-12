import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, readdirSync, realpathSync, statSync } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import { join } from 'node:path';
import { argvOf, isTrustedCodex, listProcesses, openFiles } from './processes.js';
import { queryReadOnly, sqliteBackend } from './sqlite.js';

// Codex threads and the routes a message takes into them, ported from
// relay-desktop probe/src/relay/codex.rs and codex/{router,queue,rollout,
// ipc,processes,threads}.rs.
//
// A message is delivered when the thread's rollout records it, or when a
// Codex app window that owns the thread confirms the turn. A live terminal
// Codex gets every message through its own queue (`codex queue`); that
// handoff is not delivery and stays accepted until the rollout records it.

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** queue.rs `is_thread_id` (store.rs `is_uuid`). */
export function isThreadId(value) {
  return typeof value === 'string' && UUID.test(value);
}

function outcome(kind, detail) {
  return { outcome: kind, detail };
}

// MARK: Message reference (delivery/policy.rs MessageRef)

/** The first 12 hex digits of sha256(message id). */
export function messageRef(messageId) {
  return createHash('sha256').update(String(messageId), 'utf8').digest('hex').slice(0, 12);
}

const REF = /^[0-9a-f]{12}$/;

/**
 * The reference carried by `text`, if its first line is a relay attribution
 * (`[via Agent Relay …]` or `[Relay Connect — from <sender> · ref <ref>]`).
 */
export function messageRefInText(text) {
  if (typeof text !== 'string') return null;
  if (!(text.startsWith('[via Agent Relay') || text.startsWith('[Relay Connect '))) return null;
  let first = text.split('\n', 1)[0];
  if (first.endsWith('\r')) first = first.slice(0, -1);
  if (!first.endsWith(']')) return null;
  const inner = first.slice(0, -1);
  const marker = inner.lastIndexOf('ref ');
  if (marker < 0) return null;
  const candidate = inner.slice(marker + 4);
  return REF.test(candidate) ? candidate : null;
}

// MARK: Paths and the codex binary (codex.rs)

function expand(value, home) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return join(home, value.slice(2));
  return value;
}

function setting(env, key) {
  const value = env?.[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** `{codexHome, sqliteHome, ipcSocket}`: `CODEX_HOME` else `~/.codex`; `CODEX_SQLITE_HOME` else Codex home. */
export function codexPaths({ home = os.homedir(), env = process.env } = {}) {
  const configured = setting(env, 'CODEX_HOME');
  const codexHome = configured ? expand(configured, home) : join(home, '.codex');
  const sqlite = setting(env, 'CODEX_SQLITE_HOME');
  return {
    codexHome,
    sqliteHome: sqlite ? expand(sqlite, home) : codexHome,
    ipcSocket: join(codexHome, 'ipc/ipc.sock'),
  };
}

function isExecutableFile(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A version manager's shim re-resolves `codex` per directory; only a real install is used. */
function isShim(path) {
  const shim = (value) => value.includes('/mise/shims/');
  if (shim(path)) return true;
  try {
    return shim(realpathSync(path));
  } catch {
    return false;
  }
}

function versionKey(version) {
  const trimmed = (version ?? '').replace(/^v+/, '');
  const dash = trimmed.indexOf('-');
  const release = dash < 0 ? trimmed : trimmed.slice(0, dash);
  const prerelease = dash < 0 ? '' : trimmed.slice(dash + 1);
  return {
    numbers: release.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : 0)),
    isRelease: prerelease === '',
    prerelease,
  };
}

function compareVersionKeys(a, b) {
  const length = Math.max(a.numbers.length, b.numbers.length);
  for (let index = 0; index < length; index += 1) {
    // Rust compares Vec<u64> lexicographically: a shorter prefix is smaller.
    if (index >= a.numbers.length) return -1;
    if (index >= b.numbers.length) return 1;
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  }
  if (a.isRelease !== b.isRelease) return a.isRelease ? 1 : -1;
  return a.prerelease < b.prerelease ? -1 : a.prerelease > b.prerelease ? 1 : 0;
}

/** `<root>/<version>/bin/codex` for every version directory, newest first. */
function versions(root) {
  let names = [];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, key: versionKey(name) }))
    .sort((a, b) => compareVersionKeys(b.key, a.key))
    .map(({ name }) => join(root, name, 'bin/codex'));
}

const SYSTEM_CODEX = {
  darwin: [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
  ],
  shared: ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'],
};

/**
 * Where a `codex` may be installed, in order (codex.rs
 * `executable_candidates`): the Codex desktop app's own binary, mise, the
 * user's bin, nvm installs, Homebrew, then `PATH`; never a shim.
 * `system` replaces the fixed system locations (tests).
 */
export function codexCandidates({ home = os.homedir(), env = process.env, platform = process.platform, system } = {}) {
  const apps = system ? [] : platform === 'darwin' ? SYSTEM_CODEX.darwin : [];
  const tail = system ?? SYSTEM_CODEX.shared;
  const mise = join(home, '.local/share/mise/installs/codex');
  const candidates = [
    ...apps,
    join(mise, 'latest/bin/codex'),
    join(home, '.local/bin/codex'),
    ...versions(mise),
    ...versions(join(home, '.nvm/versions/node')),
    ...tail,
  ];
  const path = env?.PATH;
  if (typeof path === 'string') {
    for (const directory of path.split(':')) {
      if (directory.startsWith('/')) candidates.push(join(directory, 'codex'));
    }
  }
  return candidates.filter((candidate) => !isShim(candidate));
}

/**
 * The `codex` to run: `RELAY_DESKTOP_CODEX` (exactly that file, or none),
 * else the first installed candidate.
 */
export function codexExecutable(options = {}) {
  const { home = os.homedir(), env = process.env } = options;
  const explicit = setting(env, 'RELAY_DESKTOP_CODEX');
  if (explicit) {
    const path = expand(explicit, home);
    return isExecutableFile(path) && !isShim(path) ? path : null;
  }
  return codexCandidates(options).find((candidate) => isExecutableFile(candidate)) ?? null;
}

// MARK: SQLite reads (threads.rs, queue.rs)

/**
 * The thread's row id in Codex's spelling (threads.rs `read_one`): missing,
 * archived and sub-agent threads are not found. `undefined` when the
 * catalog cannot be read at all.
 */
async function readThreadId(paths, id) {
  if (!isThreadId(id)) return null;
  const file = join(paths.sqliteHome, 'state_5.sqlite');
  const columns = await queryReadOnly(file, 'pragma table_info(threads)');
  if (columns.status !== 'ok') return undefined;
  const names = new Set(columns.rows.map((row) => row.name));
  if (!['id', 'title', 'archived', 'source'].every((column) => names.has(column))) return undefined;
  const found = await queryReadOnly(
    file,
    "select id from threads where id = ? collate nocase and archived = 0 and source in ('cli', 'vscode', 'exec') limit 1",
    [id],
  );
  if (found.status !== 'ok') return undefined;
  return typeof found.rows[0]?.id === 'string' ? found.rows[0].id : null;
}

/** The thread's recorded rollout path (threads.rs `rollout_column`). */
async function rolloutColumn(paths, id) {
  const found = await queryReadOnly(
    join(paths.sqliteHome, 'state_5.sqlite'),
    'select rollout_path as rollout_path from threads where id = ? collate nocase',
    [id],
  );
  if (found.status !== 'ok') return null;
  const path = found.rows[0]?.rollout_path;
  return typeof path === 'string' && path !== '' ? path : null;
}

/** The reference of a relay-created queue item (queue.rs `owned_ref`). */
export function ownedRef(payloadJson) {
  const find = (value) => {
    if (typeof value === 'string') return messageRefInText(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = find(item);
        if (found) return found;
      }
      return null;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) {
        const found = find(item);
        if (found) return found;
      }
    }
    return null;
  };
  try {
    return find(JSON.parse(payloadJson));
  } catch {
    return messageRefInText(payloadJson);
  }
}

/**
 * The relay's items `sql` selects as `(id, payload_json)`: `false`/`true`
 * for whether any matches `keep`, `null` when the queue exists but cannot
 * be read. No queue database means nothing is queued; no SQLite reader on
 * this computer reads as nothing queued too, leaving the rollout and the
 * 45 s rule to decide (docs/connect-node-local-relay.md, "SQLite").
 */
async function queueHas(paths, sql, params, keep) {
  const result = await queryReadOnly(join(paths.sqliteHome, 'queue_1.sqlite'), sql, params);
  if (result.status === 'missing' || result.status === 'unavailable') return false;
  if (result.status !== 'ok') return null;
  return result.rows.some((row) => {
    if (typeof row.payload_json !== 'string') return false;
    const owned = ownedRef(row.payload_json);
    return owned !== null && keep(owned);
  });
}

/** Whether the relay's queue item carrying `ref` still waits (queue.rs `is_waiting`). */
function queueWaiting(paths, thread, ref) {
  return queueHas(
    paths,
    'select id, payload_json from queued_items where thread_id = ? collate nocase and instr(payload_json, ?) > 0',
    [thread, `ref ${ref}]`],
    (owned) => owned === ref,
  );
}

/** Whether any relay message still waits in the thread's queue (queue.rs `relay_waiting`). */
function relayWaiting(paths, thread) {
  return queueHas(
    paths,
    'select id, payload_json from queued_items where thread_id = ? collate nocase',
    [thread],
    () => true,
  );
}

// MARK: Rollout (rollout.rs)

const MARKERS = ['"task_started"', '"task_complete"', '"turn_aborted"', '"client_id"', '"item_completed"'].map(
  (marker) => Buffer.from(marker),
);

class RolloutSummary {
  constructor() {
    this.activeTurn = null;
    this.outcomes = new Map();
    this.turnByClientMessage = new Map();
    this.turnByMessageRef = new Map();
    this.relayTurns = new Set();
  }

  clone() {
    const copy = new RolloutSummary();
    copy.activeTurn = this.activeTurn;
    copy.outcomes = new Map(this.outcomes);
    copy.turnByClientMessage = new Map(this.turnByClientMessage);
    copy.turnByMessageRef = new Map(this.turnByMessageRef);
    copy.relayTurns = new Set(this.relayTurns);
    return copy;
  }

  consume(line) {
    if (!MARKERS.some((marker) => line.includes(marker))) return;
    let row;
    try {
      row = JSON.parse(line.toString('utf8'));
    } catch {
      return;
    }
    if (row?.type !== 'event_msg') return;
    const payload = row.payload ?? {};
    const turn = payload.turn_id;
    if (typeof turn !== 'string') return;
    const item = payload.item ?? {};
    switch (payload.type) {
      case 'task_started':
        this.activeTurn = turn;
        break;
      case 'task_complete':
        this.finish(turn, { completed: true, reply: payload.last_agent_message ?? null });
        break;
      case 'turn_aborted':
        this.finish(turn, { completed: false, reason: payload.reason ?? null });
        break;
      case 'item_completed':
        if (item.type === 'UserMessage') {
          if (typeof item.client_id === 'string') this.turnByClientMessage.set(item.client_id, turn);
          const contents = Array.isArray(item.content) ? item.content : [];
          const reference = contents
            .map((content) => content?.text)
            .filter((text) => typeof text === 'string')
            .map(messageRefInText)
            .find(Boolean);
          if (reference) {
            this.relayTurns.add(turn);
            this.turnByMessageRef.set(reference, turn);
          }
        } else if (item.type === 'HookPrompt') {
          const fragments = Array.isArray(item.fragments) ? item.fragments : [];
          const reference = fragments
            .map((fragment) => fragment?.text)
            .filter((text) => typeof text === 'string')
            .map(messageRefInText)
            .find(Boolean);
          if (reference) this.turnByMessageRef.set(reference, turn);
        }
        break;
      default:
        break;
    }
  }

  finish(turn, result) {
    if (this.activeTurn === turn) this.activeTurn = null;
    this.outcomes.set(turn, result);
  }
}

const CACHED_ROLLOUTS = 256;
const rollouts = new Map();

function lines(buffer) {
  const found = [];
  let start = 0;
  for (let index = buffer.indexOf(10); index >= 0; index = buffer.indexOf(10, start)) {
    found.push(buffer.subarray(start, index));
    start = index + 1;
  }
  return found;
}

/**
 * The summary of the rollout at `path` (rollout.rs `RolloutSummary::load`).
 * Codex only appends, so what was read before is kept and only the bytes
 * written since are parsed; a replaced or shortened file is read again.
 */
async function loadRollout(path) {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    const cached = rollouts.get(path);
    rollouts.delete(path);
    const entry =
      cached && cached.dev === info.dev && cached.ino === info.ino && cached.offset <= info.size
        ? cached
        : { dev: info.dev, ino: info.ino, offset: 0, summary: new RolloutSummary() };
    const length = Math.max(0, info.size - entry.offset);
    const added = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(added, read, length - read, entry.offset + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    const bytes = added.subarray(0, read);
    const complete = bytes.lastIndexOf(10) + 1;
    for (const line of lines(bytes.subarray(0, complete))) entry.summary.consume(line);
    entry.offset += complete;
    const summary = entry.summary.clone();
    // A line still being written counts for this answer only.
    summary.consume(bytes.subarray(complete));
    if (rollouts.size >= CACHED_ROLLOUTS) rollouts.clear();
    rollouts.set(path, entry);
    return summary;
  } finally {
    await handle.close();
  }
}

const SESSION_DEPTH = 4;

async function findRollout(directory, suffix, depth) {
  if (depth > SESSION_DEPTH) return null;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  const directories = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.toLowerCase().endsWith(suffix)) {
      return join(directory, entry.name);
    }
    if (entry.isDirectory()) directories.push(join(directory, entry.name));
  }
  directories.sort().reverse();
  for (const child of directories) {
    const found = await findRollout(child, suffix, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Where Codex keeps the thread's rollout: the thread row's `rollout_path`,
 * else `sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl` (rollout.rs
 * `rollout_path`).
 */
export async function rolloutPath(paths, thread) {
  if (!isThreadId(thread)) return null;
  const column = await rolloutColumn(paths, thread);
  if (column) return column;
  return findRollout(join(paths.codexHome, 'sessions'), `-${thread.toLowerCase()}.jsonl`, 0);
}

async function recorded(paths, thread, ref) {
  const path = await rolloutPath(paths, thread);
  if (!path) return false;
  try {
    return (await loadRollout(path)).turnByMessageRef.has(ref);
  } catch {
    return false;
  }
}

/** No turn running. A thread with no rollout yet is idle; one that cannot be read is not. */
async function idle(paths, thread) {
  const path = await rolloutPath(paths, thread);
  if (!path) return true;
  try {
    return (await loadRollout(path)).activeTurn === null;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

// MARK: Caller identification

/**
 * The Codex thread the CLI runs in, from its own `CODEX_THREAD_ID`: a UUID
 * whose thread exists under Codex home (a catalog row, or a rollout file).
 * Returns `{threadId}` (lowercase), or `{threadId: null, reason}`.
 */
export async function codexCallerThread({ env = process.env, pid: _pid, home = os.homedir() } = {}) {
  const raw = typeof env?.CODEX_THREAD_ID === 'string' ? env.CODEX_THREAD_ID.trim() : '';
  if (raw === '') return { threadId: null, reason: 'no Codex thread id in env' };
  const thread = raw.toLowerCase();
  if (!isThreadId(thread)) return { threadId: null, reason: 'CODEX_THREAD_ID is not a thread id' };
  const paths = codexPaths({ home, env });
  if (await readThreadId(paths, thread)) return { threadId: thread };
  if (await rolloutPath(paths, thread)) return { threadId: thread };
  return {
    threadId: null,
    reason: `Codex has no thread ${thread} under ${paths.codexHome}`,
  };
}

// MARK: Live terminal (codex/processes.rs terminal_thread_is_live)

const LOCK = /(?:^|\/)thread-writer-locks\/([0-9a-fA-F-]{36})\.lock$/;

/** The thread after the last `resume` in `argv`. */
function resumeArgument(argv) {
  const index = argv.lastIndexOf('resume');
  return index < 0 ? null : argv[index + 1] ?? null;
}

/**
 * Whether an interactive Codex TUI of this user, the one that drains
 * `codex queue`, runs `thread` now: it holds the thread's writer lock or
 * runs `resume <thread>`. Conductor's and Paseo's app-servers also drain
 * the queue in the probe; neither is a guest surface, so they are not
 * looked for here.
 */
export async function terminalThreadIsLive(thread) {
  const wanted = String(thread).toLowerCase();
  if (!isThreadId(wanted)) return false;
  const uid = process.getuid?.();
  for (const candidate of await listProcesses()) {
    if (uid !== undefined && candidate.uid !== uid) continue;
    if (!(await isTrustedCodex(candidate.executable))) continue;
    const argv = await argvOf(candidate.pid);
    if (argv.some((argument) => argument === 'app-server' || argument === 'exec' || argument === 'queue')) {
      continue;
    }
    if (resumeArgument(argv)?.toLowerCase() === wanted) return true;
    const files = await openFiles(candidate.pid);
    if (files.some((file) => file.match(LOCK)?.[1]?.toLowerCase() === wanted)) return true;
  }
  return false;
}

// MARK: Running codex (codex/runner.rs)

const OUTPUT_LIMIT = 64 * 1024;

/**
 * Runs `file args` from the temporary directory with no input, in its own
 * process group, stopping the group at `timeoutMs`: `{code, stdout,
 * stderr}`, `{timedOut: true}` or `{notStarted: reason}`.
 */
export function runCommand(file, args, { timeoutMs = 20_000, env = {} } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd: os.tmpdir(),
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (error) {
      resolve({ notStarted: String(error?.message ?? error) });
      return;
    }
    const collect = (stream) => {
      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        if (size >= OUTPUT_LIMIT) return;
        chunks.push(chunk.subarray(0, OUTPUT_LIMIT - size));
        size += chunk.length;
      });
      return () => Buffer.concat(chunks).toString('utf8');
    };
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    let timedOut = false;
    const group = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      group('SIGTERM');
      setTimeout(() => group('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ notStarted: String(error?.message ?? error) });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) resolve({ timedOut: true });
      else resolve({ code: code ?? -1, stdout: stdout(), stderr: stderr() });
    });
  });
}

/** Only exit code zero and Codex's own confirmation count as queued (queue.rs `outcome`). */
export function queueOutcome(code, stdout = '', stderr = '') {
  const CONFIRMATION = 'Queued message ';
  if (code === 0) {
    const at = stdout.indexOf(CONFIRMATION);
    if (at >= 0) {
      const item = stdout.slice(at + CONFIRMATION.length).match(/^\S*/)[0];
      return { queued: true, item: item === '' ? null : item };
    }
  }
  const source = stderr === '' ? stdout : stderr;
  const line = source
    .split('\n')
    .map((value) => value.trim())
    .find((value) => value !== '');
  if (!line) return { queued: false, reason: `codex exited with code ${code}` };
  return { queued: false, reason: [...line].slice(0, 300).join('') };
}

// MARK: Codex app IPC (codex/ipc.rs)

export const MAX_FRAME_BYTES = 268_435_456;
const CLIENT_TYPE = 'agent-relay-desktop';
const DISCOVERY_TIMEOUT_MS = 12_000;
const INITIALIZE_TIMEOUT_MS = 5_000;
const START_TURN_TIMEOUT_MS = 30_000;
const METHOD_VERSIONS = {
  initialize: 0,
  'thread-owner-discovery': 1,
  'thread-follower-start-turn': 2,
};

class IpcError extends Error {
  constructor(kind, reason) {
    const text = {
      not_running: 'The Codex app is not running.',
      timed_out: 'The Codex app did not answer in time.',
      rejected: `The Codex app refused the message: ${reason}`,
      io: `Could not talk to the Codex app: ${reason}`,
    }[kind];
    super(text);
    this.kind = kind;
    this.reason = reason;
  }
}

/** A 4-byte little-endian length, then the payload. */
export function encodeFrame(payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (bytes.length === 0 || bytes.length > MAX_FRAME_BYTES) {
    throw new IpcError('io', `a ${bytes.length}-byte frame`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([header, bytes]);
}

/** Accumulates socket bytes and hands back whole frame payloads. */
export class FrameBuffer {
  constructor() {
    this.pending = Buffer.alloc(0);
  }

  append(data) {
    this.pending = Buffer.concat([this.pending, data]);
    const payloads = [];
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32LE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) throw new Error(`a ${length}-byte frame`);
      if (this.pending.length < 4 + length) break;
      payloads.push(this.pending.subarray(4, 4 + length));
      this.pending = this.pending.subarray(4 + length);
    }
    return payloads;
  }
}

function ipcRequest(method, params, source, requestId, target, timeoutMs) {
  const request = {
    type: 'request',
    requestId,
    sourceClientId: source,
    version: METHOD_VERSIONS[method],
    method,
    params,
  };
  if (target) request.targetClientId = target;
  if (timeoutMs !== undefined) request.timeoutMs = timeoutMs;
  return request;
}

function decodeIncoming(payload) {
  let value;
  try {
    value = JSON.parse(payload.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof value?.type !== 'string') return null;
  const text = (item) => (typeof item === 'string' ? item : null);
  return {
    kind: value.type,
    requestId: text(value.requestId),
    method: text(value.method),
    resultType: text(value.resultType),
    error: text(value.error),
    handledByClient: text(value.handledByClientId),
    clientId: text(value.result?.clientId),
    turnId: text(value.result?.result?.turn?.id),
  };
}

/** One registered connection to the Codex app's router. */
class IpcSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = new FrameBuffer();
    this.queued = [];
    this.failure = null;
    this.wake = null;
    this.clientId = '';
    socket.on('data', (data) => {
      try {
        this.queued.push(...this.buffer.append(data));
      } catch {
        this.failure = new IpcError('io', 'received a malformed frame');
      }
      this.notify();
    });
    const closed = () => {
      this.failure ??= new IpcError('io', 'the Codex app closed the connection');
      this.notify();
    };
    socket.on('end', closed);
    socket.on('close', closed);
    socket.on('error', (error) => {
      this.failure ??= new IpcError('io', error?.message ?? String(error));
      this.notify();
    });
  }

  static connect(path, connect = (socketPath) => net.createConnection(socketPath)) {
    return new Promise((resolve, reject) => {
      let socket;
      try {
        socket = connect(path);
      } catch (error) {
        reject(new IpcError('io', error?.message ?? String(error)));
        return;
      }
      const onError = (error) => {
        socket.destroy();
        reject(
          error?.code === 'ENOENT' || error?.code === 'ECONNREFUSED'
            ? new IpcError('not_running')
            : new IpcError('io', error?.message ?? String(error)),
        );
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        const session = new IpcSession(socket);
        session.register().then(
          () => resolve(session),
          (error) => {
            session.close();
            reject(error);
          },
        );
      });
    });
  }

  notify() {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  close() {
    this.socket.destroy();
  }

  send(message) {
    const frame = encodeFrame(Buffer.from(JSON.stringify(message)));
    return new Promise((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }
      this.socket.write(frame, (error) =>
        error ? reject(new IpcError('io', error.message)) : resolve(),
      );
    });
  }

  /** The next message, or `null` once `deadline` passes; client discovery is declined here. */
  async nextMessage(deadline) {
    for (;;) {
      while (this.queued.length > 0) {
        const message = decodeIncoming(this.queued.shift());
        if (!message) continue;
        if (message.kind === 'client-discovery-request' && message.requestId) {
          await this.send({
            type: 'client-discovery-response',
            requestId: message.requestId,
            response: { canHandle: false },
          });
          continue;
        }
        return message;
      }
      if (this.failure) throw this.failure;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.wake = null;
          resolve();
        }, remaining);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  async request(method, params, source, target, timeoutMs, waitMs) {
    const id = randomUUID();
    await this.send(ipcRequest(method, params, source, id, target, timeoutMs));
    const deadline = Date.now() + waitMs;
    for (;;) {
      const message = await this.nextMessage(deadline);
      if (!message) throw new IpcError('timed_out');
      if (message.kind === 'response' && message.requestId === id) return message;
    }
  }

  async register() {
    const response = await this.request(
      'initialize',
      { clientType: CLIENT_TYPE },
      'initializing-client',
      null,
      undefined,
      INITIALIZE_TIMEOUT_MS,
    );
    if (response.resultType === 'success' && response.clientId) {
      this.clientId = response.clientId;
      return;
    }
    throw new IpcError('rejected', response.error ?? 'initialize failed');
  }

  /** The window that owns each of `threads`; a thread no window has open is left out. */
  async owners(threads) {
    const byRequest = new Map();
    for (const thread of threads) {
      const id = randomUUID();
      await this.send(
        ipcRequest('thread-owner-discovery', { hostId: 'local', conversationId: thread }, this.clientId, id),
      );
      byRequest.set(id, thread);
    }
    const owners = new Map();
    const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
    while (byRequest.size > 0) {
      const message = await this.nextMessage(deadline);
      if (!message) break;
      if (message.kind !== 'response' || !byRequest.has(message.requestId)) continue;
      const thread = byRequest.get(message.requestId);
      byRequest.delete(message.requestId);
      if (message.resultType === 'success' && message.handledByClient) {
        owners.set(thread, message.handledByClient);
      }
    }
    return owners;
  }

  async startTurn(thread, text, messageId, owner) {
    const started = await this.request(
      'thread-follower-start-turn',
      {
        conversationId: thread,
        turnStart: {
          request: {
            threadId: thread,
            clientUserMessageId: messageId,
            input: [{ type: 'text', text, text_elements: [] }],
          },
          context: {},
        },
      },
      this.clientId,
      owner,
      START_TURN_TIMEOUT_MS,
      START_TURN_TIMEOUT_MS + 2_000,
    );
    if (started.resultType !== 'success') {
      throw new IpcError('rejected', started.error ?? 'unknown error');
    }
    return started.turnId;
  }
}

/**
 * A turn through the Codex app window that owns `thread` (router.rs
 * `window_turn`): `{sent: false}` when the app is not running or no window
 * owns it, `{sent: true}`, `{refused: reason}` when the app refused, or
 * `{inDoubt: reason}` for any other failure after the turn was asked for.
 */
export async function windowTurn(socketPath, thread, text, messageId, connect) {
  let attempted = false;
  let session;
  try {
    session = await IpcSession.connect(socketPath, connect);
    const owners = await session.owners([thread]);
    const owner = owners.get(thread);
    if (!owner) return { sent: false };
    attempted = true;
    await session.startTurn(thread, text, messageId, owner);
    return { sent: true };
  } catch (error) {
    if (error instanceof IpcError && error.kind === 'rejected') return { refused: error.reason };
    if (attempted) return { inDoubt: error?.message ?? String(error) };
    return { sent: false };
  } finally {
    session?.close();
  }
}

// MARK: Router (codex/router.rs)

export const NOT_RUNNING = 'Waiting — session not running';
export const NOT_CONSUMED = 'Waiting — terminal session has not consumed the message';
export const BEHIND_TURN = "Waiting — queued behind the session's active turn";
export const HANDED_NOT_RUNNING = 'Waiting — handed off; session not running';
export const RECORDING = 'Waiting — Codex is recording the message';
export const BUSY = 'Waiting — session busy';
export const QUEUE_UNREADABLE = 'Waiting — Codex queue state is unavailable';

/** How long a handoff is given to show up in the rollout. */
export const HANDOFF_GRACE_MS = 45_000;
/** How long a handoff is remembered at all. */
const HANDOFF_MEMORY_MS = 60 * 60 * 1_000;
const QUEUE_TIMEOUT_MS = 20_000;
const SUPPORT_TIMEOUT_MS = 10_000;

/**
 * Delivers into Codex threads, remembering its handoffs in memory.
 *
 * Options: `home`, `env` (CODEX_HOME, CODEX_SQLITE_HOME, RELAY_DESKTOP_CODEX,
 * PATH), `platform`, `run(file, args, {timeoutMs, env})` returning
 * `{code, stdout, stderr}` / `{timedOut}` / `{notStarted}`, `now()` in ms,
 * and for tests `systemCodex` (replaces the fixed install locations),
 * `terminalLive(thread)` and `connectIpc(path)`.
 */
export function createCodexRouter({
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  run = runCommand,
  now = Date.now,
  systemCodex,
  terminalLive = terminalThreadIsLive,
  connectIpc,
} = {}) {
  const paths = codexPaths({ home, env });
  const handedOff = new Map();
  const queueSupport = new Map();

  const runIn = async (file, args, timeoutMs) => {
    try {
      const result = await run(file, args, {
        timeoutMs,
        env: { CODEX_HOME: paths.codexHome, CODEX_SQLITE_HOME: paths.sqliteHome },
      });
      return result ?? { notStarted: 'no result' };
    } catch (error) {
      return { notStarted: String(error?.message ?? error) };
    }
  };

  const executable = () => codexExecutable({ home, env, platform, system: systemCodex });

  /** Asks the binary itself (`codex queue --help`), once per build. */
  const supportsQueue = async (file) => {
    let modified = null;
    try {
      modified = statSync(file).mtimeMs;
    } catch {
      // Asked anyway; not remembered under a stale key.
    }
    const key = `${file}\0${modified}`;
    if (queueSupport.has(key)) return queueSupport.get(key);
    const result = await runIn(file, ['queue', '--help'], SUPPORT_TIMEOUT_MS);
    if (typeof result.code !== 'number') return false;
    queueSupport.set(key, result.code === 0);
    return result.code === 0;
  };

  /** The thread id as Codex's own database spells it. */
  const spelled = async (thread) => (await readThreadId(paths, thread)) || thread;

  const prune = (at) => {
    for (const [id, seen] of handedOff) {
      if (at - seen >= HANDOFF_MEMORY_MS) handedOff.delete(id);
    }
  };

  const remember = (messageId) => {
    const at = now();
    handedOff.set(messageId, at);
    prune(at);
  };

  const rememberOnce = (messageId) => {
    const at = now();
    if (!handedOff.has(messageId)) handedOff.set(messageId, at);
    prune(at);
  };

  const recentlyHandedOff = (messageId) => {
    const at = handedOff.get(messageId);
    return at !== undefined && now() - at < HANDOFF_GRACE_MS;
  };

  const missingHandoffOutcome = (messageId) => {
    const at = now();
    const seen = handedOff.get(messageId);
    if (seen !== undefined && at - seen >= HANDOFF_GRACE_MS) {
      handedOff.delete(messageId);
      return outcome(
        'in_doubt',
        'Codex accepted this handoff, but it is no longer queued and was not recorded',
      );
    }
    if (seen === undefined) {
      handedOff.set(messageId, at);
      prune(at);
    }
    return outcome('accepted', RECORDING);
  };

  const delivered = (messageId, detail) => {
    handedOff.delete(messageId);
    // TODO(phase 2): the probe also removes the relay's own queue copy of a
    // message that arrived another way (queue.rs `remove_owned`). This
    // client opens Codex's databases read-only, so that copy is left for
    // Codex; the rollout, not the queue, decides delivery.
    return outcome('delivered', detail);
  };

  const handed = async (thread, messageId) => {
    remember(messageId);
    if (!(await terminalLive(thread))) return outcome('accepted', HANDED_NOT_RUNNING);
    if (await idle(paths, thread)) return outcome('accepted', NOT_CONSUMED);
    return outcome('waiting_for_turn', BEHIND_TURN);
  };

  const queueSend = async (thread, text) => {
    if (!isThreadId(thread)) return { error: 'failed', reason: 'not a Codex thread id' };
    // TODO: the probe queues a Conductor chat's thread with Conductor's own
    // bundled Codex (processes.rs `conductor_executable`); not ported.
    const file = executable();
    if (!file || !(await supportsQueue(file))) return { error: 'not_installed' };
    const result = await runIn(file, ['queue', '--thread', await spelled(thread), `--message=${text}`], QUEUE_TIMEOUT_MS);
    if (result.timedOut) return { error: 'timed_out' };
    if (typeof result.code !== 'number') return { error: 'not_installed' };
    const parsed = queueOutcome(result.code, result.stdout ?? '', result.stderr ?? '');
    return parsed.queued ? { ok: true } : { error: 'failed', reason: parsed.reason };
  };

  const handoffToTerminal = async (thread, messageId, text, ref, queued) => {
    // The queue cannot say whether an earlier handoff is still there:
    // another one could run the message twice.
    if (queued === null) return outcome('waiting', QUEUE_UNREADABLE);
    const sent = await queueSend(thread, text);
    if (sent.ok) return handed(thread, messageId);
    if (sent.error === 'timed_out') {
      if ((await queueWaiting(paths, thread, ref)) === true) return handed(thread, messageId);
      return outcome('in_doubt', 'Codex queue did not answer in time');
    }
    if (sent.error === 'not_installed') return outcome('retry', 'the codex command line is not installed');
    return outcome('retry', sent.reason);
  };

  return {
    paths,

    /** Puts `text` into the thread (router.rs `inject`). */
    async inject({ threadId, messageId, text }) {
      if (!isThreadId(threadId)) return outcome('refused', 'not a Codex thread id');
      const thread = threadId;
      const ref = messageRef(messageId);
      if (await recorded(paths, thread, ref)) {
        return delivered(messageId, "recorded in the Codex thread's rollout");
      }
      const queued = await queueWaiting(paths, thread, ref);
      if (queued === true) return handed(thread, messageId);
      if (recentlyHandedOff(messageId)) return outcome('accepted', RECORDING);
      // TODO: the probe's Conductor Stop-hook hold (router.rs
      // `stop_hook_route`) would go here; it needs an installed hook binary
      // and is not ported (docs/connect-node-local-relay.md, "Not ported").
      //
      // A live TUI owns its turn scheduling: hand it the message now, and
      // only through its queue, which Codex runs in order.
      if (await terminalLive(thread)) {
        return handoffToTerminal(thread, messageId, text, ref, queued);
      }
      // A turn through another host would overtake relay messages still in
      // the queue: join that queue behind them instead.
      const waiting = await relayWaiting(paths, thread);
      if (waiting === null) return outcome('waiting', QUEUE_UNREADABLE);
      if (waiting === true) return handoffToTerminal(thread, messageId, text, ref, queued);
      // TODO(phase 2): the shared app-server route (`codex app-server
      // proxy`, `thread/loaded/list` then `turn/start`) comes before the
      // window route in the probe.
      const window = await windowTurn(paths.ipcSocket, await spelled(thread), text, messageId, connectIpc);
      if (window.sent) return delivered(messageId, 'the Codex app started the turn');
      if (window.refused !== undefined) return outcome('retry', window.refused);
      if (window.inDoubt !== undefined) return outcome('in_doubt', window.inDoubt);
      if (!(await idle(paths, thread))) return outcome('waiting', BUSY);
      return outcome('waiting', NOT_RUNNING);
    },

    /**
     * Observes a handoff a prior attempt already proved accepted, never
     * writing another queue item (router.rs `observe`).
     */
    async observe({ threadId, messageId }) {
      if (!isThreadId(threadId)) return outcome('refused', 'not a Codex thread id');
      const ref = messageRef(messageId);
      if (await recorded(paths, threadId, ref)) {
        return delivered(messageId, "recorded in the Codex thread's rollout");
      }
      const queued = await queueWaiting(paths, threadId, ref);
      if (queued === true) return handed(threadId, messageId);
      if (queued === false) return missingHandoffOutcome(messageId);
      // An unreadable queue cannot prove the handoff vanished: keep its
      // first observation time so a later readable absence can cross the
      // grace without ever resending.
      rememberOnce(messageId);
      return outcome('accepted', QUEUE_UNREADABLE);
    },

    /** Whether the thread can take a message now, without sending one. */
    async preflight({ threadId } = {}) {
      if (!isThreadId(threadId)) return { ok: false, reason: 'not a Codex thread id' };
      const file = executable();
      if (file && (await supportsQueue(file))) {
        return { ok: true, reason: `${file} supports codex queue` };
      }
      try {
        if (statSync(paths.ipcSocket)) {
          return { ok: true, reason: `the Codex app is listening on ${paths.ipcSocket}` };
        }
      } catch {
        // No app socket.
      }
      if (!file) {
        return {
          ok: false,
          reason: 'Codex cannot receive injected messages: no codex command line is installed and the Codex app is not running.',
        };
      }
      const version = await runIn(file, ['--version'], SUPPORT_TIMEOUT_MS);
      const named =
        typeof version.stdout === 'string' ? version.stdout.match(/\d+\.\d+\.\d+[^\s]*/)?.[0] : null;
      return {
        ok: false,
        reason: `Codex ${named ?? '(unknown version)'} (${file}) cannot receive injected messages; update Codex.`,
      };
    },
  };
}

/** Which SQLite reader this process uses (`node:sqlite`, `sqlite3` or none). */
export async function codexSqliteBackend() {
  return (await sqliteBackend()).kind;
}

