import { randomUUID } from 'node:crypto';
import { constants, readdirSync, realpathSync, statSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, rename, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { ancestors, claudeStartMatches, MAX_ANCESTRY, processInfo } from './processes.js';

// Claude Code terminal sessions and the inbox route into them, ported from
// relay-desktop probe/src/relay/claude.rs and claude_settings.rs.
//
// Claude Code registers every session in `<claude home>/sessions/<pid>.json`
// and opens an inbox socket for cross-session messaging, authenticated by the
// token in the matching `<pid>.<hash>.key`. A message is two JSON lines on
// that socket: the auth line, then the user message.

/** The inbox wire version this client speaks (claude.rs KNOWN_PEER_PROTOCOL). */
export const KNOWN_PEER_PROTOCOL = 1;
/** Claude Code refuses an inbox line past about a million characters. */
export const MAX_LINE_BYTES = 1_000_000;
const SOCKET_TIMEOUT_MS = 5_000;
const DRAIN_TIMEOUT_MS = 1_000;

export const INBOUND_KEY = 'crossSessionInbound';
const ACCEPT = 'accept';
export const BACKUP_SUFFIX = '.relay-desktop-backup';
export const MANAGED_SETTINGS = {
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  other: '/etc/claude-code/managed-settings.json',
};

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** store.rs `is_uuid`: 36 characters, hex with dashes at 8, 13, 18 and 23. */
export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

function outcome(kind, detail) {
  return { outcome: kind, detail };
}

function expandTilde(path, home) {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

function setting(env, key) {
  const value = env?.[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeHome({ home = os.homedir(), env = process.env } = {}) {
  const configured = setting(env, 'CLAUDE_CONFIG_DIR');
  return configured ? expandTilde(configured, home) : join(home, '.claude');
}

async function sortedEntries(directory) {
  const names = await readdir(directory).catch(() => []);
  return names.sort().map((name) => join(directory, name));
}

function isDirectorySync(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every Claude login of this person's (claude.rs `registries`): the
 * configured home, then each sibling `.claude` or `.claude-<name>` folder
 * that has a `sessions/` registry, each once by the real path of its
 * registry, so a login whose `sessions/` links to another's is read once.
 */
export function claudeHomes({ home = os.homedir(), env = process.env } = {}) {
  const configured = claudeHome({ home, env });
  const parent = dirname(configured);
  let names = [];
  try {
    names = readdirSync(parent);
  } catch {
    names = [];
  }
  const siblings = names
    .filter((name) => name === '.claude' || name.startsWith('.claude-'))
    .map((name) => join(parent, name))
    .filter((folder) => isDirectorySync(join(folder, 'sessions')))
    .sort();
  const seen = new Set();
  const homes = [];
  for (const folder of [configured, ...siblings]) {
    const registry = join(folder, 'sessions');
    let key = registry;
    try {
      key = realpathSync(registry);
    } catch {
      // Not there (yet): compared by its own path.
    }
    if (seen.has(key)) continue;
    seen.add(key);
    homes.push(folder);
  }
  return homes;
}

/**
 * The first JSON value in `text`, ignoring whatever follows it (claude.rs
 * `first_value`). Claude Code rewrites its registry files in place, so an
 * interrupted write can leave stray bytes after a complete record.
 */
export function firstJsonValue(text) {
  const start = text.search(/\S/);
  if (start < 0) throw new SyntaxError('empty JSON');
  const opening = text[start];
  if (opening !== '{' && opening !== '[') {
    try {
      return JSON.parse(text);
    } catch {
      const token = text.slice(start).match(/^("(?:[^"\\]|\\.)*"|[^\s,\]}]+)/);
      if (!token) throw new SyntaxError('no JSON value');
      return JSON.parse(token[0]);
    }
  }
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, index + 1));
    }
  }
  throw new SyntaxError('unterminated JSON value');
}

/** `procStart` as text: a string on macOS, a string or a number of ticks on Linux. */
function recordedStart(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * One `<pid>.json` record (claude.rs `TerminalSession::decode_value`), or
 * `null` without what a delivery needs: a UUID session id, a pid and a
 * socket path.
 */
export function decodeSessionRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const { sessionId, pid, messagingSocketPath } = record;
  if (!isUuid(sessionId)) return null;
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return null;
  if (typeof messagingSocketPath !== 'string' || messagingSocketPath === '') return null;
  const text = (key) => (typeof record[key] === 'string' ? record[key] : null);
  return {
    sessionId,
    pid,
    messagingSocketPath,
    peerProtocol: Number.isInteger(record.peerProtocol) ? record.peerProtocol : 0,
    procStart: recordedStart(record.procStart),
    cwd: text('cwd'),
    name: text('name'),
    status: text('status'),
    updatedAtMs: null,
    registryDir: null,
  };
}

/** Reads `pid` once per pass, so one registry read asks `ps` once per pid. */
function infoReader() {
  const cache = new Map();
  return (pid) => {
    if (!cache.has(pid)) cache.set(pid, processInfo(pid));
    return cache.get(pid);
  };
}

/**
 * Whether the record belongs to a process running now (claude.rs
 * `is_alive`): the pid is alive and its start time matches `procStart`. A
 * record without a start is taken on its pid alone.
 */
async function isLive(record, info) {
  const running = await info(record.pid);
  if (!running) return false;
  return record.procStart === null || claudeStartMatches(record.procStart, running.start);
}

async function keyRecords(registryDir, pid) {
  const prefix = `${pid}.`;
  const records = [];
  for (const path of await sortedEntries(registryDir)) {
    if (extname(path) !== '.key' || !basename(path).startsWith(prefix)) continue;
    try {
      records.push(firstJsonValue(await readFile(path, 'utf8')));
    } catch {
      // An unreadable key is no key.
    }
  }
  return records;
}

async function keyNamesRunningProcess(registryDir, pid, info) {
  const running = await info(pid);
  if (!running) return false;
  return (await keyRecords(registryDir, pid)).some((record) => {
    const start = recordedStart(record?.procStart);
    return start !== null && claudeStartMatches(start, running.start);
  });
}

/**
 * Claude Code's session registry across every login (claude.rs `registry`):
 * live sessions newest first, and the `<pid>.json` files that do not parse
 * although a key of the same pid names the running process. `want` narrows
 * the read before any process is looked up; it never changes which of the
 * wanted records are live.
 */
async function readRegistry({ home, env, want = () => true, wantPid = () => true }) {
  const info = infoReader();
  const sessions = [];
  const unreadable = [];
  for (const claude of claudeHomes({ home, env })) {
    const registryDir = join(claude, 'sessions');
    for (const path of await sortedEntries(registryDir)) {
      if (extname(path) !== '.json') continue;
      let record;
      let error;
      try {
        record = firstJsonValue(await readFile(path, 'utf8'));
      } catch (caught) {
        error = caught;
      }
      if (error) {
        const stem = basename(path, '.json');
        const pid = /^\d+$/.test(stem) ? Number.parseInt(stem, 10) : 0;
        if (pid > 0 && wantPid(pid) && (await keyNamesRunningProcess(registryDir, pid, info))) {
          unreadable.push({ path, pid, error: String(error?.message ?? error) });
        }
        continue;
      }
      const session = decodeSessionRecord(record);
      if (!session || !want(session)) continue;
      session.registryDir = registryDir;
      session.updatedAtMs = (await stat(path).catch(() => null))?.mtimeMs ?? null;
      if (!(await isLive(session, info))) continue;
      // One entry per process: a start-matched record wins over a stale one
      // without a start, in whichever login it is.
      const index = sessions.findIndex((other) => other.pid === session.pid);
      if (index < 0) sessions.push(session);
      else if (sessions[index].procStart === null && session.procStart !== null) {
        sessions[index] = session;
      }
    }
  }
  sessions.sort((a, b) => (b.updatedAtMs ?? -Infinity) - (a.updatedAtMs ?? -Infinity) || a.pid - b.pid);
  return { sessions, unreadable, info };
}

/**
 * The live session with this id, looked up afresh (its pid and socket change
 * when it is resumed in a new process), or `null`.
 */
export async function findClaudeSession({ home = os.homedir(), env = process.env, sessionId }) {
  if (!isUuid(sessionId)) return null;
  const { sessions } = await readRegistry({
    home,
    env,
    want: (session) => session.sessionId === sessionId,
  });
  return sessions.find((session) => session.sessionId === sessionId) ?? null;
}

/**
 * The Claude Code session the process `pid` runs inside (local.rs
 * `caller_target`): the nearest ancestor, `pid` itself included, of this
 * user's that is a live registered session with a recorded start time that
 * matches. A running session whose own `<pid>.json` does not parse ends the
 * walk, so an outer session is never named instead. Returns the session id
 * or `null`.
 */
export async function claudeCallerSession({ home = os.homedir(), env = process.env, pid }) {
  const uid = process.getuid?.();
  const chain = await ancestors(pid, MAX_ANCESTRY);
  const pids = new Set(chain.map((entry) => entry.pid));
  const { sessions, unreadable } = await readRegistry({
    home,
    env,
    want: (session) => pids.has(session.pid),
    wantPid: (candidate) => pids.has(candidate),
  });
  for (const entry of chain) {
    const own = uid === undefined || entry.uid === uid;
    const session = sessions.find(
      (candidate) =>
        own &&
        candidate.pid === entry.pid &&
        candidate.procStart !== null &&
        claudeStartMatches(candidate.procStart, entry.start)
    );
    if (session) {
      // Still the same process after the registry was read.
      const again = await processInfo(entry.pid);
      const same =
        again !== null &&
        again.start === entry.start &&
        again.parent === entry.parent &&
        again.uid === entry.uid;
      return same ? session.sessionId : null;
    }
    // A running session whose own registry file does not parse is the
    // caller's nearest session: the walk ends here.
    if (own && unreadable.some((file) => file.pid === entry.pid)) return null;
  }
  return null;
}

/**
 * The inbox token from the session's `<pid>.<hash>.key` whose recorded
 * start matches the session's (claude.rs `peer_token`). A key that records
 * no start is used only when it is the pid's one key. Never logged.
 */
export async function peerToken(session) {
  const keys = [];
  for (const record of await keyRecords(session.registryDir, session.pid)) {
    const token = record?.peerToken;
    if (typeof token !== 'string' || token === '') continue;
    keys.push({ token, start: recordedStart(record.procStart) });
  }
  if (session.procStart !== null) {
    const matching = keys.find((key) => key.start === session.procStart);
    if (matching) return matching.token;
  }
  if (keys.length === 1) {
    const [only] = keys;
    if (only.start === null) return only.token;
    if (session.procStart === null) return only.token;
  }
  return null;
}

/**
 * The two NDJSON lines of one delivery (claude.rs `peer_frames`), keys in
 * the order serde_json writes them:
 * ```text
 * {"token":"<peerToken>","type":"auth"}
 * {"message":{"content":"…","role":"user"},"msg_id":…,"priority":"next","type":"user","uuid":…}
 * ```
 */
export function peerFrames(token, messageId, text) {
  const auth = Buffer.from(`${JSON.stringify({ token, type: 'auth' })}\n`);
  const message = Buffer.from(
    `${JSON.stringify({
      message: { content: text, role: 'user' },
      msg_id: messageId,
      priority: 'next',
      type: 'user',
      uuid: randomUUID().toUpperCase(),
    })}\n`
  );
  if (auth.length > MAX_LINE_BYTES) {
    return { error: "the session's inbox key is too long to send" };
  }
  if (message.length > MAX_LINE_BYTES) {
    return {
      error: `the message is ${message.length} bytes, past the ${MAX_LINE_BYTES} a session accepts`,
    };
  }
  return { auth, message };
}

function connectSocket(path) {
  return net.createConnection(path);
}

/** Writes `bytes`; resolves `null` once handed to the kernel, else the error. */
function writeAll(socket, bytes, state) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('error', onError);
      socket.off('close', onClose);
      resolve(error ?? null);
    };
    const onError = (error) => finish(error);
    const onClose = () => finish(state.error ?? new Error('the connection closed'));
    const timer = setTimeout(() => finish(new Error('timed out writing to the socket')), SOCKET_TIMEOUT_MS);
    if (state.error || socket.destroyed) {
      finish(state.error ?? new Error('the connection closed'));
      return;
    }
    socket.on('error', onError);
    socket.on('close', onClose);
    try {
      socket.write(bytes, (error) => finish(error ?? null));
    } catch (error) {
      finish(error);
    }
  });
}

