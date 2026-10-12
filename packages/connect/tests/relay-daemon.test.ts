import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { requestJson } from '../src/http.js';
import { startDaemon, replyHintFor } from '../src/relay/daemon.js';
import { ensureRelay, olderVersion, RelayStartError } from '../src/relay/launch.js';
import { relayPaths } from '../src/relay/paths.js';
import { FakeConnectCloud } from './support/fake-connect-cloud.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

// Unix socket paths are limited to ~104 bytes; macOS's per-user TMPDIR is long.
const shortTmp = process.platform === 'darwin' ? '/tmp' : os.tmpdir();

async function tempHome() {
  const root = await mkdtemp(join(shortTmp, 'crd-'));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  return root;
}

const fakeInjector = {
  async prepare() {},
  async inject() {
    return { outcome: 'delivered', detail: 'ok' };
  },
  async observe() {
    return { outcome: 'delivered', detail: 'ok' };
  },
  async preflight() {
    return { ok: true, reason: '' };
  },
};

const TARGET = 'codex:019a0000-0000-7000-8000-000000000001';

describe('Node relay daemon', () => {
  it('serves the Connect routes on a private socket and requires a session target', async () => {
    const home = await tempHome();
    const cloud = await new FakeConnectCloud().start();
    cleanups.push(() => cloud.stop());
    const daemon = await startDaemon({
      home,
      env: { AGENT_RELAY_CONNECT_CLOUD_URL: cloud.base },
      injector: fakeInjector,
    });
    cleanups.push(() => daemon.stop());

    expect(((await stat(daemon.socket)).mode & 0o777).toString(8)).toBe('600');
    expect(((await stat(relayPaths(home).root)).mode & 0o777).toString(8)).toBe('700');
    const health = await requestJson(daemon.socket, { path: '/health' });
    expect(health).toMatchObject({ ok: true, data: { sessions: 0 } });

    const anonymous = await requestJson(daemon.socket, {
      method: 'POST',
      path: '/connect/join',
      body: JSON.stringify({ link: 'conn-1' }),
    });
    expect(anonymous).toMatchObject({ ok: false, error: { code: 'not_a_relay_session' } });

    const joined = await requestJson(daemon.socket, {
      method: 'POST',
      path: '/connect/join',
      body: JSON.stringify({ link: 'conn-1' }),
      headers: { 'x-agent-relay-target': TARGET },
    });
    expect(joined).toMatchObject({ ok: true, data: { connect_id: 'conn-1', agent_name: 'guest-one' } });

    const status = await requestJson(daemon.socket, {
      path: '/connect/status',
      headers: { 'x-agent-relay-target': TARGET },
    });
    expect(status).toMatchObject({ ok: true, data: { connect_id: 'conn-1' } });

    const busy = await requestJson(daemon.socket, { method: 'POST', path: '/shutdown' });
    expect(busy).toMatchObject({ ok: false, error: { code: 'relay_busy' } });

    const sent = await requestJson(daemon.socket, {
      method: 'POST',
      path: '/connect/send?to=host-agent',
      body: 'hello host',
      headers: { 'x-agent-relay-target': TARGET },
    });
    expect(sent).toMatchObject({ ok: true, data: { sent: [{ to: 'host-agent' }] } });
    expect(cloud.callsTo('POST', '/v1/dm')[0].body).toEqual({
      to: 'host-agent',
      text: 'hello host',
      mode: 'wait',
    });

    const state = JSON.parse(await readFile(relayPaths(home).state, 'utf8'));
    expect(Object.keys(state.sessions)).toEqual([TARGET]);
  });

  it('refuses a second instance and cleans up its socket and lock on stop', async () => {
    const home = await tempHome();
    const daemon = await startDaemon({ home, env: {}, injector: fakeInjector });
    await expect(startDaemon({ home, env: {}, injector: fakeInjector })).rejects.toMatchObject({
      code: 'already_running',
    });
    await daemon.stop();
    await expect(stat(daemon.socket)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(relayPaths(home).lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('replaces a lock left by a relay that died', async () => {
    const home = await tempHome();
    const paths = relayPaths(home);
    await mkdir(paths.run, { recursive: true, mode: 0o700 });
    await writeFile(paths.lock, '999999\n');
    const daemon = await startDaemon({ home, env: {}, injector: fakeInjector });
    cleanups.push(() => daemon.stop());
    expect((await readFile(paths.lock, 'utf8')).trim()).toBe(String(process.pid));
  });

  it('shows a reply command that runs this runtime under this Node', () => {
    expect(replyHintFor('host-agent', '/opt/node/bin/node', '/home/a b/cli.js')).toBe(
      "[reply: printf '%s' 'your reply' | /opt/node/bin/node '/home/a b/cli.js' send --to host-agent]"
    );
  });
});

describe('Node relay launcher', () => {
  function fakeChild(behaviour: (child: EventEmitter & Record<string, unknown>) => void) {
    return () => {
      const child = Object.assign(new EventEmitter(), {
        pid: undefined,
        connected: false,
        disconnect() {},
        unref() {},
      });
      setImmediate(() => behaviour(child));
      return child;
    };
  }

  it("reports the daemon's own start error and the end of its log, without a blind wait", async () => {
    const home = await tempHome();
    const paths = relayPaths(home);
    const started = Date.now();
    await expect(
      ensureRelay({
        home,
        env: {},
        spawnProcess: fakeChild((child) => {
          writeFile(paths.log, 'boot line\nrelay connect failed to start: EACCES on run dir\n').then(() =>
            child.emit('message', { type: 'error', code: 'start_failed', message: 'EACCES on run dir' })
          );
        }) as never,
      })
    ).rejects.toThrow(
      /could not start: EACCES on run dir\.\nLast lines of .*daemon\.log:\nboot line\nrelay connect failed to start/
    );
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('reports a daemon that exits before it is ready', async () => {
    const home = await tempHome();
    await expect(
      ensureRelay({
        home,
        env: {},
        spawnProcess: fakeChild((child) => child.emit('exit', null, 'SIGKILL')) as never,
      })
    ).rejects.toBeInstanceOf(RelayStartError);
    await expect(
      ensureRelay({
        home,
        env: {},
        spawnProcess: fakeChild((child) => child.emit('exit', null, 'SIGKILL')) as never,
      })
    ).rejects.toThrow('it exited on SIGKILL before it was ready');
  });

  it('reuses a running relay instead of starting another', async () => {
    const home = await tempHome();
    const daemon = await startDaemon({ home, env: {}, injector: fakeInjector });
    cleanups.push(() => daemon.stop());
    let spawned = 0;
    const socket = await ensureRelay({
      home,
      env: {},
      spawnProcess: (() => {
        spawned += 1;
        throw new Error('should not spawn');
      }) as never,
    });
    expect(socket).toBe(daemon.socket);
    expect(spawned).toBe(0);
  });

  it('compares versions numerically', () => {
    expect(olderVersion('13.4.0', '13.10.0')).toBe(true);
    expect(olderVersion('13.10.0', '13.4.0')).toBe(false);
    expect(olderVersion('13.4.0', '13.4.0')).toBe(false);
  });
});
