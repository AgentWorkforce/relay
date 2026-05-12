import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';

import {
  createAgentEvent,
  createCronTickEvent,
  events,
  flushRuntimeOtelForTests,
  initializeRuntimeOtel,
  injectTraceContextIntoCarrier,
  NoRetry,
  resetRuntimeOtelForTests,
  toAgentEventRecord,
  withRuntimeSpan,
} from '../src/index.ts';

class TestWebSocket {
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readonly sent: string[] = [];

  constructor() {
    queueMicrotask(() => {
      this.onopen?.();
    });
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

test('remote gateway deliveries ack after a successful handler run', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    static readonly OPEN = 1;
  } as typeof globalThis.WebSocket;

  try {
    const socket = new TestWebSocket();
    const seen: number[] = [];
    const event = createCronTickEvent({
      workspace: 'support',
      scheduleId: 'sched-ack',
      schedule: '*/5 * * * *',
      scheduledFor: '2026-05-11T12:00:00.000Z',
    });

    const stream = events({
      workspace: 'support',
      apiKey: 'relay_ws_test',
      webSocketFactory: () => socket as never,
      onEvent: async (event) => {
        seen.push(event.attempt);
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    socket.receive({ type: 'subscribed' });
    await stream.ready;

    socket.receive({
      type: 'event',
      event: toAgentEventRecord(event),
    });
    await new Promise((resolve) => setImmediate(resolve));

    const sentMessages = socket.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
    assert.equal(sentMessages[0]?.type, 'subscribe');
    assert.deepEqual(sentMessages.at(-1), {
      type: 'ack',
      eventId: event.id,
    });
    assert.deepEqual(seen, [1]);

    await stream.close();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test('remote deliveries preserve parent span context and nest ctx.expand under the handler span', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    static readonly OPEN = 1;
  } as typeof globalThis.WebSocket;

  await resetRuntimeOtelForTests();
  const exporter = new InMemorySpanExporter();
  initializeRuntimeOtel({
    enabled: true,
    exporter,
    serviceName: 'agent-relay-events-test',
  });

  try {
    const socket = new TestWebSocket();
    const event = createAgentEvent({
      id: 'evt_trace_1',
      workspace: 'support',
      type: 'relayfile.changed',
      resource: {
        path: '/linear/issues/ENG-500.json',
        kind: 'linear.issue',
        id: 'ENG-500',
        provider: 'linear',
      },
      summary: {
        title: 'ENG-500',
        status: 'Todo',
      },
    });

    const stream = events({
      workspace: 'support',
      apiKey: 'relay_ws_test',
      webSocketFactory: () => socket as never,
      onEvent: async (incoming) => {
        await incoming.expand('full');
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    socket.receive({ type: 'subscribed' });
    await stream.ready;

    await withRuntimeSpan('agent.gateway.test-parent', {}, async () => {
      const carrier = injectTraceContextIntoCarrier({});
      socket.receive({
        type: 'event',
        event: {
          ...toAgentEventRecord(event),
          ...carrier,
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
    });

    const expandRequest = socket.sent
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .find((payload) => payload.type === 'expand');
    assert.equal(typeof expandRequest?.traceparent, 'string');

    socket.receive({
      type: 'expand_result',
      requestId: expandRequest?.requestId,
      expansion: {
        level: 'full',
        path: '/linear/issues/ENG-500.json',
        data: {
          id: 'ENG-500',
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    await flushRuntimeOtelForTests();
    const spans = exporter.getFinishedSpans();
    const parent = spans.find((span) => span.name === 'agent.gateway.test-parent');
    const delivery = spans.find((span) => span.name === 'agent.sdk.event.delivery');
    const handler = spans.find((span) => span.name === 'agent.sdk.event.handler');
    const expand = spans.find((span) => span.name === 'agent.sdk.ctx.expand');

    assert.ok(parent);
    assert.ok(delivery);
    assert.ok(handler);
    assert.ok(expand);
    assert.equal(delivery?.parentSpanContext?.spanId, parent?.spanContext().spanId);
    assert.equal(handler?.parentSpanContext?.spanId, delivery?.spanContext().spanId);
    assert.equal(expand?.parentSpanContext?.spanId, handler?.spanContext().spanId);

    await stream.close();
  } finally {
    await resetRuntimeOtelForTests();
    globalThis.WebSocket = originalWebSocket;
  }
});

test('remote gateway deliveries nack handler failures and reserve onError for terminal failures', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    static readonly OPEN = 1;
  } as typeof globalThis.WebSocket;

  try {
    const socket = new TestWebSocket();
    let errors = 0;
    const event = createCronTickEvent({
      workspace: 'support',
      scheduleId: 'sched-nack',
      schedule: 'oneshot:no-retry',
      scheduledFor: '2026-05-11T12:00:00.000Z',
    });

    const stream = events({
      workspace: 'support',
      apiKey: 'relay_ws_test',
      webSocketFactory: () => socket as never,
      onEvent: async () => {
        throw new NoRetry('do not retry');
      },
      onError: async () => {
        errors += 1;
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    socket.receive({ type: 'subscribed' });
    await stream.ready;

    socket.receive({
      type: 'event',
      event: toAgentEventRecord(event),
    });
    await new Promise((resolve) => setImmediate(resolve));

    const sentMessages = socket.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
    assert.deepEqual(sentMessages.at(-1), {
      type: 'nack',
      eventId: event.id,
      error: 'do not retry',
      noRetry: true,
    });
    assert.equal(errors, 0);

    await stream.close();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test('relayfile change events dispatch with the canonical shared shape and expand over the gateway RPC', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    static readonly OPEN = 1;
  } as typeof globalThis.WebSocket;

  try {
    const socket = new TestWebSocket();
    const seen: Array<{ type: string; path: string; currentStatus?: string }> = [];
    const event = createAgentEvent({
      id: 'evt_rf_1',
      workspace: 'support',
      type: 'relayfile.changed',
      agentId: 'agent-sdk',
      resource: {
        path: '/linear/issues/ENG-412.json',
        kind: 'linear.issue',
        id: 'ENG-412',
        provider: 'linear',
      },
      summary: {
        title: 'ENG-412',
        status: 'In Progress',
      },
    });

    const stream = events({
      workspace: 'support',
      apiKey: 'relay_ws_test',
      webSocketFactory: () => socket as never,
      onEvent: async (incoming) => {
        assert.equal(incoming.type, 'relayfile.changed');
        seen.push({
          type: incoming.type,
          path: incoming.path,
          currentStatus: incoming.current?.status as string | undefined,
        });
        assert.equal(incoming.agentId, 'agent-sdk');
        const full = await incoming.expand('full');
        assert.deepEqual(full, {
          level: 'full',
          path: '/linear/issues/ENG-412.json',
          data: {
            id: 'ENG-412',
            title: 'ENG-412',
          },
          digest: 'sha256:eng-412',
        });
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    socket.receive({ type: 'subscribed' });
    await stream.ready;

    socket.receive({
      type: 'event',
      event: toAgentEventRecord(event),
    });
    await new Promise((resolve) => setImmediate(resolve));

    const sentBeforeResult = socket.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
    const expandRequest = sentBeforeResult.find((payload) => payload.type === 'expand');
    assert.equal(typeof expandRequest?.traceparent, 'string');
    assert.deepEqual(expandRequest, {
      type: 'expand',
      requestId: expandRequest?.requestId,
      eventId: 'evt_rf_1',
      level: 'full',
      traceparent: expandRequest?.traceparent,
    });

    socket.receive({
      type: 'expand_result',
      requestId: expandRequest?.requestId,
      expansion: {
        level: 'full',
        path: '/linear/issues/ENG-412.json',
        data: {
          id: 'ENG-412',
          title: 'ENG-412',
        },
        digest: 'sha256:eng-412',
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    const sentAfterResult = socket.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
    assert.deepEqual(sentAfterResult.at(-1), {
      type: 'ack',
      eventId: 'evt_rf_1',
    });
    assert.deepEqual(seen, [
      {
        type: 'relayfile.changed',
        path: '/linear/issues/ENG-412.json',
        currentStatus: 'In Progress',
      },
    ]);

    await stream.close();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test('thread expansions forward cursor and limit over the gateway RPC', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    static readonly OPEN = 1;
  } as typeof globalThis.WebSocket;

  try {
    const socket = new TestWebSocket();
    let threadExpansion:
      | {
          level: 'thread';
          items: Array<{
            id: string;
            author: { id: string; displayName: string };
            createdAt: string;
            body: string;
            kind: 'comment' | 'reply' | 'system';
          }>;
          hasMore: boolean;
          cursor?: string;
        }
      | undefined;
    const event = createAgentEvent({
      id: 'evt_thread_1',
      workspace: 'support',
      type: 'relayfile.changed',
      resource: {
        path: '/slack/channels/C123/threads/1715000000_000100/meta.json',
        kind: 'slack.resource',
        id: 'C123:1715000000.000100',
        provider: 'slack',
      },
    });

    const stream = events({
      workspace: 'support',
      apiKey: 'relay_ws_test',
      webSocketFactory: () => socket as never,
      onEvent: async (incoming) => {
        threadExpansion = await incoming.expand('thread', {
          cursor: 'cursor-2',
          limit: 10,
        });
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    socket.receive({ type: 'subscribed' });
    await stream.ready;

    socket.receive({
      type: 'event',
      event: toAgentEventRecord(event),
    });
    await new Promise((resolve) => setImmediate(resolve));

    const expandRequest = socket.sent
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .find((payload) => payload.type === 'expand');
    assert.equal(typeof expandRequest?.traceparent, 'string');
    assert.deepEqual(expandRequest, {
      type: 'expand',
      requestId: expandRequest?.requestId,
      eventId: 'evt_thread_1',
      level: 'thread',
      params: {
        cursor: 'cursor-2',
        limit: 10,
      },
      traceparent: expandRequest?.traceparent,
    });

    socket.receive({
      type: 'expand_result',
      requestId: expandRequest?.requestId,
      expansion: {
        level: 'thread',
        items: [
          {
            id: 'reply-2',
            author: { id: 'usr_2', displayName: 'Grace' },
            createdAt: '2026-05-12T00:00:00.000Z',
            body: 'next reply',
            kind: 'reply',
          },
        ],
        hasMore: false,
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(threadExpansion, {
      level: 'thread',
      items: [
        {
          id: 'reply-2',
          author: { id: 'usr_2', displayName: 'Grace' },
          createdAt: '2026-05-12T00:00:00.000Z',
          body: 'next reply',
          kind: 'reply',
        },
      ],
      hasMore: false,
    });

    await stream.close();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test('registerWatches forwards structured watch registrations to the gateway', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    static readonly OPEN = 1;
  } as typeof globalThis.WebSocket;

  try {
    const socket = new TestWebSocket();
    const stream = events({
      workspace: 'support',
      apiKey: 'relay_ws_test',
      webSocketFactory: () => socket as never,
      onEvent: async () => {},
    });

    await new Promise((resolve) => setImmediate(resolve));
    socket.receive({ type: 'subscribed' });
    await stream.ready;

    const registerPromise = stream.registerWatches([
      {
        glob: '/linear/issues/**',
        replayOnStart: 'since:2026-05-11T00:00:00.000Z',
        coalesceMs: 50,
        maxBacklog: 25,
      },
      {
        glob: ['/github/prs/**', '/jira/issues/**'],
        replayOnStart: 'last:5',
      },
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    socket.receive({ type: 'registered', schedules: [], watches: [] });
    await registerPromise;

    const sentMessages = socket.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
    assert.deepEqual(sentMessages.at(-1), {
      type: 'register',
      watch: [
        {
          glob: '/linear/issues/**',
          replayOnStart: 'since:2026-05-11T00:00:00.000Z',
          coalesceMs: 50,
          maxBacklog: 25,
        },
        {
          glob: ['/github/prs/**', '/jira/issues/**'],
          replayOnStart: 'last:5',
        },
      ],
    });

    await stream.close();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test('file RPC helpers use the gateway control channel', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    static readonly OPEN = 1;
  } as typeof globalThis.WebSocket;

  try {
    const socket = new TestWebSocket();
    const stream = events({
      workspace: 'support',
      apiKey: 'relay_ws_test',
      webSocketFactory: () => socket as never,
      onEvent: async () => {},
    });

    await new Promise((resolve) => setImmediate(resolve));
    socket.receive({ type: 'subscribed' });
    await stream.ready;

    const readPromise = stream.readFile('/docs/readme.md');
    await new Promise((resolve) => setImmediate(resolve));
    const readRequest = JSON.parse(socket.sent.at(-1) ?? '{}') as Record<string, unknown>;
    assert.equal(typeof readRequest.traceparent, 'string');
    assert.deepEqual(readRequest, {
      type: 'files_read',
      requestId: readRequest.requestId,
      path: '/docs/readme.md',
      traceparent: readRequest.traceparent,
    });
    socket.receive({
      type: 'files_read_result',
      requestId: readRequest.requestId,
      file: {
        path: '/docs/readme.md',
        revision: 'rev-1',
        contentType: 'text/markdown',
        content: '# Readme',
      },
    });
    assert.deepEqual(await readPromise, {
      path: '/docs/readme.md',
      revision: 'rev-1',
      contentType: 'text/markdown',
      content: '# Readme',
    });

    const listPromise = stream.listFiles('/docs/*.md');
    await new Promise((resolve) => setImmediate(resolve));
    const listRequest = JSON.parse(socket.sent.at(-1) ?? '{}') as Record<string, unknown>;
    assert.equal(typeof listRequest.traceparent, 'string');
    assert.deepEqual(listRequest, {
      type: 'files_list',
      requestId: listRequest.requestId,
      glob: '/docs/*.md',
      traceparent: listRequest.traceparent,
    });
    socket.receive({
      type: 'files_list_result',
      requestId: listRequest.requestId,
      entries: [{ path: '/docs/readme.md' }],
    });
    assert.deepEqual(await listPromise, [{ path: '/docs/readme.md' }]);

    await stream.close();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test('message RPC helpers use the gateway control channel', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    static readonly OPEN = 1;
  } as typeof globalThis.WebSocket;

  try {
    const socket = new TestWebSocket();
    const stream = events({
      workspace: 'support',
      apiKey: 'relay_ws_test',
      webSocketFactory: () => socket as never,
      onEvent: async () => {},
    });

    await new Promise((resolve) => setImmediate(resolve));
    socket.receive({ type: 'subscribed' });
    await stream.ready;

    const postPromise = stream.postMessage('ops', 'hello', {
      idempotencyKey: 'idem-1',
    });
    await new Promise((resolve) => setImmediate(resolve));
    const postRequest = JSON.parse(socket.sent.at(-1) ?? '{}') as Record<string, unknown>;
    assert.equal(typeof postRequest.traceparent, 'string');
    assert.deepEqual(postRequest, {
      type: 'messages_post',
      requestId: postRequest.requestId,
      channel: 'ops',
      text: 'hello',
      opts: {
        idempotencyKey: 'idem-1',
      },
      traceparent: postRequest.traceparent,
    });
    socket.receive({
      type: 'messages_result',
      requestId: postRequest.requestId,
      id: 'msg-1',
    });
    assert.deepEqual(await postPromise, { id: 'msg-1' });

    const replyPromise = stream.replyMessage('thread-1', 'ack');
    await new Promise((resolve) => setImmediate(resolve));
    const replyRequest = JSON.parse(socket.sent.at(-1) ?? '{}') as Record<string, unknown>;
    assert.equal(typeof replyRequest.traceparent, 'string');
    assert.deepEqual(replyRequest, {
      type: 'messages_reply',
      requestId: replyRequest.requestId,
      threadId: 'thread-1',
      text: 'ack',
      traceparent: replyRequest.traceparent,
    });
    socket.receive({
      type: 'messages_result',
      requestId: replyRequest.requestId,
      id: 'msg-2',
    });
    assert.deepEqual(await replyPromise, { id: 'msg-2' });

    const dmPromise = stream.sendDm('teammate', 'ping');
    await new Promise((resolve) => setImmediate(resolve));
    const dmRequest = JSON.parse(socket.sent.at(-1) ?? '{}') as Record<string, unknown>;
    assert.equal(typeof dmRequest.traceparent, 'string');
    assert.deepEqual(dmRequest, {
      type: 'messages_dm',
      requestId: dmRequest.requestId,
      agentOrUser: 'teammate',
      text: 'ping',
      traceparent: dmRequest.traceparent,
    });
    socket.receive({
      type: 'messages_result',
      requestId: dmRequest.requestId,
      id: 'msg-3',
    });
    assert.deepEqual(await dmPromise, { id: 'msg-3' });

    const inboxPromise = stream.registerInboxes(['#ops', '@self']);
    await new Promise((resolve) => setImmediate(resolve));
    const inboxRequest = JSON.parse(socket.sent.at(-1) ?? '{}') as Record<string, unknown>;
    assert.deepEqual(inboxRequest, {
      type: 'register',
      inbox: ['#ops', '@self'],
    });
    socket.receive({ type: 'registered', schedules: [], inbox: ['#ops', '@self'] });
    assert.deepEqual(await inboxPromise, {
      schedules: [],
      inbox: ['#ops', '@self'],
    });

    await stream.close();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test('publishLog forwards structured SDK log records over the gateway control channel', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    static readonly OPEN = 1;
  } as typeof globalThis.WebSocket;

  try {
    const socket = new TestWebSocket();
    const stream = events({
      workspace: 'support',
      agentId: 'support-agent',
      apiKey: 'relay_ws_test',
      webSocketFactory: () => socket as never,
      onEvent: async () => {},
    });

    stream.publishLog({
      ts: '2026-05-12T12:00:00.000Z',
      level: 'info',
      workspace: 'support',
      agentId: 'support-agent',
      eventId: 'evt-log-1',
      msg: 'before-ready',
      phase: 'bootstrap',
    });

    await new Promise((resolve) => setImmediate(resolve));
    socket.receive({ type: 'subscribed' });
    await stream.ready;
    await new Promise((resolve) => setImmediate(resolve));

    const logMessage = socket.sent
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .find((payload) => payload.type === 'log');
    assert.deepEqual(logMessage, {
      type: 'log',
      entry: {
        ts: '2026-05-12T12:00:00.000Z',
        level: 'info',
        workspace: 'support',
        agentId: 'support-agent',
        eventId: 'evt-log-1',
        msg: 'before-ready',
        phase: 'bootstrap',
      },
    });

    await stream.close();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test('approval waits use the gateway control channel', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    static readonly OPEN = 1;
  } as typeof globalThis.WebSocket;

  try {
    const socket = new TestWebSocket();
    const stream = events({
      workspace: 'support',
      apiKey: 'relay_ws_test',
      webSocketFactory: () => socket as never,
      onEvent: async () => {},
    });

    await new Promise((resolve) => setImmediate(resolve));
    socket.receive({ type: 'subscribed' });
    await stream.ready;

    const approvalPromise = stream.awaitApproval('approval-1');
    await new Promise((resolve) => setImmediate(resolve));
    const approvalRequest = JSON.parse(socket.sent.at(-1) ?? '{}') as Record<string, unknown>;
    assert.equal(typeof approvalRequest.traceparent, 'string');
    assert.deepEqual(approvalRequest, {
      type: 'approval_wait',
      requestId: approvalRequest.requestId,
      approvalId: 'approval-1',
      traceparent: approvalRequest.traceparent,
    });
    socket.receive({
      type: 'approval_result',
      requestId: approvalRequest.requestId,
      approval: {
        verdict: 'approved',
      },
    });
    assert.deepEqual(await approvalPromise, {
      verdict: 'approved',
    });

    await stream.close();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});
