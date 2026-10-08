import { once } from 'node:events';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { stat } from 'node:fs/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { startFleetNodeAttachProxy, type FleetNodeAttachProxy } from './attach.js';

let proxy: FleetNodeAttachProxy | undefined;
let server: WebSocketServer | undefined;
let local: Socket | undefined;
afterEach(async () => {
  local?.destroy();
  await proxy?.close();
  proxy = undefined;
  if (server) {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;
});

async function setup(mode: 'drive' | 'view' = 'drive') {
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const remoteConnection = once(server, 'connection');
  const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
    Response.json({
      ok: true,
      data: String(url).endsWith('/agents')
        ? [{ agentName: 'worker' }]
        : {
            session_id: 'session',
            resume_token: 'resume',
            terminal_url: `ws://127.0.0.1:${(server!.address() as AddressInfo).port}/terminal`,
          },
    })
  );
  proxy = await startFleetNodeAttachProxy({ nodeId: 'node', mode, workspaceKey: 'rk_test', env: {}, fetch });
  const [remote] = (await remoteConnection) as [WebSocket];
  return { remote, fetch };
}
function send(remote: WebSocket, type: string, data = {}) {
  remote.send(JSON.stringify({ session_id: 'session', type, ...data }));
}

it('discovers one agent and pipes raw bytes through a private socket, then removes it', async () => {
  const { remote, fetch } = await setup();
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).agent).toBe('worker');
  expect((await stat(proxy!.socketPath)).mode & 0o777).toBe(0o600);
  local = connect(proxy!.socketPath);
  await once(local, 'connect');
  send(remote, 'terminal.ready', { screen: Buffer.from('hello').toString('base64') });
  expect((await once(local, 'data'))[0].toString()).toBe('hello');
  const frame = once(remote, 'message');
  const bytes = Buffer.from([0x00, 0x1b, 0xff, 0xc3, 0xa9]);
  local.write(bytes);
  expect(JSON.parse((await frame)[0].toString())).toMatchObject({
    type: 'terminal.input',
    data_base64: bytes.toString('base64'),
  });
  const output = once(local, 'data');
  send(remote, 'terminal.output', { chunk: 'world' });
  expect((await output)[0].toString()).toBe('world');
  const socketPath = proxy!.socketPath;
  send(remote, 'terminal.closed');
  await expect(proxy!.finished).resolves.toBe(0);
  await Promise.all([proxy!.close(), proxy!.close()]);
  await expect(stat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('replays output to a late raw client even when an event listener already consumed it', async () => {
  const { remote } = await setup();
  const events = new (await import('ws')).default(`${proxy!.brokerUrl.replace('http', 'ws')}/ws`, {
    headers: { authorization: `Bearer ${proxy!.apiKey}` },
  });
  await once(events, 'open');
  send(remote, 'terminal.ready', { screen: Buffer.from('hello').toString('base64') });
  const consumed = once(events, 'message');
  send(remote, 'terminal.output', { chunk: ' early' });
  await consumed;
  local = connect(proxy!.socketPath);
  let received = '';
  local.on('data', (data: Buffer) => (received += data.toString()));
  await vi.waitFor(() => expect(received).toBe('hello early'));
  events.close();
});

it('replays output to a late event listener even while a raw client consumed it', async () => {
  const { remote } = await setup();
  local = connect(proxy!.socketPath);
  await once(local, 'connect');
  send(remote, 'terminal.ready', { screen: Buffer.from('hello').toString('base64') });
  await once(local, 'data');
  const rawOutput = once(local, 'data');
  send(remote, 'terminal.output', { chunk: ' during-raw' });
  await rawOutput;
  const events = new (await import('ws')).default(`${proxy!.brokerUrl.replace('http', 'ws')}/ws`, {
    headers: { authorization: `Bearer ${proxy!.apiKey}` },
  });
  const [message] = await once(events, 'message');
  expect(JSON.stringify(JSON.parse(String(message)))).toContain('during-raw');
  events.close();
});

it('settles finished on explicit close before terminal.ready', async () => {
  await setup();
  await proxy!.close();
  await expect(proxy!.finished).resolves.toBe(0);
});

it('resolves failure without an unhandled rejection', async () => {
  const { remote } = await setup();
  send(remote, 'terminal.error', { code: 'node_unreachable', message: 'offline' });
  await expect(proxy!.finished).resolves.toBe(1);
});

it('view sockets cannot send terminal input and reject additional clients', async () => {
  const { remote } = await setup('view');
  local = connect(proxy!.socketPath);
  await once(local, 'connect');
  send(remote, 'terminal.ready', { screen: Buffer.from('ready').toString('base64') });
  await once(local, 'data');
  const received = vi.fn();
  remote.on('message', received);
  local.write('ignored');
  const extra = connect(proxy!.socketPath);
  await once(extra, 'close');
  expect(received).not.toHaveBeenCalled();
});

it.each([[], [{ agentName: 'a' }, { agentName: 'b' }]])(
  'rejects missing or ambiguous agents',
  async (...agents) => {
    await expect(
      startFleetNodeAttachProxy({
        nodeId: 'node',
        mode: 'drive',
        workspaceKey: 'rk_test',
        env: {},
        fetch: vi.fn(async () => Response.json({ data: agents.length === 0 ? [] : agents })),
      })
    ).rejects.toMatchObject({ code: 'ambiguous_agent' });
  }
);

it('trusts the DEV Relaycast origin for attach, alongside canonical and Agent37', async () => {
  const { validateFleetAttachBaseUrl } = await import('./attach.js');
  expect(validateFleetAttachBaseUrl('https://dev-cast.agentrelay.com/')).toBe(
    'https://dev-cast.agentrelay.com'
  );
  expect(() => validateFleetAttachBaseUrl('https://evil.example.com')).toThrow('trusted Relaycast origin');
});
