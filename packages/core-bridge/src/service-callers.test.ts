import { describe, expect, it, vi } from 'vitest';

import type { CallOptions, CoreClient, HelloResult } from './client.js';
import { CoreBridgeError, CoreRpcError } from './errors.js';
import type { CallerFileDescriptor } from './auth.js';
import {
  INBOX_NEXT_CALL_GRACE_MS,
  MAX_INBOX_NEXT_TIMEOUT_MS,
  SERVICE_CALLER_DISCONNECT_METHOD,
  SERVICE_CALLER_IDENTITY_METHOD,
  SERVICE_CALLER_INBOX_ACK_METHOD,
  SERVICE_CALLER_INBOX_CLOSE_METHOD,
  SERVICE_CALLER_INBOX_FAIL_METHOD,
  SERVICE_CALLER_INBOX_NEXT_METHOD,
  SERVICE_CALLER_INBOX_OPEN_METHOD,
  assertServiceCallerIdentity,
  serviceCallerDisconnect,
  serviceCallerIdentity,
  serviceCallerInboxAck,
  serviceCallerInboxClose,
  serviceCallerInboxFail,
  serviceCallerInboxNext,
  serviceCallerInboxOpen,
} from './service-callers.js';

const METHODS = [
  SERVICE_CALLER_IDENTITY_METHOD,
  SERVICE_CALLER_INBOX_OPEN_METHOD,
  SERVICE_CALLER_INBOX_NEXT_METHOD,
  SERVICE_CALLER_INBOX_ACK_METHOD,
  SERVICE_CALLER_INBOX_FAIL_METHOD,
  SERVICE_CALLER_INBOX_CLOSE_METHOD,
  SERVICE_CALLER_DISCONNECT_METHOD,
];

const IDENTITY = {
  publisher: { id: 'agent_1', name: 'relayflows' },
  node: { id: 'node_1', name: 'laptop' },
  base_url: 'https://relay.example',
  workspace_id: 'ws_1',
  relaycast_workspace_id: 'rcws_1',
};

const DESCRIPTOR_IDENTITY = {
  publisher: IDENTITY.publisher,
  workspace: {
    base_url: IDENTITY.base_url,
    workspace_id: IDENTITY.workspace_id,
    relaycast_workspace_id: IDENTITY.relaycast_workspace_id,
  },
} as CallerFileDescriptor;

const TEXT_DELIVERY = {
  item_id: 'item_1',
  message_id: 'msg_1',
  sender: { id: 'agent_2', name: 'worker-1' },
  text: 'done',
  invocation_id: 'inv_1',
  sent_at: '2026-11-09T00:00:00Z',
};

const FAILED_DELIVERY = {
  item_id: 'item_2',
  message_id: 'msg_2',
  sender: { id: 'agent_3', name: 'worker-2' },
  failure: { code: 'result_too_large', bytes: 600_000, limit: 524_288 },
  invocation_id: 'inv_2',
  sent_at: '2026-11-09T00:00:01.123Z',
};

function fakeClient(
  replies: Partial<Record<string, unknown>> = {},
  methods: string[] = METHODS
): {
  client: CoreClient;
  calls: Array<{ method: string; params: unknown; options: CallOptions | undefined }>;
} {
  const calls: Array<{ method: string; params: unknown; options: CallOptions | undefined }> = [];
  const hello: HelloResult = {
    bridge_version: 2,
    daemon_version: '2026.11.2',
    pid: 1,
    methods,
    topics: [],
  };
  const defaults: Record<string, unknown> = {
    [SERVICE_CALLER_IDENTITY_METHOD]: IDENTITY,
    [SERVICE_CALLER_INBOX_OPEN_METHOD]: { iterator_id: `it_${'a'.repeat(32)}` },
    [SERVICE_CALLER_INBOX_NEXT_METHOD]: { delivery: TEXT_DELIVERY },
    [SERVICE_CALLER_INBOX_ACK_METHOD]: {
      item_id: 'item_1',
      message_id: 'msg_1',
      action: 'ack',
      state: 'acked',
      settled_at_ms: 7,
    },
    [SERVICE_CALLER_INBOX_FAIL_METHOD]: {
      item_id: 'item_2',
      message_id: 'msg_2',
      action: 'fail',
      state: 'failed',
      settled_at_ms: 8,
    },
    [SERVICE_CALLER_INBOX_CLOSE_METHOD]: {},
    [SERVICE_CALLER_DISCONNECT_METHOD]: {},
  };
  const client = {
    hello,
    socket: '/tmp/core.sock',
    closed: false,
    call: vi.fn(async (method: string, params?: unknown, options?: CallOptions) => {
      calls.push({ method, params, options });
      return Object.hasOwn(replies, method) ? replies[method] : defaults[method];
    }),
  } as unknown as CoreClient;
  return { client, calls };
}

