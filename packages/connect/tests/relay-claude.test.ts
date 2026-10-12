import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claudeCallerSession,
  claudeHomes,
  claudePreflight,
  ensureClaudeDirectDelivery,
  findClaudeSession,
  firstJsonValue,
  injectClaude,
} from '../src/relay/claude.js';
import { processStart } from '../src/relay/processes.js';

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER_SESSION = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function tempHome() {
  // Short, so the inbox socket path stays under the Unix socket limit.
  const home = await mkdtemp(join(process.env.TMPDIR || os.tmpdir(), 'rc-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH ?? '' };
  const sessions = join(home, '.claude/sessions');
  await mkdir(sessions, { recursive: true });
  return { home, env, sessions };
}

type Record = { pid: number; sessionId?: string; procStart?: string | null; socket: string; peerProtocol?: number };

async function writeRecord(sessions: string, record: Record, trailing = '') {
  const body = {
    pid: record.pid,
    sessionId: record.sessionId ?? SESSION,
    cwd: '/work/project',
    procStart: record.procStart,
    peerProtocol: record.peerProtocol ?? 1,
    kind: 'interactive',
    messagingSocketPath: record.socket,
    name: 'project',
    status: 'idle',
  };
  await writeFile(join(sessions, `${record.pid}.json`), JSON.stringify(body) + trailing);
}

async function writeKey(sessions: string, pid: number, hash: string, token: string, procStart: string | null) {
  const path = join(sessions, `${pid}.${hash}.key`);
  await writeFile(path, JSON.stringify({ peerToken: token, procStart }));
  await chmod(path, 0o600);
}

/** A fake Claude Code inbox: records every line received on each connection. */
async function fakeInbox(home: string) {
  const path = join(home, 'in.sock');
  const connections: string[][] = [];
  const server = net.createServer((socket) => {
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('end', () => {
      connections.push(data.split('\n').filter(Boolean));
      socket.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { path, connections };
}

/** A socket stand-in whose `failAt`-th write fails with EPIPE. */
class FailingSocket extends EventEmitter {
  writes: Buffer[] = [];
  destroyed = false;
  constructor(private failAt: number) {
    super();
    setImmediate(() => this.emit('connect'));
  }
  write(bytes: Buffer, callback: (error?: Error) => void) {
    this.writes.push(bytes);
    if (this.writes.length === this.failAt) {
      setImmediate(() => {
        const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
        this.emit('error', error);
        callback(error);
      });
    } else {
      setImmediate(() => callback());
    }
    return true;
  }
  end() {
    setImmediate(() => this.emit('end'));
  }
  destroy() {
    this.destroyed = true;
  }
}

describe('Claude Code sessions', () => {
  it('reads the first JSON value of a record and ignores trailing junk', () => {
    expect(firstJsonValue('{"a":"}{","b":[1,{"c":2}]}\u0000\u0000}garbage')).toEqual({ a: '}{', b: [1, { c: 2 }] });
    expect(firstJsonValue('  {"x":"a\\"b"} {"y":1}')).toEqual({ x: 'a"b' });
    expect(() => firstJsonValue('{"unterminated":')).toThrow();
    expect(() => firstJsonValue('')).toThrow();
  });

  it('lists the configured login and sibling logins once each', async () => {
    const { home, env } = await tempHome();
    await mkdir(join(home, '.claude-work/sessions'), { recursive: true });
    await mkdir(join(home, '.claude-empty'), { recursive: true });
    expect(claudeHomes({ home, env })).toEqual([join(home, '.claude'), join(home, '.claude-work')]);
    expect(claudeHomes({ home, env: { CLAUDE_CONFIG_DIR: '~/.claude-work' } })).toEqual([
      join(home, '.claude-work'),
      join(home, '.claude'),
    ]);
  });

  it('delivers the auth line and the user message with the key matching the start time', async () => {
    const { home, env, sessions } = await tempHome();
    const inbox = await fakeInbox(home);
    const start = (await processStart(process.pid))!;
    await writeRecord(sessions, { pid: process.pid, procStart: start, socket: inbox.path }, '\u0000\u0000"}stray');
    await writeKey(sessions, process.pid, 'aaaa', 'stale-token', 'Thu Jan  1 00:00:00 1970');
    await writeKey(sessions, process.pid, 'bbbb', 'live-token', start);

    const found = await findClaudeSession({ home, env, sessionId: SESSION });
    expect(found).toMatchObject({ sessionId: SESSION, pid: process.pid, peerProtocol: 1, cwd: '/work/project' });
    expect(await claudePreflight({ home, env, sessionId: SESSION })).toMatchObject({ ok: true });

    const result = await injectClaude({ home, env, sessionId: SESSION, messageId: 'msg_1', text: 'hello\nthere' });
    expect(result.outcome).toBe('delivered');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(inbox.connections).toHaveLength(1);
    const [auth, message] = inbox.connections[0];
    expect(auth).toBe('{"token":"live-token","type":"auth"}');
    const parsed = JSON.parse(message);
    expect(Object.keys(parsed)).toEqual(['message', 'msg_id', 'priority', 'type', 'uuid']);
    expect(parsed).toMatchObject({
      type: 'user',
      msg_id: 'msg_1',
      priority: 'next',
      message: { role: 'user', content: 'hello\nthere' },
    });
    expect(parsed.uuid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
  });

  it('leaves a message waiting when the recorded process is gone', async () => {
    const { home, env, sessions } = await tempHome();
    const inbox = await fakeInbox(home);
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const start = (await processStart(child.pid!))!;
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    await writeRecord(sessions, { pid: child.pid!, procStart: start, socket: inbox.path });
    await writeKey(sessions, child.pid!, 'aaaa', 'token', start);

    expect(await injectClaude({ home, env, sessionId: SESSION, messageId: 'm', text: 'x' })).toEqual({
      outcome: 'waiting',
      detail: 'that Claude Code session is not running',
    });
    expect((await claudePreflight({ home, env, sessionId: SESSION })).ok).toBe(false);
    expect(inbox.connections).toHaveLength(0);
  });

  it('does not take a recycled pid for the session', async () => {
    const { home, env, sessions } = await tempHome();
    const inbox = await fakeInbox(home);
    const recycled = process.platform === 'linux' ? '1' : 'Thu Jan  1 00:00:01 1970';
    await writeRecord(sessions, { pid: process.pid, procStart: recycled, socket: inbox.path });
    expect((await injectClaude({ home, env, sessionId: SESSION, messageId: 'm', text: 'x' })).outcome).toBe(
      'waiting',
    );
  });

  it('retries when the inbox key is missing, and refuses an id that is not a session id', async () => {
    const { home, env, sessions } = await tempHome();
    const inbox = await fakeInbox(home);
    await writeRecord(sessions, { pid: process.pid, procStart: await processStart(process.pid), socket: inbox.path });
    expect(await injectClaude({ home, env, sessionId: SESSION, messageId: 'm', text: 'x' })).toEqual({
      outcome: 'retry',
      detail: "could not read that Claude Code session's inbox key",
    });
    expect(await claudePreflight({ home, env, sessionId: SESSION })).toEqual({
      ok: false,
      reason: "could not read that Claude Code session's inbox key",
    });
    expect((await injectClaude({ home, env, sessionId: 'nope', messageId: 'm', text: 'x' })).outcome).toBe('refused');
    expect(inbox.connections).toHaveLength(0);
  });

  it('retries an unknown peer protocol', async () => {
    const { home, env, sessions } = await tempHome();
    const start = (await processStart(process.pid))!;
    await writeRecord(sessions, { pid: process.pid, procStart: start, socket: join(home, 'x.sock'), peerProtocol: 2 });
    await writeKey(sessions, process.pid, 'aaaa', 'token', start);
    const result = await injectClaude({ home, env, sessionId: SESSION, messageId: 'm', text: 'x' });
    expect(result.outcome).toBe('retry');
    expect(result.detail).toContain('peer protocol 2');
  });

  it('retries when the inbox cannot be reached or the auth line fails, and is in doubt mid-message', async () => {
    const { home, env, sessions } = await tempHome();
    const start = (await processStart(process.pid))!;
    await writeRecord(sessions, { pid: process.pid, procStart: start, socket: join(home, 'gone.sock') });
    await writeKey(sessions, process.pid, 'aaaa', 'token', start);

    const unreachable = await injectClaude({ home, env, sessionId: SESSION, messageId: 'm', text: 'x' });
    expect(unreachable.outcome).toBe('retry');
    expect(unreachable.detail).toMatch(/^could not reach the session's inbox: /);

    let authFails!: FailingSocket;
    const auth = await injectClaude({
      home,
      env,
      sessionId: SESSION,
      messageId: 'm',
      text: 'x',
      connect: () => (authFails = new FailingSocket(1)) as unknown as net.Socket,
    });
    expect(auth.outcome).toBe('retry');
    expect(auth.detail).toContain('EPIPE');
    expect(authFails.writes).toHaveLength(1);
    expect(authFails.destroyed).toBe(true);

    const mid = await injectClaude({
      home,
      env,
      sessionId: SESSION,
      messageId: 'm',
      text: 'x',
      connect: () => new FailingSocket(2) as unknown as net.Socket,
    });
    expect(mid.outcome).toBe('in_doubt');
    expect(mid.detail).toMatch(/^the session's inbox connection broke while sending: /);
  });

  it('names the session of the nearest ancestor with a matching record', async () => {
    const { home, env, sessions } = await tempHome();
    const parentStart = (await processStart(process.ppid))!;
    await writeRecord(sessions, { pid: process.ppid, sessionId: OTHER_SESSION, procStart: parentStart, socket: '/x' });
    expect(await claudeCallerSession({ home, env, pid: process.pid })).toBe(OTHER_SESSION);

    // A record of the calling process itself is nearer and wins.
    await writeRecord(sessions, { pid: process.pid, procStart: await processStart(process.pid), socket: '/y' });
    expect(await claudeCallerSession({ home, env, pid: process.pid })).toBe(SESSION);

    // A record without a start time can never be replied from.
    await writeRecord(sessions, { pid: process.pid, procStart: null, socket: '/y' });
    expect(await claudeCallerSession({ home, env, pid: process.pid })).toBe(OTHER_SESSION);

    // A running session whose record does not parse ends the walk.
    await writeFile(join(sessions, `${process.pid}.json`), '{ broken');
    await writeKey(sessions, process.pid, 'cccc', 'token', await processStart(process.pid));
    expect(await claudeCallerSession({ home, env, pid: process.pid })).toBeNull();
  });
});

describe('ensureClaudeDirectDelivery', () => {
  it('sets accept keeping other keys, keeps the mode and backs the original up once', async () => {
    const { home, env } = await tempHome();
    const settings = join(home, '.claude/settings.json');
    const original = '{"model": "opus", "env": {"TOKEN": "x"}, "permissions": {"allow": ["Bash(ls)"]}}';
    await writeFile(settings, original);
    await chmod(settings, 0o600);
    const managedSettingsPath = join(home, 'managed-settings.json');

    expect(await ensureClaudeDirectDelivery({ home, env, managedSettingsPath })).toMatchObject({ changed: true });
    const updated = JSON.parse(await readFile(settings, 'utf8'));
    expect(updated).toEqual({
      model: 'opus',
      env: { TOKEN: 'x' },
      permissions: { allow: ['Bash(ls)'] },
      crossSessionInbound: 'accept',
    });
    const backup = `${settings}.relay-desktop-backup`;
    expect(await readFile(backup, 'utf8')).toBe(original);
    expect((await stat(settings)).mode & 0o777).toBe(0o600);
    expect((await stat(backup)).mode & 0o777).toBe(0o600);

    expect(await ensureClaudeDirectDelivery({ home, env, managedSettingsPath })).toMatchObject({ changed: false });

    await writeFile(settings, '{"crossSessionInbound": "hold", "model": "opus"}');
    expect(await ensureClaudeDirectDelivery({ home, env, managedSettingsPath })).toMatchObject({ changed: true });
    expect(await readFile(backup, 'utf8')).toBe(original);
    expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ crossSessionInbound: 'accept', model: 'opus' });
  });

  it('creates a private settings file where there is none, and refuses one that is not JSON', async () => {
    const { home, env } = await tempHome();
    const managedSettingsPath = join(home, 'managed-settings.json');
    expect(await ensureClaudeDirectDelivery({ home, env, managedSettingsPath })).toMatchObject({ changed: true });
    const settings = join(home, '.claude/settings.json');
    expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ crossSessionInbound: 'accept' });
    expect((await stat(settings)).mode & 0o777).toBe(0o600);

    await writeFile(settings, '{ broken');
    await expect(ensureClaudeDirectDelivery({ home, env, managedSettingsPath })).rejects.toMatchObject({
      code: 'claude_settings_unreadable',
    });
    expect(await readFile(settings, 'utf8')).toBe('{ broken');
  });

  it('refuses when managed settings pin another value, naming the managed file', async () => {
    const { home, env } = await tempHome();
    const settings = join(home, '.claude/settings.json');
    await writeFile(settings, '{"model": "opus"}');
    const managedSettingsPath = join(home, 'managed-settings.json');
    await writeFile(managedSettingsPath, '{"crossSessionInbound": "hold"}');

    const error = await ensureClaudeDirectDelivery({ home, env, managedSettingsPath }).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('claude_inbound_managed');
    expect(error.message).toContain(managedSettingsPath);
    expect(await readFile(settings, 'utf8')).toBe('{"model": "opus"}');

    await writeFile(managedSettingsPath, '{"crossSessionInbound": "accept"}');
    expect(await ensureClaudeDirectDelivery({ home, env, managedSettingsPath })).toMatchObject({ changed: false });
    expect(await readFile(settings, 'utf8')).toBe('{"model": "opus"}');
  });
});
