import assert from 'node:assert/strict';
import { test } from 'vitest';

const codexAdapterModulePath = '../../../communicate/adapters/codex.js';
const communicateModulePath = '../../../communicate/index.js';

async function loadCodexAdapterModule(): Promise<any> {
  return import(codexAdapterModulePath);
}

async function loadCommunicateModule(): Promise<any> {
  return import(communicateModulePath);
}

class FakeRelay {
  inboxCalls = 0;
  private queuedMessages: any[] = [];

  queue(...messages: any[]): void {
    this.queuedMessages.push(...messages);
  }

  async inbox(): Promise<any[]> {
    this.inboxCalls += 1;
    const drained = [...this.queuedMessages];
    this.queuedMessages = [];
    return drained;
  }
}

class FakeCodexClient {
  readonly requests: Array<{ method: string; params: any }> = [];
  readonly initializeCalls: any[] = [];
  private readonly listeners = new Set<(notification: any) => void | Promise<void>>();
  private readonly mcpServerNames = new Set<string>();
  private threadCounter = 1;
  private turnCounter = 1;

  closed = false;
  userAgent = 'codex-cli 0.124.0';

  constructor(mcpServerNames: string[] = []) {
    for (const name of mcpServerNames) {
      this.mcpServerNames.add(name);
    }
  }

  async initialize(options: any): Promise<any> {
    this.initializeCalls.push(options);
    return {
      userAgent: this.userAgent,
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'macos',
    };
  }

  async request<T = unknown>(method: string, params?: any): Promise<T> {
    this.requests.push({ method, params });

    if (method === 'mcpServerStatus/list') {
      return {
        data: [...this.mcpServerNames].map((name) => ({ name })),
        nextCursor: null,
      } as T;
    }

    if (method === 'config/value/write') {
      this.mcpServerNames.add('relaycast');
      return {} as T;
    }

    if (method === 'config/mcpServer/reload') {
      return {} as T;
    }

    if (method === 'thread/start') {
      return {
        thread: {
          id: `thread-${this.threadCounter++}`,
        },
      } as T;
    }

    if (method === 'thread/resume') {
      return {
        thread: {
          id: params.threadId || 'thread-resumed',
        },
      } as T;
    }

    if (method === 'thread/fork') {
      return {
        thread: {
          id: `thread-fork-${this.threadCounter++}`,
        },
      } as T;
    }

    if (method === 'turn/start') {
      return {
        turn: {
          id: `turn-${this.turnCounter++}`,
        },
      } as T;
    }

    if (method === 'turn/steer' || method === 'turn/interrupt' || method === 'thread/unsubscribe') {
      return {} as T;
    }

    throw new Error(`Unexpected request: ${method}`);
  }

