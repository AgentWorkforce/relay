import assert from 'node:assert/strict';
import test from 'node:test';

import { agent, deployAgent, NoRetry } from '../src/index.js';

class TestWebSocket {
  static readonly OPEN = 1;

  readyState = TestWebSocket.OPEN;
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

test('agent emits startup after onStart and runs onStop during shutdown', async () => {
  const lifecycle: string[] = [];
  const seenEvents: string[] = [];

  const handle = agent({
    workspace: 'support',
    name: 'support-agent',
    options: {
      apiKey: 'relay_ws_test',
      gatewayUrl: '',
      handleSignals: false,
    },
    onStart(ctx) {
      lifecycle.push(`start:${ctx.workspace}:${ctx.agentId}`);
    },
    onStop(ctx) {
      lifecycle.push(`stop:${ctx.workspace}:${ctx.agentId}`);
    },
    onEvent(_ctx, event) {
      seenEvents.push(event.type);
    },
  });

  await handle.ready;
  await new Promise((resolve) => setImmediate(resolve));
  await handle.stop();

  assert.deepEqual(lifecycle, ['start:support:support-agent', 'stop:support:support-agent']);
  assert.deepEqual(seenEvents, ['startup']);
});

test('agent forwards terminal delivery failures to onError and preserves the event context', async () => {
  const failures: Array<{ message: string; eventType: string }> = [];

  const handle = agent({
    workspace: 'support',
    name: 'support-errors',
    options: {
      apiKey: 'relay_ws_test',
      gatewayUrl: '',
      handleSignals: false,
    },
    async onEvent(ctx, event) {
      if (event.type === 'startup') {
        throw new NoRetry('startup failed');
      }
      ctx.logger.info('handled', { eventType: event.type });
    },
    onError(_ctx, error, event) {
      failures.push({ message: error.message, eventType: event.type });
    },
  });

  await handle.ready;
  await new Promise((resolve) => setTimeout(resolve, 25));
  await handle.stop();

  const startupFailure = failures.find((failure) => failure.eventType === 'startup');
  assert.ok(startupFailure);
  assert.match(startupFailure.message, /startup failed/i);
});

test('agent handle.trigger dispatches synthetic events and SIGTERM stops the handle', async () => {
  const seen: string[] = [];
  let stopped = false;

  const handle = agent({
    workspace: 'support',
    name: 'support-signals',
    options: {
      apiKey: 'relay_ws_test',
      gatewayUrl: '',
    },
    async onEvent(_ctx, event) {
      seen.push(event.type);
    },
    async onStop() {
      stopped = true;
    },
  });

  await handle.ready;
  await handle.trigger({
    type: 'cron.tick',
    id: 'manual-trigger',
    schedule: 'manual',
    scheduledFor: '2026-05-11T12:00:00.000Z',
  });
  await handle.trigger({
    type: 'relaycast.message',
    id: 'manual-relaycast-trigger',
    channel: 'support-agents',
    messageId: 'msg-manual-1',
    threadId: 'thread-manual-1',
  });
  process.emit('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.ok(seen.includes('cron.tick'));
  assert.ok(seen.includes('relaycast.message'));
  assert.equal(stopped, true);
});

test('agent uses direct relaycast helpers when the gateway transport is disabled', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    calls.push({
      url: request.url,
      body: JSON.parse(await request.text()) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ id: 'msg-local-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  try {
    const handle = agent({
      workspace: 'support',
      options: {
        apiKey: 'relay_ws_test',
        gatewayUrl: '',
        handleSignals: false,
      },
      async onEvent() {},
    });

    await handle.ready;
    assert.equal(handle.ctx.raw.relayfile.available, true);
    assert.equal(handle.ctx.raw.relaycast.available, true);
    assert.deepEqual(await handle.ctx.messages.post('ops', 'hello'), { id: 'msg-local-1' });
    assert.deepEqual(calls, [
      {
        url: 'https://api.relaycast.dev/v1/message',
        body: {
          channel: 'ops',
          text: 'hello',
          mode: 'wait',
        },
      },
    ]);
    await handle.stop();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent tags likely OpenAI requests during onEvent and supports ctx.tagged client fallbacks', async () => {
  const originalFetch = globalThis.fetch;
  const seen: Array<{ url: string; headers: Headers }> = [];
  let externalClientHeaders: Headers | null = null;

  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, headers: request.headers });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  const externalClient = {
    _options: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        externalClientHeaders = request.headers;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
    async request(url: string, init?: RequestInit) {
      return await this._options.fetch(url, init);
    },
  };

  try {
    const handle = agent({
      workspace: 'support',
      options: {
        apiKey: 'relay_ws_test',
        gatewayUrl: '',
        handleSignals: false,
      },
      async onEvent(ctx, event) {
        if (event.type !== 'startup') {
          return;
        }

        await globalThis.fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5' }),
        });

        const taggedClient = ctx.tagged(externalClient);
        await taggedClient.request('https://proxy.example.test/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({ model: 'claude-sonnet-4-5' }),
        });
      },
    });