function connected(socket) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(new Error('timed out connecting')), SOCKET_TIMEOUT_MS);
    const done = (error) => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
      resolve(error ?? null);
    };
    const onConnect = () => done(null);
    const onError = (error) => done(error);
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

/** Lets the session read both lines before the connection closes. */
function drain(socket) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, DRAIN_TIMEOUT_MS);
    socket.once('data', done);
    socket.once('end', done);
    socket.once('close', done);
    socket.once('error', done);
  });
}

async function writeInbox(socketPath, frames, connect) {
  let socket;
  try {
    socket = connect(socketPath);
  } catch (error) {
    return outcome('retry', `could not reach the session's inbox: ${error?.message ?? error}`);
  }
  const state = { error: null };
  socket.on('error', (error) => {
    state.error = error;
  });
  try {
    const refused = await connected(socket);
    if (refused) {
      return outcome('retry', `could not reach the session's inbox: ${refused.message}`);
    }
    // A write can fail after part of it went out, so only a failure before
    // any of the message line was handed to the kernel is certain.
    const authError = await writeAll(socket, frames.auth, state);
    if (authError) {
      return outcome('retry', `could not reach the session's inbox: ${authError.message}`);
    }
    const messageError = await writeAll(socket, frames.message, state);
    if (messageError) {
      return outcome(
        'in_doubt',
        `the session's inbox connection broke while sending: ${messageError.message}`
      );
    }
    socket.end();
    await drain(socket);
    return outcome('delivered', "handed to the Claude Code session's inbox");
  } finally {
    socket.destroy();
  }
}

