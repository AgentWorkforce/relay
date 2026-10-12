import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BEHIND_TURN,
  BUSY,
  FrameBuffer,
  HANDED_NOT_RUNNING,
  NOT_CONSUMED,
  NOT_RUNNING,
  RECORDING,
  codexCallerThread,
  codexPaths,
  codexSqliteBackend,
  createCodexRouter,
  encodeFrame,
  messageRef,
  messageRefInText,
  queueOutcome,
} from '../src/relay/codex.js';
import { resetSqliteBackend } from '../src/relay/sqlite.js';

const THREAD = '01a0bcd4-0b35-7d42-8d7d-6375f7732587';
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A Connect message as the daemon injects it: the attribution line first. */
function connectText(messageId: string, body = 'Please review this.') {
  return `[Relay Connect — from guest · ref ${messageRef(messageId)}]\n[reply: npx -y @agent-relay/connect send guest "..."]\n\n${body}`;
}

/** A fake `codex` that supports `queue` (or not) and writes queue rows like Codex. */
function fakeCodex({ queue = true, version = '0.130.0' } = {}) {
  return `#!${process.execPath} --no-warnings
const { appendFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const args = process.argv.slice(2);
appendFileSync(process.env.CODEX_HOME + '/fake-codex.log', JSON.stringify(args) + '\\n');
(async () => {
  if (args[0] === '--version') { console.log('codex-cli ${version}'); return; }
  if (args[0] === 'queue' && args[1] === '--help') {
    if (!${queue}) { console.error("error: unrecognized subcommand 'queue'"); process.exit(2); }
    console.log('Usage: codex queue --thread <THREAD> --message <MESSAGE>');
    return;
  }
  if (args[0] === 'queue' && args[1] === '--thread' && args[3].startsWith('--message=')) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(process.env.CODEX_SQLITE_HOME + '/queue_1.sqlite');
    db.exec('create table if not exists queued_items (id text, thread_id text, payload_json text, created_at_ms integer)');
    const id = randomUUID();
    const payload = JSON.stringify({ items: [{ type: 'text', text: args[3].slice('--message='.length) }] });
    db.prepare('insert into queued_items values (?, ?, ?, ?)').run(id, args[2], payload, Date.now());
    db.close();
    console.log('Queued message ' + id + ' for thread ' + args[2] + '.');
    return;
  }
  console.error('unexpected arguments');
  process.exit(1);
})();
`;
}