async function bridgeError(promise: Promise<unknown>, code: string): Promise<CoreBridgeError> {
  const error = await promise.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(CoreBridgeError);
  expect((error as CoreBridgeError).code).toBe(code);
  return error as CoreBridgeError;
}

describe('service-caller helpers', () => {
  it('pins the authenticated publisher and workspace to caller.json before spawn', () => {
    expect(() => assertServiceCallerIdentity(DESCRIPTOR_IDENTITY, IDENTITY)).not.toThrow();
    for (const mismatch of [
      { ...IDENTITY, publisher: { ...IDENTITY.publisher, id: 'agent_other' } },
      { ...IDENTITY, publisher: { ...IDENTITY.publisher, name: 'other' } },
      { ...IDENTITY, base_url: 'https://other.example' },
      { ...IDENTITY, workspace_id: 'ws_other' },
      { ...IDENTITY, relaycast_workspace_id: 'rcws_other' },
    ]) {
      const error = (() => {
        try {
          assertServiceCallerIdentity(DESCRIPTOR_IDENTITY, mismatch);
        } catch (value) {
          return value;
        }
      })();
      expect(error).toBeInstanceOf(CoreBridgeError);
      expect(error).toMatchObject({ code: 'caller_identity_mismatch' });
      expect((error as Error).message).not.toContain('agent_other');
      expect((error as Error).message).not.toContain('ws_other');
    }
  });

  it('send only the bound schema-v2 params and exact settlement metadata', async () => {
    const { client, calls } = fakeClient();
    const signal = new AbortController().signal;
    await serviceCallerIdentity(client, { signal });
    await serviceCallerInboxOpen(client, 'inv_1', { signal });
    await serviceCallerInboxNext(client, `it_${'a'.repeat(32)}`, 1234, { signal });
    await serviceCallerInboxAck(client, 'item_1', { signal });
    await serviceCallerInboxFail(client, 'item_2', { signal });
    await serviceCallerInboxClose(client, `it_${'a'.repeat(32)}`, { signal });
    await serviceCallerDisconnect(client, { signal });

    expect(calls.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: SERVICE_CALLER_IDENTITY_METHOD, params: {} },
      { method: SERVICE_CALLER_INBOX_OPEN_METHOD, params: { invocation_id: 'inv_1' } },
      {
        method: SERVICE_CALLER_INBOX_NEXT_METHOD,
        params: { iterator_id: `it_${'a'.repeat(32)}`, timeout_ms: 1234 },
      },
      {
        method: SERVICE_CALLER_INBOX_ACK_METHOD,
        params: { item_id: 'item_1', metadata: { relayflows_result: 'journaled' } },
      },
      {
        method: SERVICE_CALLER_INBOX_FAIL_METHOD,
        params: { item_id: 'item_2', metadata: { relayflows_result: 'rejected' } },
      },
      {
        method: SERVICE_CALLER_INBOX_CLOSE_METHOD,
        params: { iterator_id: `it_${'a'.repeat(32)}` },
      },
      { method: SERVICE_CALLER_DISCONNECT_METHOD, params: {} },
    ]);
    for (const call of calls) {
      expect(call.params).not.toHaveProperty('caller_name');
      expect(call.params).not.toHaveProperty('caller_secret');
      expect(call.options?.signal).toBe(signal);
    }
    expect(calls[2].options).toEqual({ signal, timeoutMs: 1234 + INBOX_NEXT_CALL_GRACE_MS });
  });

  it('preserves an explicit transport timeout on long polls', async () => {
    const { client, calls } = fakeClient({ [SERVICE_CALLER_INBOX_NEXT_METHOD]: { delivery: null } });
    await expect(
      serviceCallerInboxNext(client, `it_${'a'.repeat(32)}`, MAX_INBOX_NEXT_TIMEOUT_MS, {
        timeoutMs: 42_000,
      })
    ).resolves.toEqual({ delivery: null });
    expect(calls[0].options).toEqual({ timeoutMs: 42_000 });
  });

  it('returns checked identity, text, failure and settlement replies', async () => {
    const textClient = fakeClient();
    await expect(serviceCallerIdentity(textClient.client)).resolves.toEqual(IDENTITY);
    await expect(serviceCallerInboxNext(textClient.client, `it_${'a'.repeat(32)}`, 0)).resolves.toEqual({
      delivery: TEXT_DELIVERY,
    });

    const failureClient = fakeClient({
      [SERVICE_CALLER_INBOX_NEXT_METHOD]: { delivery: FAILED_DELIVERY },
    });
    await expect(serviceCallerInboxNext(failureClient.client, `it_${'a'.repeat(32)}`, 0)).resolves.toEqual({
      delivery: FAILED_DELIVERY,
    });
    await expect(serviceCallerInboxAck(textClient.client, 'item_1')).resolves.toMatchObject({
      action: 'ack',
      state: 'acked',
    });
    await expect(serviceCallerInboxFail(textClient.client, 'item_2')).resolves.toMatchObject({
      action: 'fail',
      state: 'failed',
    });
  });

  it('refuse malformed local ids and poll deadlines before calling the core', async () => {
    const { client, calls } = fakeClient();
    await bridgeError(serviceCallerInboxOpen(client, 'bad invocation'), 'invalid_params');
    await bridgeError(serviceCallerInboxNext(client, 'it_bad', 1), 'invalid_params');
    await bridgeError(
      serviceCallerInboxNext(client, `it_${'a'.repeat(32)}`, MAX_INBOX_NEXT_TIMEOUT_MS + 1),
      'invalid_params'
    );
    await bridgeError(serviceCallerInboxAck(client, 'bad item'), 'invalid_params');
    await bridgeError(serviceCallerInboxClose(client, 'it_bad'), 'invalid_params');
    expect(calls).toEqual([]);
  });

  it('feature-detect every method before sending anything', async () => {
    for (const method of METHODS) {
      const { client, calls } = fakeClient(
        {},
        METHODS.filter((candidate) => candidate !== method)
      );
      const call =
        method === SERVICE_CALLER_IDENTITY_METHOD
          ? serviceCallerIdentity(client)
          : method === SERVICE_CALLER_INBOX_OPEN_METHOD
            ? serviceCallerInboxOpen(client, 'inv_1')
            : method === SERVICE_CALLER_INBOX_NEXT_METHOD
              ? serviceCallerInboxNext(client, `it_${'a'.repeat(32)}`, 0)
              : method === SERVICE_CALLER_INBOX_ACK_METHOD
                ? serviceCallerInboxAck(client, 'item_1')
                : method === SERVICE_CALLER_INBOX_FAIL_METHOD
                  ? serviceCallerInboxFail(client, 'item_2')
                  : method === SERVICE_CALLER_INBOX_CLOSE_METHOD
                    ? serviceCallerInboxClose(client, `it_${'a'.repeat(32)}`)
                    : serviceCallerDisconnect(client);
      const error = await call.catch((value: unknown) => value);
      expect(error).toBeInstanceOf(CoreRpcError);
      expect(error).toMatchObject({ kind: 'method_not_found', retryable: false });
      expect(calls).toEqual([]);
    }
  });

  it.each([
    ['identity', SERVICE_CALLER_IDENTITY_METHOD, { ...IDENTITY, base_url: 'file:///tmp/x' }],
    ['open', SERVICE_CALLER_INBOX_OPEN_METHOD, { iterator_id: 'it_bad' }],
    ['missing delivery', SERVICE_CALLER_INBOX_NEXT_METHOD, {}],
    [
      'both text and failure',
      SERVICE_CALLER_INBOX_NEXT_METHOD,
      { delivery: { ...TEXT_DELIVERY, failure: FAILED_DELIVERY.failure } },
    ],
    [
      'unknown failure',
      SERVICE_CALLER_INBOX_NEXT_METHOD,
      { delivery: { ...FAILED_DELIVERY, failure: { ...FAILED_DELIVERY.failure, code: 'other' } } },
    ],
    [
      'ack mismatch',
      SERVICE_CALLER_INBOX_ACK_METHOD,
      { item_id: 'item_1', message_id: 'msg_1', action: 'fail', state: 'failed', settled_at_ms: 7 },
    ],
    ['close', SERVICE_CALLER_INBOX_CLOSE_METHOD, null],
    ['disconnect', SERVICE_CALLER_DISCONNECT_METHOD, null],
  ])('fail closed on malformed %s replies', async (_label, method, reply) => {
    const { client } = fakeClient({ [method]: reply });
    const call =
      method === SERVICE_CALLER_IDENTITY_METHOD
        ? serviceCallerIdentity(client)
        : method === SERVICE_CALLER_INBOX_OPEN_METHOD
          ? serviceCallerInboxOpen(client, 'inv_1')
          : method === SERVICE_CALLER_INBOX_NEXT_METHOD
            ? serviceCallerInboxNext(client, `it_${'a'.repeat(32)}`, 0)
            : method === SERVICE_CALLER_INBOX_ACK_METHOD
              ? serviceCallerInboxAck(client, 'item_1')
              : method === SERVICE_CALLER_INBOX_CLOSE_METHOD
                ? serviceCallerInboxClose(client, `it_${'a'.repeat(32)}`)
                : serviceCallerDisconnect(client);
    const error = await call.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CoreRpcError);
    expect(error).toMatchObject({ kind: 'internal', retryable: false });
  });
});