/**
 * Writes `text` into the Claude Code session's inbox (claude.rs
 * `send_to_terminal`). `delivered` means the bytes were handed over, not
 * that Claude read or ran them. Claude's inbox gives no read-back, so a
 * repeat after a crash is possible; `msg_id` is the Relaycast message id in
 * case Claude dedupes on it.
 */
export async function injectClaude({
  home = os.homedir(),
  env = process.env,
  sessionId,
  messageId,
  text,
  connect = connectSocket,
}) {
  if (!isUuid(sessionId)) return outcome('refused', 'invalid session id');
  const session = await findClaudeSession({ home, env, sessionId });
  if (!session) return outcome('waiting', 'that Claude Code session is not running');
  if (session.peerProtocol !== KNOWN_PEER_PROTOCOL) {
    return outcome(
      'retry',
      `that Claude Code session speaks peer protocol ${session.peerProtocol}, which this app does not know`
    );
  }
  const token = await peerToken(session);
  if (!token) return outcome('retry', "could not read that Claude Code session's inbox key");
  const frames = peerFrames(token, messageId, text);
  if (frames.error) return outcome('retry', frames.error);
  return writeInbox(session.messagingSocketPath, frames, connect);
}

/**
 * Whether the session can take a message now, without writing to its
 * socket: the record is live, it speaks peer protocol 1 and its key is
 * readable.
 */