async function setup({ queue = true } = {}) {
  const home = await mkdtemp(join(process.env.TMPDIR || os.tmpdir(), 'cx-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'codex'), fakeCodex({ queue }));
  await chmod(join(bin, 'codex'), 0o755);
  const env = { CODEX_HOME: join(home, '.codex'), PATH: `${bin}:/usr/bin:/bin` };
  const paths = codexPaths({ home, env });
  await mkdir(paths.codexHome, { recursive: true });
  const clock = { now: 1_000_000 };
  const log = async () =>
    (await readFile(join(paths.codexHome, 'fake-codex.log'), 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { home, env, paths, clock, log, now: () => clock.now };
}

async function writeRollout(codexHome: string, thread: string, events: object[]) {
  const directory = join(codexHome, 'sessions/2026/10/12');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-2026-10-12T10-00-00-${thread}.jsonl`);
  const lines = [
    { type: 'session_meta', payload: { id: thread } },
    { type: 'response_item', payload: { type: 'message', content: 'model output' } },
    ...events,
  ].map((event) => JSON.stringify(event));
  await writeFile(path, lines.join('\n') + '\n');
  return path;
}

function userMessage(turn: string, text: string) {
  return {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      turn_id: turn,
      item: { type: 'UserMessage', content: [{ type: 'text', text }] },
    },
  };
}

async function clearQueue(sqliteHome: string) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(sqliteHome, 'queue_1.sqlite'));
  db.exec('delete from queued_items');
  db.close();
}

describe('message references', () => {
  it('reads the reference from a relay attribution line only', () => {
    const ref = messageRef('message-connect-1');
    expect(ref).toMatch(/^[0-9a-f]{12}$/);
    expect(messageRefInText(`[Relay Connect — from guest · ref ${ref}]\n\nPlease review this.`)).toBe(ref);
    expect(messageRefInText(`[via Agent Relay — from @alice to @codex · message m1 · ref ${ref}]\r\nhi`)).toBe(ref);
    expect(messageRefInText(`hello [Relay Connect — from guest · ref ${ref}]`)).toBeNull();
    expect(messageRefInText(`[Relay Connect — from guest · ref ABCDEF123456]`)).toBeNull();
  });

  it('reads codex queue confirmations like the probe', () => {
    expect(queueOutcome(0, `Queued message 01a0bd9b-5bf2 for thread ${THREAD}.\n`)).toEqual({
      queued: true,
      item: '01a0bd9b-5bf2',
    });
    expect(queueOutcome(0, '', '')).toEqual({ queued: false, reason: 'codex exited with code 0' });
    expect(queueOutcome(1, 'Queued message x', '\nerror: no session found\nmore')).toEqual({
      queued: false,
      reason: 'error: no session found',
    });
    expect(queueOutcome(2, '', 'x'.repeat(400)).reason).toHaveLength(300);
  });
});

describe('Codex router', () => {
  it('is delivered once the rollout records the message, without running codex', async () => {
    const { home, env, paths, log, now } = await setup();
    await writeRollout(paths.codexHome, THREAD, [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      userMessage('t1', connectText('m1')),
    ]);
    const router = createCodexRouter({ home, env, now, systemCodex: [], terminalLive: () => true });
    expect(await router.inject({ threadId: THREAD, messageId: 'm1', text: connectText('m1') })).toMatchObject({
      outcome: 'delivered',
    });
    expect(await router.observe({ threadId: THREAD, messageId: 'm1', text: connectText('m1') })).toMatchObject({
      outcome: 'delivered',
    });
    expect(await log()).toEqual([]);
  });

  it('hands a live terminal the message through codex queue, then observes it until the rollout or 45 s', async () => {
    const { home, env, paths, clock, log, now } = await setup();
    const router = createCodexRouter({ home, env, now, systemCodex: [], terminalLive: () => true });
    const text = connectText('m2', '--dangerously-bypass-approvals-and-sandbox');

    expect(await router.inject({ threadId: THREAD, messageId: 'm2', text })).toEqual({
      outcome: 'accepted',
      detail: NOT_CONSUMED,
    });
    expect(await log()).toEqual([
      ['queue', '--help'],
      ['queue', '--thread', THREAD, `--message=${text}`],
    ]);

    // Still queued: observed, and a second inject never writes again.
    clock.now += 30_000;
    expect(await router.observe({ threadId: THREAD, messageId: 'm2', text })).toEqual({
      outcome: 'accepted',
      detail: NOT_CONSUMED,
    });
    expect((await router.inject({ threadId: THREAD, messageId: 'm2', text })).outcome).toBe('accepted');
    expect((await log()).filter((args) => args[1] === '--thread')).toHaveLength(1);

    // Codex took it from the queue but has not recorded it yet.
    await clearQueue(paths.sqliteHome);
    clock.now += 44_000;
    expect(await router.observe({ threadId: THREAD, messageId: 'm2', text })).toEqual({
      outcome: 'accepted',
      detail: RECORDING,
    });
    clock.now += 1_000;
    expect(await router.observe({ threadId: THREAD, messageId: 'm2', text })).toMatchObject({
      outcome: 'in_doubt',
    });
  });

  it('confirms a queued message from the rollout, and waits behind a running turn', async () => {
    const { home, env, paths, clock, now } = await setup();
    await writeRollout(paths.codexHome, THREAD, [{ type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }]);
    const router = createCodexRouter({ home, env, now, systemCodex: [], terminalLive: () => true });
    const text = connectText('m3');
    expect(await router.inject({ threadId: THREAD, messageId: 'm3', text })).toEqual({
      outcome: 'waiting_for_turn',
      detail: BEHIND_TURN,
    });

    await clearQueue(paths.sqliteHome);
    await writeRollout(paths.codexHome, THREAD, [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'done' } },
      userMessage('t2', text),
    ]);
    clock.now += 120_000;
    expect(await router.observe({ threadId: THREAD, messageId: 'm3', text })).toMatchObject({ outcome: 'delivered' });
  });

  it('queues behind relay messages already waiting even when no terminal runs the thread', async () => {
    const { home, env, now } = await setup();
    const router = createCodexRouter({ home, env, now, systemCodex: [], terminalLive: () => true });
    await router.inject({ threadId: THREAD, messageId: 'first', text: connectText('first') });
    const offline = createCodexRouter({ home, env, now, systemCodex: [], terminalLive: () => false });
    expect(await offline.inject({ threadId: THREAD, messageId: 'second', text: connectText('second') })).toEqual({
      outcome: 'accepted',
      detail: HANDED_NOT_RUNNING,
    });
  });

  it('leaves a message waiting when no terminal and no Codex app has the thread', async () => {
    const { home, env, paths, log, now } = await setup();
    // The real process scan: no Codex holds this test thread's writer lock.
    const router = createCodexRouter({ home, env, now, systemCodex: [] });
    expect(await router.inject({ threadId: THREAD, messageId: 'm4', text: connectText('m4') })).toEqual({
      outcome: 'waiting',
      detail: NOT_RUNNING,
    });
    await writeRollout(paths.codexHome, THREAD, [{ type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }]);
    expect(await router.inject({ threadId: THREAD, messageId: 'm4', text: connectText('m4') })).toEqual({
      outcome: 'waiting',
      detail: BUSY,
    });
    expect((await log()).filter((args) => args[1] === '--thread')).toEqual([]);
    expect((await router.inject({ threadId: 'not-a-thread', messageId: 'm', text: 'x' })).outcome).toBe('refused');
  });

  it('starts a turn through the Codex app window that owns the thread', async () => {
    const { home, env, paths, now } = await setup();
    await mkdir(join(paths.codexHome, 'ipc'), { recursive: true });
    const seen: any[] = [];
    let refuse: string | null = null;
    const server = net.createServer((socket) => {
      const buffer = new FrameBuffer();
      const send = (value: object) => socket.write(encodeFrame(Buffer.from(JSON.stringify(value))));
      socket.on('data', (chunk) => {
        for (const payload of buffer.append(chunk)) {
          const request = JSON.parse(payload.toString());
          seen.push(request);
          const id = request.requestId;
          if (request.method === 'initialize') {
            // A discovery request and a broadcast arrive first.
            send({ type: 'client-discovery-request', requestId: 'd1' });
            send({ type: 'broadcast', method: 'thread-stream-state-changed' });
            send({ type: 'response', requestId: id, resultType: 'success', result: { clientId: 'relay-1' } });
          } else if (request.method === 'thread-owner-discovery') {
            send(
              request.params.conversationId === THREAD
                ? { type: 'response', requestId: id, resultType: 'success', handledByClientId: 'owner-1' }
                : { type: 'response', requestId: id, resultType: 'error', error: 'no-client-found' },
            );
          } else if (request.method === 'thread-follower-start-turn') {
            send(
              refuse
                ? { type: 'response', requestId: id, resultType: 'error', error: refuse }
                : {
                    type: 'response',
                    requestId: id,
                    resultType: 'success',
                    result: { result: { turn: { id: 'turn-1', status: 'inProgress' } } },
                  },
            );
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(paths.ipcSocket, resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const router = createCodexRouter({ home, env, now, systemCodex: [], terminalLive: () => false });
    const text = connectText('m5');
    expect(await router.inject({ threadId: THREAD, messageId: 'm5', text })).toMatchObject({ outcome: 'delivered' });

    const [initialize, decline, discovery, start] = seen;
    expect(initialize).toMatchObject({
      type: 'request',
      method: 'initialize',
      version: 0,
      sourceClientId: 'initializing-client',
      params: { clientType: 'agent-relay-desktop' },
    });
    expect(decline).toEqual({ type: 'client-discovery-response', requestId: 'd1', response: { canHandle: false } });
    expect(discovery).toMatchObject({
      method: 'thread-owner-discovery',
      version: 1,
      sourceClientId: 'relay-1',
      params: { hostId: 'local', conversationId: THREAD },
    });
    expect(discovery.targetClientId).toBeUndefined();
    expect(start).toMatchObject({
      method: 'thread-follower-start-turn',
      version: 2,
      sourceClientId: 'relay-1',
      targetClientId: 'owner-1',
      timeoutMs: 30_000,
      params: {
        conversationId: THREAD,
        turnStart: {
          request: {
            threadId: THREAD,
            clientUserMessageId: 'm5',
            input: [{ type: 'text', text, text_elements: [] }],
          },
          context: {},
        },
      },
    });

    refuse = 'thread is archived';
    expect(await router.inject({ threadId: THREAD, messageId: 'm6', text: connectText('m6') })).toEqual({
      outcome: 'retry',
      detail: 'thread is archived',
    });
    const other = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    expect((await router.inject({ threadId: other, messageId: 'm7', text: connectText('m7') })).outcome).toBe(
      'waiting',
    );
    expect(await router.preflight({ threadId: THREAD })).toMatchObject({ ok: true });
  });

  it('preflights the queue command and names an old codex', async () => {
    const { home, env, now } = await setup();
    const router = createCodexRouter({ home, env, now, systemCodex: [] });
    expect(await router.preflight({ threadId: THREAD })).toMatchObject({ ok: true });

    const old = join(home, 'old-codex');
    await mkdir(old);
    await writeFile(join(old, 'codex'), fakeCodex({ queue: false, version: '0.98.0' }));
    await chmod(join(old, 'codex'), 0o755);
    const outdated = createCodexRouter({
      home,
      env: { ...env, RELAY_DESKTOP_CODEX: join(old, 'codex') },
      now,
      systemCodex: [],
    });
    const check = await outdated.preflight({ threadId: THREAD });
    expect(check.ok).toBe(false);
    expect(check.reason).toBe(`Codex 0.98.0 (${join(old, 'codex')}) cannot receive injected messages; update Codex.`);
    expect(await outdated.inject({ threadId: THREAD, messageId: 'm', text: connectText('m') })).toMatchObject({
      outcome: 'waiting',
    });
    const live = createCodexRouter({
      home,
      env: { ...env, RELAY_DESKTOP_CODEX: join(old, 'codex') },
      now,
      systemCodex: [],
      terminalLive: () => true,
    });
    expect(await live.inject({ threadId: THREAD, messageId: 'm', text: connectText('m') })).toEqual({
      outcome: 'retry',
      detail: 'the codex command line is not installed',
    });
  });
});

describe('Codex caller thread', () => {
  it('needs a UUID thread id that Codex knows', async () => {
    const { home, env, paths } = await setup();
    expect(await codexCallerThread({ env, home })).toEqual({ threadId: null, reason: 'no Codex thread id in env' });
    expect((await codexCallerThread({ env: { ...env, CODEX_THREAD_ID: 'my-session' }, home })).threadId).toBeNull();
    const missing = await codexCallerThread({ env: { ...env, CODEX_THREAD_ID: THREAD }, home });
    expect(missing.threadId).toBeNull();
    expect(missing.reason).toContain(THREAD);

    await writeRollout(paths.codexHome, THREAD, []);
    expect(await codexCallerThread({ env: { ...env, CODEX_THREAD_ID: THREAD.toUpperCase() }, home })).toEqual({
      threadId: THREAD,
    });

    const other = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(paths.sqliteHome, 'state_5.sqlite'));
    db.exec('create table threads (id text, title text, archived integer, source text, rollout_path text)');
    db.prepare('insert into threads values (?, ?, 0, ?, ?)').run(other, 'Fix CI', 'cli', '');
    db.close();
    expect(await codexCallerThread({ env: { ...env, CODEX_THREAD_ID: other }, home })).toEqual({ threadId: other });
  });
});

describe('SQLite fallbacks', () => {
  const backends = ['sqlite3', 'none'].filter((kind) => kind !== 'sqlite3' || existsSync('/usr/bin/sqlite3'));

  for (const kind of backends) {
    it(`works with ${kind === 'none' ? 'no SQLite reader' : 'the sqlite3 command line'}`, async () => {
      const previous = process.env.AGENT_RELAY_CONNECT_SQLITE;
      process.env.AGENT_RELAY_CONNECT_SQLITE = kind;
      resetSqliteBackend();
      cleanups.push(() => {
        if (previous === undefined) delete process.env.AGENT_RELAY_CONNECT_SQLITE;
        else process.env.AGENT_RELAY_CONNECT_SQLITE = previous;
        resetSqliteBackend();
      });
      expect(await codexSqliteBackend()).toBe(kind === 'none' ? null : 'sqlite3');

      const { home, env, paths, clock, now } = await setup();
      const router = createCodexRouter({ home, env, now, systemCodex: [], terminalLive: () => true });
      const text = connectText('m8');
      expect((await router.inject({ threadId: THREAD, messageId: 'm8', text })).outcome).toBe('accepted');
      const queued = await router.observe({ threadId: THREAD, messageId: 'm8', text });
      // Without a reader the queue reads as empty: the rollout and the 45 s rule decide.
      expect(queued).toEqual({ outcome: 'accepted', detail: kind === 'none' ? RECORDING : NOT_CONSUMED });
      await writeRollout(paths.codexHome, THREAD, [userMessage('t1', text)]);
      clock.now += 60_000;
      expect(await router.observe({ threadId: THREAD, messageId: 'm8', text })).toMatchObject({ outcome: 'delivered' });
    });
  }
});