  onNotification(listener: (notification: any) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async emit(notification: any): Promise<void> {
    for (const listener of [...this.listeners]) {
      await listener(notification);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function requestsFor(client: FakeCodexClient, method: string): Array<{ method: string; params: any }> {
  return client.requests.filter((request) => request.method === method);
}

function lastRequest(client: FakeCodexClient, method: string): { method: string; params: any } {
  const requests = requestsFor(client, method);
  assert.ok(requests.length > 0, `Expected request ${method}`);
  return requests[requests.length - 1];
}

test('Codex onRelay initializes app-server, installs relaycast MCP, and starts a thread', async () => {
  const { onRelay } = await loadCodexAdapterModule();
  const client = new FakeCodexClient();
  const relay = new FakeRelay();

  const handle = onRelay(
    'CodexTester',
    {
      framework: 'codex',
      cwd: '/repo',
      model: 'gpt-5.2',
      clientFactory: () => client,
    },
    relay
  );

  await handle.ready;

  assert.equal(handle.threadId, 'thread-1');
  assert.equal(client.initializeCalls.length, 1);
  assert.deepEqual(client.initializeCalls[0].capabilities, {
    experimentalApi: false,
    optOutNotificationMethods: null,
  });

  assert.deepEqual(
    client.requests.map((request) => request.method),
    ['mcpServerStatus/list', 'config/value/write', 'config/mcpServer/reload', 'thread/start']
  );
  assert.deepEqual(lastRequest(client, 'config/value/write').params, {
    keyPath: 'mcp_servers.relaycast',
    value: {
      command: 'agent-relay',
      args: ['mcp'],
    },
    mergeStrategy: 'upsert',
  });
  assert.equal(lastRequest(client, 'thread/start').params.cwd, '/repo');
  assert.equal(lastRequest(client, 'thread/start').params.model, 'gpt-5.2');
});

test('Codex onRelay does not rewrite config when relaycast MCP is already registered', async () => {
  const { onRelay } = await loadCodexAdapterModule();
  const client = new FakeCodexClient(['relaycast']);

  const handle = onRelay('CodexTester', { framework: 'codex', clientFactory: () => client }, new FakeRelay());
  await handle.ready;

  assert.equal(requestsFor(client, 'config/value/write').length, 0);
  assert.equal(requestsFor(client, 'config/mcpServer/reload').length, 0);
  assert.equal(requestsFor(client, 'thread/start').length, 1);
});

test('Codex onRelay fails fast when the app-server version is too old', async () => {
  const { onRelay } = await loadCodexAdapterModule();
  const client = new FakeCodexClient(['relaycast']);
  client.userAgent = 'codex-cli 0.123.0';

  const handle = onRelay(
    'CodexTester',
    {
      framework: 'codex',
      clientFactory: () => client,
    },
    new FakeRelay()
  );

  await assert.rejects(handle.ready, /older than the supported minimum 0\.124\.0/);
  assert.equal(requestsFor(client, 'thread/start').length, 0);
});

test('Codex item/completed drains relay inbox and steers the active turn', async () => {
  const { onRelay } = await loadCodexAdapterModule();
  const client = new FakeCodexClient(['relaycast']);
  const relay = new FakeRelay();
  const handle = onRelay('CodexTester', { framework: 'codex', clientFactory: () => client }, relay);
  await handle.ready;

  await client.emit({
    method: 'turn/started',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-live',
      },
    },
  });
  relay.queue({
    sender: 'Lead',
    text: 'Need the status now.',
    messageId: 'message-1',
  });

  await client.emit({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-live',
      item: {},
    },
  });

  const steer = lastRequest(client, 'turn/steer');
  assert.equal(steer.params.threadId, 'thread-1');
  assert.equal(steer.params.expectedTurnId, 'turn-live');
  assert.match(steer.params.input[0].text, /New messages from other agents:/);
  assert.match(steer.params.input[0].text, /Relay message from Lead: Need the status now\./);
});

test('Codex turn/completed queues relay inbox for the next turn/start input', async () => {
  const { onRelay } = await loadCodexAdapterModule();
  const client = new FakeCodexClient(['relaycast']);
  const relay = new FakeRelay();
  const handle = onRelay('CodexTester', { framework: 'codex', clientFactory: () => client }, relay);
  await handle.ready;

  relay.queue({
    sender: 'Reviewer',
    text: 'Please include tests.',
    messageId: 'message-2',
  });
  await client.emit({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-finished',
      },
    },
  });

  await handle.send('Continue implementation.');

  const turnStart = lastRequest(client, 'turn/start');
  assert.equal(turnStart.params.threadId, 'thread-1');
  assert.match(turnStart.params.input[0].text, /Relay message from Reviewer: Please include tests\./);
  assert.match(turnStart.params.input[0].text, /Continue implementation\./);
});

test('Codex fork creates an ephemeral fork handle on the same app-server client', async () => {
  const { onRelay } = await loadCodexAdapterModule();
  const client = new FakeCodexClient(['relaycast']);
  const handle = onRelay('CodexTester', { framework: 'codex', clientFactory: () => client }, new FakeRelay());
  await handle.ready;

  const fork = await handle.fork({
    name: 'CodexFork',
    relay: new FakeRelay(),
  });
  await fork.send('Work from the fork.');

  const forkRequest = lastRequest(client, 'thread/fork');
  assert.equal(forkRequest.params.threadId, 'thread-1');
  assert.equal(forkRequest.params.ephemeral, true);
  assert.equal(fork.threadId, 'thread-fork-2');
  assert.equal(lastRequest(client, 'turn/start').params.threadId, 'thread-fork-2');
});

test('communicate onRelay routes framework codex targets to the Codex adapter', async () => {
  const { onRelay } = await loadCommunicateModule();
  const client = new FakeCodexClient(['relaycast']);
  const handle = onRelay(
    'CodexTopLevel',
    {
      framework: 'codex',
      clientFactory: () => client,
    },
    new FakeRelay()
  );

  await handle.ready;

  assert.equal(handle.threadId, 'thread-1');
  assert.equal(requestsFor(client, 'thread/start').length, 1);
});