export async function claudePreflight({ home = os.homedir(), env = process.env, sessionId }) {
  if (!isUuid(sessionId)) return { ok: false, reason: 'invalid session id' };
  const session = await findClaudeSession({ home, env, sessionId });
  if (!session) return { ok: false, reason: 'that Claude Code session is not running' };
  if (session.peerProtocol !== KNOWN_PEER_PROTOCOL) {
    return {
      ok: false,
      reason: `that Claude Code session speaks peer protocol ${session.peerProtocol}, which this app does not know`,
    };
  }
  if (!(await peerToken(session))) {
    return { ok: false, reason: "could not read that Claude Code session's inbox key" };
  }
  return { ok: true, reason: "the Claude Code session's inbox is ready" };
}

// MARK: crossSessionInbound

/** `crossSessionInbound` in a settings file's text, or `null`. */
export function inboundValue(text) {
  if (text === null || text === undefined) return null;
  try {
    const value = JSON.parse(text)?.[INBOUND_KEY];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function unreadableSettings(path) {
  const error = new Error(
    `Your Claude settings file is not valid JSON, so it was left unchanged. Fix it or add "${INBOUND_KEY}": "${ACCEPT}" by hand.`
  );
  error.code = 'claude_settings_unreadable';
  error.path = path;
  return error;
}

/**
 * The settings text with `crossSessionInbound` set to `value`, every other
 * key kept (claude_settings.rs `with_inbound`); an absent or blank file
 * starts empty, and anything but a JSON object is refused.
 */
export function withInbound(value, text, path = 'settings.json') {
  let object = {};
  if (text !== null && text !== undefined && text.trim() !== '') {
    try {
      object = JSON.parse(text);
    } catch {
      throw unreadableSettings(path);
    }
    if (!object || typeof object !== 'object' || Array.isArray(object)) {
      throw unreadableSettings(path);
    }
  }
  object[INBOUND_KEY] = value;
  return `${JSON.stringify(object, null, 2)}\n`;
}

/** `path` with every symlink followed, also when the target does not exist yet. */
async function resolveSymlinks(path) {
  let current = path;
  for (let index = 0; index < 40; index += 1) {
    const info = await lstat(current).catch(() => null);
    if (!info?.isSymbolicLink()) break;
    const target = await readlink(current).catch(() => null);
    if (target === null) break;
    current = target.startsWith('/') ? target : join(dirname(current), target);
  }
  return current;
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Replaces `path` atomically with `updated` (claude_settings.rs
 * `write_keeping_file`): the file's mode is kept (0600 for a new file), the
 * parent is created private, and the original is copied once beside it.
 */
async function writeKeepingFile(path, existing, updated) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const mode = ((await stat(path).catch(() => null))?.mode ?? 0o600) & 0o777;
  if (existing !== null) {
    const backup = `${path}${BACKUP_SUFFIX}`;
    if (!(await lstat(backup).catch(() => null))) {
      const handle = await open(backup, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
      try {
        await handle.writeFile(existing);
      } finally {
        await handle.close();
      }
    }
  }
  const temporary = join(parent, `.settings.${process.pid}.${randomUUID()}`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(updated);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function managedError(file, value) {
  const error = new Error(
    `Managed Claude settings do not allow direct delivery: ${file} sets "${INBOUND_KEY}" to ${JSON.stringify(value)}, so replies cannot be injected; ask your admin.`
  );
  error.code = 'claude_inbound_managed';
  error.path = file;
  return error;
}

/**
 * Turns direct delivery on for the Claude login (claude_settings.rs
 * `set_own_direct_delivery(true)`): `"crossSessionInbound": "accept"` in
 * its `settings.json`, every other key kept, the original backed up once to
 * `settings.json.relay-desktop-backup`, a symlinked file rewritten at its
 * target. Nothing is written when managed settings or the user's own
 * already accept. Managed settings that pin another value throw an Error
 * with code `claude_inbound_managed` naming the managed file.
 *
 * `claudeHome` picks a login other than `CLAUDE_CONFIG_DIR`/`~/.claude`
 * (the caller session's `registryDir/..`); `managedSettingsPath` replaces
 * the system path (tests).
 */
export async function ensureClaudeDirectDelivery({
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  claudeHome: login,
  managedSettingsPath,
} = {}) {
  const managedFile =
    managedSettingsPath ?? (platform === 'darwin' ? MANAGED_SETTINGS.darwin : MANAGED_SETTINGS.other);
  const settingsFile = join(login ?? claudeHome({ home, env }), 'settings.json');
  const managed = async () => inboundValue(await readFile(managedFile, 'utf8').catch(() => null));
  const user = async () => inboundValue(await readFile(settingsFile, 'utf8').catch(() => null));
  const delivers = async () => ((await managed()) ?? (await user())) === ACCEPT;

  const pinned = await managed();
  if (pinned !== null && pinned !== ACCEPT) throw managedError(managedFile, pinned);
  if (await delivers()) return { changed: false, path: settingsFile };

  const path = await resolveSymlinks(settingsFile);
  let existing;
  try {
    existing = await readOptional(path);
  } catch (error) {
    const failed = new Error(`Could not save your Claude settings: ${error?.message ?? error}`);
    failed.code = 'claude_settings_failed';
    throw failed;
  }
  const updated = withInbound(ACCEPT, existing, settingsFile);
  try {
    await writeKeepingFile(path, existing, updated);
  } catch (error) {
    const failed = new Error(`Could not save your Claude settings: ${error?.message ?? error}`);
    failed.code = 'claude_settings_failed';
    throw failed;
  }
  if (!(await delivers())) throw managedError(managedFile, await managed());
  return { changed: true, path: settingsFile };
}
