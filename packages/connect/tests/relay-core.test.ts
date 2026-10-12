import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectService, injectedText, messageRef, parseDelivery } from '../src/relay/connect.js';
import { RelayState } from '../src/relay/state.js';
import { delivery, FakeConnectCloud } from './support/fake-connect-cloud.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const TARGET = { kind: 'claude', id: '11111111-2222-3333-4444-555555555555' };

type Outcome = { outcome: string; detail: string };

class FakeInjector {
  injected: Array<{ messageId: string; text: string }> = [];
  observed: string[] = [];
  next: Outcome[] = [];
  observeNext: Outcome[] = [];
  onInject?: (messageId: string) => Promise<void>;
  prepared = 0;
  async prepare() {
    this.prepared += 1;
  }
  async inject(_target: unknown, message: { messageId: string; text: string }) {
    await this.onInject?.(message.messageId);
    this.injected.push(message);
    return this.next.shift() || { outcome: 'delivered', detail: 'ok' };
  }
  async observe(_target: unknown, message: { messageId: string }) {
    this.observed.push(message.messageId);
    return this.observeNext.shift() || { outcome: 'accepted', detail: 'still queued' };
  }
  async preflight() {
    return { ok: true, reason: '' };
  }
}

async function setup() {
  const cloud = await new FakeConnectCloud().start();
  const root = await mkdtemp(join(os.tmpdir(), 'connect-core-test-'));
  cleanups.push(async () => {
    await cloud.stop();
    await rm(root, { recursive: true, force: true });
  });
  let clock = Date.parse('2026-10-12T12:00:00Z');
  const now = () => clock;
  const state = await RelayState.load(join(root, 'state.json'), { now });
  const injector = new FakeInjector();
  const logs: string[] = [];
  const service = new ConnectService({
    state,
    injector,
    env: { AGENT_RELAY_CONNECT_CLOUD_URL: cloud.base },
    now,
    log: (line: string) => logs.push(line),
    replyHint: (sender: string) => `[reply: connect send --to ${sender}]`,
  });
  return {
    cloud,
    state,
    injector,
    service,
    logs,
    statePath: join(root, 'state.json'),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('Node relay Connect service', () => {
  it('formats injected text exactly like the probe', () => {
    const parsed = parseDelivery(
      delivery('d1', 'Hello [there]', { message: { agent_name: 'host [x]', text: 'Hello [there]' } })
    )!;
    expect(injectedText(parsed, '[reply: hint]')).toBe(
      `[Relay Connect — from host (x) · ref ${messageRef('msg-d1')}]\n[reply: hint]\n\nHello [there]`
    );
    expect(messageRef('msg-d1')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('joins once, persists the credential, and answers a repeat join locally', async () => {
    const { cloud, service, injector, statePath } = await setup();
    const joined = await service.join(TARGET, {
      link: 'https://agentrelay.com/connect/conn-1/join',
      name: 'guest-one',
    });
    expect(joined).toMatchObject({
      connect_id: 'conn-1',
      agent_name: 'guest-one',
      role: 'guest',
      warnings: [],
    });
    expect(injector.prepared).toBe(1);
    const again = await service.join(TARGET, { link: 'conn-1' });
    expect(again.connect_id).toBe('conn-1');
    expect(cloud.callsTo('POST', '/cloud/connect/conn-1/join')).toHaveLength(1);
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    expect(saved.sessions[`claude:${TARGET.id}`].token).toBe('participant-token');
    await expect(service.join(TARGET, { link: 'conn-2' })).rejects.toMatchObject({
      code: 'connect_already_joined',
    });
  });

  it('reuses the join idempotency key after a 5xx and clears it after a 4xx', async () => {
    const { cloud, service } = await setup();
    cloud.joinStatus = 503;
    cloud.joinError = { code: 'connect_unavailable', message: 'down' };
    await expect(service.join(TARGET, { link: 'conn-1' })).rejects.toMatchObject({
      code: 'connect_unavailable',
    });
    await expect(service.join(TARGET, { link: 'conn-1' })).rejects.toMatchObject({
      code: 'connect_unavailable',
    });
    const keys = cloud
      .callsTo('POST', '/cloud/connect/conn-1/join')
      .map((call) => call.headers['idempotency-key']);
    expect(keys[0]).toBe(keys[1]);
    await expect(service.join(TARGET, { link: 'conn-1', name: 'other-name' })).rejects.toMatchObject({
      code: 'connect_join_pending',
    });
    cloud.joinStatus = 403;
    cloud.joinError = { code: 'connect_claim_invalid', message: 'bad claim' };
    await expect(service.join(TARGET, { link: 'conn-1' })).rejects.toMatchObject({
      code: 'connect_claim_invalid',
    });
    cloud.joinError = null;
    await service.join(TARGET, { link: 'conn-1' });
    const last = cloud.callsTo('POST', '/cloud/connect/conn-1/join').at(-1)!;
    expect(last.headers['idempotency-key']).not.toBe(keys[0]);
  });

  it('injects, persists before injecting, acks, and never injects a settled delivery again', async () => {
    const { cloud, service, injector, statePath } = await setup();
    await service.join(TARGET, { link: 'conn-1' });
    cloud.deliveries.push(delivery('d1', 'first'));
    injector.onInject = async () => {
      const saved = JSON.parse(await readFile(statePath, 'utf8'));
      expect(saved.pending['agent-guest:d1']).toBe('msg-d1');
    };
    await service.pollAll();
    expect(injector.injected.map((m) => m.messageId)).toEqual(['msg-d1']);
    expect(injector.injected[0].text).toContain('[reply: connect send --to host-agent]');
    expect(cloud.callsTo('POST', '/v1/deliveries/d1/ack')).toHaveLength(1);

    // Relaycast redrives an item whose ack was lost: re-acked from the ledger.
    cloud.deliveries[0].status = 'delivered';
    await service.pollAll();
    expect(injector.injected).toHaveLength(1);
    expect(cloud.callsTo('POST', '/v1/deliveries/d1/ack')).toHaveLength(2);
  });

  it('fails an in-doubt handoff without retry and never resends it', async () => {
    const { cloud, service, injector } = await setup();
    await service.join(TARGET, { link: 'conn-1' });
    cloud.deliveries.push(delivery('d1', 'first'));
    injector.next.push({ outcome: 'in_doubt', detail: 'socket closed mid-write' });
    await service.pollAll();
    const fail = cloud.callsTo('POST', '/v1/deliveries/d1/fail');
    expect(fail).toHaveLength(1);
    expect(fail[0].body).toEqual({
      error: 'In doubt; not resent — socket closed mid-write',
      retryable: false,
    });
    cloud.deliveries[0].status = 'queued';
    await service.pollAll();
    expect(injector.injected).toHaveLength(1);
  });

  it('backs off a waiting head and keeps later items behind it, then gives up after the handoff TTL', async () => {
    const { cloud, service, injector, advance } = await setup();
    await service.join(TARGET, { link: 'conn-1' });
    cloud.deliveries.push(delivery('d1', 'first'), delivery('d2', 'second'));
    injector.next.push({ outcome: 'waiting', detail: 'session not running' });
    await service.pollAll();
    expect(injector.injected.map((m) => m.messageId)).toEqual(['msg-d1']);
    await service.pollAll();
    expect(injector.injected).toHaveLength(1);
    advance(5_000);
    injector.next.push({ outcome: 'waiting', detail: 'session not running' });
    await service.pollAll();
    expect(injector.injected.map((m) => m.messageId)).toEqual(['msg-d1', 'msg-d1']);
    advance(60 * 60_000);
    injector.next.push({ outcome: 'waiting', detail: 'session not running' });
    await service.pollAll();
    expect(cloud.callsTo('POST', '/v1/deliveries/d1/fail')[0].body.error).toContain(
      'The local session remained unavailable without accepting the handoff'
    );
    expect(injector.injected.at(-1)!.messageId).toBe('msg-d2');
  });

  it('only observes a delivery the provider queue accepted, and lets later items pass', async () => {
    const { cloud, service, injector, advance } = await setup();
    await service.join(TARGET, { link: 'conn-1' });
    cloud.deliveries.push(delivery('d1', 'first'), delivery('d2', 'second'));
    injector.next.push({ outcome: 'accepted', detail: 'queued' });
    await service.pollAll();
    expect(injector.injected.map((m) => m.messageId)).toEqual(['msg-d1', 'msg-d2']);
    advance(5_000);
    injector.observeNext.push({ outcome: 'delivered', detail: 'recorded in the rollout' });
    await service.pollAll();
    expect(injector.observed).toEqual(['msg-d1']);
    expect(injector.injected).toHaveLength(2);
    expect(cloud.callsTo('POST', '/v1/deliveries/d1/ack')).toHaveLength(1);
  });

  it('acks its own messages and messages not addressed to it without injecting', async () => {
    const { cloud, service, injector } = await setup();
    await service.join(TARGET, { link: 'conn-1' });
    cloud.deliveries.push(
      delivery('own', 'mine', { message: { agent_name: 'guest-one', text: 'mine' } }),
      delivery('chan', 'channel chatter', { reason: 'channel' })
    );
    await service.pollAll();
    expect(injector.injected).toEqual([]);
    expect(cloud.callsTo('POST', '/v1/deliveries/own/ack')).toHaveLength(1);
    expect(cloud.callsTo('POST', '/v1/deliveries/chan/ack')).toHaveLength(1);
  });

  it('sends with a per-recipient idempotency key and names each failure cause', async () => {
    const { cloud, service, logs } = await setup();
    await service.join(TARGET, { link: 'conn-1' });
    await expect(
      service.send(TARGET, 'hi', { to: 'host-agent', requestKey: 'req-1' })
    ).resolves.toMatchObject({
      sent: [{ to: 'host-agent' }],
    });
    expect(cloud.callsTo('POST', '/v1/dm')[0].headers['idempotency-key']).toBe(
      'connect-send:req-1:host-agent'
    );

    cloud.apiErrors.set('POST /v1/dm', { status: 401, code: 'unauthorized' });
    await expect(service.send(TARGET, 'hi', { to: 'host-agent' })).rejects.toMatchObject({
      status: 503,
      code: 'connect_auth_rejected',
    });
    cloud.apiErrors.set('POST /v1/dm', { status: 500, code: 'internal_error' });
    await expect(service.send(TARGET, 'hi', { to: 'host-agent' })).rejects.toMatchObject({
      status: 502,
      code: 'connect_upstream_error',
    });
    expect(
      logs.some(
        (line) => line.includes('code=connect_auth_rejected') && line.includes('cause=http_401:unauthorized')
      )
    ).toBe(true);
    expect(logs.join('\n')).not.toContain('participant-token');

    cloud.apiErrors.set('POST /v1/dm', { status: 401, code: 'unauthorized' });
    cloud.availability = { status: 410, code: 'connect_ended' };
    await expect(service.send(TARGET, 'hi', { to: 'host-agent' })).rejects.toMatchObject({
      code: 'connect_ended',
    });
    await expect(service.status(TARGET)).rejects.toMatchObject({ code: 'connect_not_joined' });
  });

  it('reports presence from the roster', async () => {
    const { service } = await setup();
    await service.join(TARGET, { link: 'conn-1' });
    const status = await service.status(TARGET);
    expect(status.participants).toEqual([
      { agent_name: 'host-agent', role: 'host', online: true },
      { agent_name: 'guest-one', role: 'guest', online: true },
    ]);
  });

  it('leaves through Cloud and Relaycast, then forgets the credential', async () => {
    const { cloud, service, statePath } = await setup();
    await service.join(TARGET, { link: 'conn-1' });
    await expect(service.leave(TARGET)).resolves.toEqual({ left: true, connect_id: 'conn-1' });
    expect(cloud.callsTo('POST', '/cloud/connect/conn-1/leave')[0].headers.authorization).toBe(
      'Bearer participant-token'
    );
    // Cloud deleted the agent, so no Relaycast disconnect follows.
    expect(cloud.callsTo('POST', '/v1/agents/disconnect')).toHaveLength(0);
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    expect(saved.sessions).toEqual({});
  });

  it('still leaves locally when Cloud has no leave route yet', async () => {
    const { cloud, service, logs } = await setup();
    await service.join(TARGET, { link: 'conn-1' });
    cloud.apiErrors.set('POST /cloud/connect/conn-1/leave', { status: 404, code: 'connect_route_not_found' });
    await expect(service.leave(TARGET)).resolves.toMatchObject({ left: true });
    expect(logs.some((line) => line.includes('relay connect leave failed'))).toBe(true);
    expect(cloud.callsTo('POST', '/v1/agents/disconnect')).toHaveLength(1);
  });

  it('closes an expired Connect and injects one notice', async () => {
    const { cloud, service, injector, advance } = await setup();
    cloud.expiresAt = '2026-10-12T12:30:00Z';
    await service.join(TARGET, { link: 'conn-1' });
    advance(31 * 60_000);
    await service.pollAll();
    await service.pollAll();
    expect(injector.injected.map((m) => m.text)).toEqual([
      '[Relay Connect] This Connect expired. Its local credential was removed.',
    ]);
    await expect(service.status(TARGET)).rejects.toMatchObject({ code: 'connect_not_joined' });
  });
});