    await handle.ready;
    await new Promise((resolve) => setImmediate(resolve));
    await handle.stop();

    const openAiRequest = seen.find((entry) => entry.url === 'https://api.openai.com/v1/responses');
    assert.equal(openAiRequest?.headers.get('x-relayburn-source'), 'agent-relay');
    assert.equal(openAiRequest?.headers.get('x-relayburn-tag-workspace'), 'support');
    assert.equal(openAiRequest?.headers.get('x-relayburn-tag-agent-id'), 'support');
    assert.equal(openAiRequest?.headers.get('x-relayburn-tag-event-type'), 'startup');
    assert.equal(typeof openAiRequest?.headers.get('x-relayburn-tag-event-id'), 'string');

    assert.equal(externalClientHeaders?.get('x-relayburn-tag-workspace'), 'support');
    assert.equal(externalClientHeaders?.get('x-relayburn-tag-event-type'), 'startup');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent accepts future watch and inbox declarations without failing startup', async () => {
  const handle = agent({
    workspace: 'support',
    watch: ['/linear/issues/**'],
    inbox: ['ops'],
    options: {
      apiKey: 'relay_ws_test',
      gatewayUrl: '',
      handleSignals: false,
    },
    async onEvent() {},
  });

  await handle.ready;
  await handle.stop();
});

test('agent normalizes inbox declarations into gateway registrations', async () => {
  const originalWebSocket = globalThis.WebSocket;

  try {
    const socket = new TestWebSocket();
    globalThis.WebSocket = class {
      static readonly OPEN = 1;

      constructor() {
        return socket as unknown as WebSocket;
      }
    } as typeof globalThis.WebSocket;

    const handle = agent({
      workspace: 'support',
      inbox: ['ops', '@self'],
      options: {
        apiKey: 'relay_ws_test',
        gatewayUrl: 'ws://127.0.0.1:8787/v1/agent-events',
        handleSignals: false,
      },
      async onEvent() {},
    });

    await new Promise((resolve) => setImmediate(resolve));
    socket.receive({ type: 'subscribed' });
    await new Promise((resolve) => setImmediate(resolve));

    const registerRequest = JSON.parse(socket.sent.at(-1) ?? '{}') as Record<string, unknown>;
    assert.deepEqual(registerRequest, {
      type: 'register',
      inbox: ['#ops', '@self'],
    });

    socket.receive({ type: 'registered', schedules: [], inbox: [] });
    await handle.ready;
    await handle.stop();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test('agent normalizes string watch declarations into gateway registrations', async () => {
  const originalWebSocket = globalThis.WebSocket;

  try {
    const socket = new TestWebSocket();
    globalThis.WebSocket = class {
      static readonly OPEN = 1;

      constructor() {
        return socket as unknown as WebSocket;
      }
    } as typeof globalThis.WebSocket;
    const handle = agent({
      workspace: 'support',
      watch: ['/linear/issues/**', '/github/prs/**'],
      options: {
        apiKey: 'relay_ws_test',
        gatewayUrl: 'ws://127.0.0.1:8787/v1/agent-events',
        handleSignals: false,
        replayOnStart: 'last:5',
        coalesceMs: 25,
        maxBacklog: 10,
      },
      async onEvent() {},
    });

    await new Promise((resolve) => setImmediate(resolve));
    socket.receive({ type: 'subscribed' });
    await new Promise((resolve) => setImmediate(resolve));

    const registerRequest = JSON.parse(socket.sent.at(-1) ?? '{}') as Record<string, unknown>;
    assert.deepEqual(registerRequest, {
      type: 'register',
      watch: [
        {
          glob: '/linear/issues/**',
          replayOnStart: 'last:5',
          coalesceMs: 25,
          maxBacklog: 10,
        },
        {
          glob: '/github/prs/**',
          replayOnStart: 'last:5',
          coalesceMs: 25,
          maxBacklog: 10,
        },
      ],
    });

    socket.receive({ type: 'registered', schedules: [] });
    await handle.ready;
    await handle.stop();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test('ctx.logger forwards structured event-scoped records over the gateway websocket', async () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalInfo = console.info;
  const consoleLines: string[] = [];
  console.info = ((message?: unknown) => {
    consoleLines.push(String(message ?? ''));
  }) as typeof console.info;

  try {
    const socket = new TestWebSocket();
    globalThis.WebSocket = class {
      static readonly OPEN = 1;

      constructor() {
        return socket as unknown as WebSocket;
      }
    } as typeof globalThis.WebSocket;

    const handle = agent({
      workspace: 'support',
      name: 'support-logger',
      options: {
        apiKey: 'relay_ws_test',
        gatewayUrl: 'ws://127.0.0.1:8787/v1/agent-events',
        handleSignals: false,
      },
      async onEvent(ctx, event) {
        ctx.logger.info('handled event', {
          path: event.path,
        });
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    socket.receive({ type: 'subscribed' });
    await handle.ready;

    socket.receive({
      type: 'event',
      event: {
        id: 'evt-log-ctx',
        workspace: 'support',
        type: 'relayfile.changed',
        occurredAt: '2026-05-12T12:00:00.000Z',
        attempt: 1,
        resource: {
          path: '/linear/issues/ENG-1.json',
          kind: 'linear.issue',
          id: 'ENG-1',
          provider: 'linear',
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    const logMessage = socket.sent
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .find((payload) => payload.type === 'log');
    assert.deepEqual(logMessage, {
      type: 'log',
      entry: {
        ts:
          logMessage?.entry && typeof logMessage.entry === 'object'
            ? (logMessage.entry as Record<string, unknown>).ts
            : undefined,
        level: 'info',
        workspace: 'support',
        agentId: 'support-logger',
        eventId: 'evt-log-ctx',
        msg: 'handled event',
        eventType: 'relayfile.changed',
        path: '/linear/issues/ENG-1.json',
      },
    });
    assert.equal(consoleLines.length > 0, true);

    await handle.stop();
  } finally {
    globalThis.WebSocket = originalWebSocket;
    console.info = originalInfo;
  }
});

test('agent proxies relaycast message RPCs over the gateway control plane', async () => {
  const originalWebSocket = globalThis.WebSocket;

  try {
    const socket = new TestWebSocket();
    globalThis.WebSocket = class {
      static readonly OPEN = 1;

      constructor() {
        return socket as unknown as WebSocket;
      }
    } as typeof globalThis.WebSocket;
    const handle = agent({
      workspace: 'support',
      options: {
        apiKey: 'relay_ws_test',
        gatewayUrl: 'ws://127.0.0.1:8787/v1/agent-events',
        handleSignals: false,
      },
      async onEvent() {},
    });

    await new Promise((resolve) => setImmediate(resolve));
    socket.receive({ type: 'subscribed' });
    await handle.ready;

    assert.equal(handle.ctx.raw.relaycast.available, true);

    const postPromise = handle.ctx.messages.post('ops', 'hello');
    await new Promise((resolve) => setImmediate(resolve));
    const postRequest = JSON.parse(socket.sent.at(-1) ?? '{}') as Record<string, unknown>;
    assert.deepEqual(postRequest, {
      type: 'messages_post',
      requestId: postRequest.requestId,
      channel: 'ops',
      text: 'hello',
    });
    socket.receive({
      type: 'messages_result',
      requestId: postRequest.requestId,
      id: 'msg-1',
    });
    assert.deepEqual(await postPromise, { id: 'msg-1' });

    const replyPromise = handle.ctx.messages.reply('thread-1', 'ack', {
      idempotencyKey: 'reply-1',
    });
    await new Promise((resolve) => setImmediate(resolve));
    const replyRequest = JSON.parse(socket.sent.at(-1) ?? '{}') as Record<string, unknown>;
    assert.deepEqual(replyRequest, {
      type: 'messages_reply',
      requestId: replyRequest.requestId,
      threadId: 'thread-1',
      text: 'ack',
      opts: {
        idempotencyKey: 'reply-1',
      },
    });
    socket.receive({
      type: 'messages_result',
      requestId: replyRequest.requestId,
      id: 'msg-reply-1',
    });
    assert.deepEqual(await replyPromise, { id: 'msg-reply-1' });

    const dmPromise = handle.ctx.messages.dm('@teammate', 'ping');
    await new Promise((resolve) => setImmediate(resolve));
    const dmRequest = JSON.parse(socket.sent.at(-1) ?? '{}') as Record<string, unknown>;
    assert.deepEqual(dmRequest, {
      type: 'messages_dm',
      requestId: dmRequest.requestId,
      agentOrUser: '@teammate',
      text: 'ping',
    });
    socket.receive({
      type: 'messages_result',
      requestId: dmRequest.requestId,
      id: 'msg-2',
    });
    assert.deepEqual(await dmPromise, { id: 'msg-2' });

    await handle.stop();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test('agent applies the default 200ms watch coalesce window and validates replayOnStart', async () => {
  const originalWebSocket = globalThis.WebSocket;

  try {
    const socket = new TestWebSocket();
    globalThis.WebSocket = class {
      static readonly OPEN = 1;

      constructor() {
        return socket as unknown as WebSocket;
      }
    } as typeof globalThis.WebSocket;

    const handle = agent({
      workspace: 'support',
      watch: ['/linear/issues/**'],
      options: {
        apiKey: 'relay_ws_test',
        gatewayUrl: 'ws://127.0.0.1:8787/v1/agent-events',
        handleSignals: false,
        replayOnStart: 'since:2026-05-12T00:00:00.000Z',
      },
      async onEvent() {},
    });

    await new Promise((resolve) => setImmediate(resolve));
    socket.receive({ type: 'subscribed' });
    await new Promise((resolve) => setImmediate(resolve));

    const registerRequest = JSON.parse(socket.sent.at(-1) ?? '{}') as Record<string, unknown>;
    assert.deepEqual(registerRequest, {
      type: 'register',
      watch: [
        {
          glob: '/linear/issues/**',
          replayOnStart: 'since:2026-05-12T00:00:00.000Z',
          coalesceMs: 200,
        },
      ],
    });

    socket.receive({ type: 'registered', schedules: [] });
    await handle.ready;
    await handle.stop();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }

  assert.throws(
    () =>
      agent({
        workspace: 'support',
        watch: ['/linear/issues/**'],
        options: {
          apiKey: 'relay_ws_test',
          gatewayUrl: '',
          handleSignals: false,
          replayOnStart: 'since:not-a-date',
        },
        async onEvent() {},
      }),
    /since:<iso-timestamp>/
  );
});

test('agent delivers relayfile watch events with path and current convenience fields', async () => {
  const originalWebSocket = globalThis.WebSocket;

  try {
    const socket = new TestWebSocket();
    globalThis.WebSocket = class {
      static readonly OPEN = 1;

      constructor() {
        return socket as unknown as WebSocket;
      }
    } as typeof globalThis.WebSocket;

    const seen: Array<{ path: string; status?: string }> = [];
    const handle = agent({
      workspace: 'support',
      watch: ['/linear/issues/**'],
      options: {
        apiKey: 'relay_ws_test',
        gatewayUrl: 'ws://127.0.0.1:8787/v1/agent-events',
        handleSignals: false,
      },
      async onEvent(_ctx, event) {
        if (event.type !== 'relayfile.changed') {
          return;
        }
        seen.push({
          path: event.path,
          status: typeof event.current?.status === 'string' ? event.current.status : undefined,
        });
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    socket.receive({ type: 'subscribed' });
    await new Promise((resolve) => setImmediate(resolve));
    socket.receive({ type: 'registered', schedules: [] });
    await handle.ready;

    socket.receive({
      type: 'event',
      event: {
        id: 'evt_linear_watch_1',
        workspace: 'support',
        type: 'relayfile.changed',
        occurredAt: '2026-05-12T00:00:00.000Z',
        attempt: 1,
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
        watch: '/linear/issues/**',
        action: 'updated',
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(seen, [{ path: '/linear/issues/ENG-412.json', status: 'In Progress' }]);

    await handle.stop();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test('agent proxies relayfile file RPCs over the gateway control plane', async () => {
  const originalWebSocket = globalThis.WebSocket;

  try {
    const socket = new TestWebSocket();
    globalThis.WebSocket = class {
      static readonly OPEN = 1;

      constructor() {
        return socket as unknown as WebSocket;
      }
    } as typeof globalThis.WebSocket;
    const handle = agent({
      workspace: 'support',
      options: {
        apiKey: 'relay_ws_test',
        gatewayUrl: 'ws://127.0.0.1:8787/v1/agent-events',
        handleSignals: false,
      },
      async onEvent() {},
    });

    await new Promise((resolve) => setImmediate(resolve));
    socket.receive({ type: 'subscribed' });
    await handle.ready;

    const readPromise = handle.ctx.files.read('/docs/readme.md');
    await new Promise((resolve) => setImmediate(resolve));
    const readRequest = JSON.parse(socket.sent.at(-1) ?? '{}') as Record<string, unknown>;
    assert.deepEqual(readRequest, {
      type: 'files_read',
      requestId: readRequest.requestId,
      path: '/docs/readme.md',
    });
    socket.receive({
      type: 'files_read_result',
      requestId: readRequest.requestId,
      file: {
        path: '/docs/readme.md',
        content: '# Readme',
        revision: 'rev-1',
        contentType: 'text/markdown',
        encoding: 'utf-8',
      },
    });
    assert.deepEqual(await readPromise, {
      path: '/docs/readme.md',
      body: '# Readme',
      revision: 'rev-1',
      contentType: 'text/markdown',
      encoding: 'utf-8',
    });

    const listPromise = handle.ctx.files.list('/docs/*.md');
    await new Promise((resolve) => setImmediate(resolve));
    const listRequest = JSON.parse(socket.sent.at(-1) ?? '{}') as Record<string, unknown>;
    assert.deepEqual(listRequest, {
      type: 'files_list',
      requestId: listRequest.requestId,
      glob: '/docs/*.md',
    });
    socket.receive({
      type: 'files_list_result',
      requestId: listRequest.requestId,
      entries: [
        {
          path: '/docs/readme.md',
          revision: 'rev-1',
          provider: 'relayfile',
          size: 42,
        },
      ],
    });
    assert.deepEqual(await listPromise, [
      {
        path: '/docs/readme.md',
        revision: 'rev-1',
        provider: 'relayfile',
        size: 42,
      },
    ]);

    const writePromise = handle.ctx.files.write('/docs/readme.md', 'updated');
    await new Promise((resolve) => setImmediate(resolve));
    const writeRequest = JSON.parse(socket.sent.at(-1) ?? '{}') as Record<string, unknown>;
    assert.deepEqual(writeRequest, {
      type: 'files_write',
      requestId: writeRequest.requestId,
      path: '/docs/readme.md',
      body: 'updated',
    });
    socket.receive({
      type: 'files_write_result',
      requestId: writeRequest.requestId,
    });
    await writePromise;

    const objectWritePromise = handle.ctx.files.write('/docs/state.json', {
      ok: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const objectWriteRequest = JSON.parse(socket.sent.at(-1) ?? '{}') as Record<string, unknown>;
    assert.deepEqual(objectWriteRequest, {
      type: 'files_write',
      requestId: objectWriteRequest.requestId,
      path: '/docs/state.json',
      body: '{"ok":true}',
      meta: {
        contentType: 'application/json',
        encoding: 'utf-8',
      },
    });
    socket.receive({
      type: 'files_write_result',
      requestId: objectWriteRequest.requestId,
    });
    await objectWritePromise;

    await handle.stop();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test('agent rejects empty watch declarations at definition time', () => {
  assert.throws(
    () =>
      agent({
        workspace: 'support',
        watch: ['   '],
        options: {
          apiKey: 'relay_ws_test',
          gatewayUrl: '',
          handleSignals: false,
        },
        async onEvent() {},
      }),
    /agent\.watch must include at least one non-empty glob/
  );
});

test('agent rejects non-string watch declarations at definition time', () => {
  assert.throws(
    () =>
      agent({
        workspace: 'support',
        watch: ['/linear/issues/**', 42 as unknown as string],
        options: {
          apiKey: 'relay_ws_test',
          gatewayUrl: '',
          handleSignals: false,
        },
        async onEvent() {},
      }),
    /agent\.watch must be a string or string\[\] of globs/
  );
});

test('deployAgent posts the hosted deployment definition and returns a working handle', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  process.env.RELAY_API_KEY = 'relay_ws_test';
  process.env.RELAY_HOSTED_AGENTS_URL = 'https://cloud.test';

  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const bodyText = init?.body ? String(init.body) : await request.text();
    calls.push({
      url: request.url,
      method: request.method,
      body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null,
    });

    if (request.method === 'POST') {
      return new Response(
        JSON.stringify({
          deployId: 'dep_support',
          agentId: 'support-agent',
        }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }
      );
    }

    if (request.method === 'GET') {
      return new Response(
        JSON.stringify({
          deployId: 'dep_support',
          agentId: 'support-agent',
          state: 'running',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    }

    return new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;

  try {
    const handle = await deployAgent({
      workspace: 'support',
      name: 'support-agent',
      model: 'gpt-5',
      instructions: 'Be concise.',
      schedule: '*/5 * * * *',
      provider: {
        mode: 'managed',
      },
    });

    assert.equal(handle.agentId, 'support-agent');
    assert.equal(handle.deployId, 'dep_support');
    assert.deepEqual(calls[0], {
      url: 'https://cloud.test/v1/hosted-agents/deployments',
      method: 'POST',
      body: {
        workspace: 'support',
        name: 'support-agent',
        model: 'gpt-5',
        instructions: 'Be concise.',
        schedule: ['*/5 * * * *'],
        provider: {
          mode: 'managed',
        },
        runtime: {
          mode: 'default',
        },
      },
    });

    const status = await handle.status();
    assert.equal(status.state, 'running');

    await handle.undeploy();

    assert.equal(calls[1]?.method, 'GET');
    assert.equal(calls[2]?.method, 'DELETE');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.RELAY_API_KEY;
    delete process.env.RELAY_HOSTED_AGENTS_URL;
  }
});

test('deployAgent serializes a custom hosted onEvent handler when provided', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown> | null> = [];
  process.env.RELAY_API_KEY = 'relay_ws_test';
  process.env.RELAY_HOSTED_AGENTS_URL = 'https://cloud.test';

  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const bodyText = init?.body ? String(init.body) : await request.text();
    calls.push(bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null);
    return new Response(
      JSON.stringify({
        deployId: 'dep_custom',
        agentId: 'custom-agent',
      }),
      {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }
    );
  }) as typeof globalThis.fetch;

  try {
    await deployAgent({
      workspace: 'support',
      name: 'custom-agent',
      model: 'claude-sonnet-4-5',
      instructions: 'Handle inbox events carefully.',
      provider: {
        mode: 'byok',
        secretRef: 'anthropic-api-key',
      },
      async onEvent(_ctx, event) {
        if (event.type === 'startup') {
          return;
        }
      },
    });

    assert.equal(calls.length, 1);
    assert.equal((calls[0]?.runtime as { mode?: string } | undefined)?.mode, 'custom');
    assert.match(
      String((calls[0]?.runtime as { onEventSource?: unknown } | undefined)?.onEventSource),
      /event\.type.*"startup"/
    );
    assert.deepEqual(calls[0]?.provider, {
      mode: 'byok',
      secretRef: 'anthropic-api-key',
    });
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.RELAY_API_KEY;
    delete process.env.RELAY_HOSTED_AGENTS_URL;
  }
});
