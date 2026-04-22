import assert from 'node:assert/strict';
import { test } from 'vitest';

const piAdapterModulePath = '../../../communicate/adapters/pi.js';

async function loadPiAdapterModule(): Promise<any> {
  return import(piAdapterModulePath);
}

class FakeRelay {
  private callbacks: Array<(message: any) => void | Promise<void>> = [];

  async send(_to: string, _text: string): Promise<void> {}

  async post(_channel: string, _text: string): Promise<void> {}

  async inbox(): Promise<any[]> {
    return [];
  }

  async agents(): Promise<string[]> {
    return ['Lead', 'Impl-TS'];
  }

  onMessage(callback: (message: any) => void | Promise<void>): () => void {
    this.callbacks.push(callback);
    return () => {
      this.callbacks = this.callbacks.filter((entry) => entry !== callback);
    };
  }

  async emit(message: any): Promise<void> {
    for (const callback of [...this.callbacks]) {
      await callback(message);
    }
  }
}

function createSession(isStreaming: boolean) {
  return {
    isStreaming,
    steerCalls: [] as string[],
    followUpCalls: [] as string[],
    async steer(text: string) {
      this.steerCalls.push(text);
    },
    async followUp(text: string) {
      this.followUpCalls.push(text);
    },
  };
}

test('Pi onRelay appends relay tools to customTools', async () => {
  const { onRelay } = await loadPiAdapterModule();
  const relay = new FakeRelay();

  const config = onRelay(
    'PiTester',
    {
      customTools: [
        {
          name: 'existing-tool',
          label: 'Existing tool',
          description: 'Existing tool description',
        },
      ],
    },
    relay
  );

  const toolNames = (config.customTools ?? []).map((tool: any) => tool.name);

  assert.deepEqual(toolNames, ['existing-tool', 'relay_send', 'relay_inbox', 'relay_post', 'relay_agents']);

  for (const toolName of ['relay_send', 'relay_inbox', 'relay_post', 'relay_agents']) {
    const tool = config.customTools.find((entry: any) => entry.name === toolName);
    assert.ok(tool, `Expected ${toolName} to be registered`);
    assert.equal(typeof tool.execute, 'function');
    assert.ok(tool.parameters);
  }
});

test('Pi onSessionCreated captures the session and steers live messages while streaming', async () => {
  const { onRelay } = await loadPiAdapterModule();
  const relay = new FakeRelay();
  const existingHookCalls: any[] = [];

  const config = onRelay(
    'PiTester',
    {
      onSessionCreated(session: any) {
        existingHookCalls.push(session);
      },
    },
    relay
  );

  assert.equal(typeof config.onSessionCreated, 'function');

  const session = createSession(true);
  await config.onSessionCreated(session);
  await relay.emit({
    sender: 'Lead',
    text: 'Need status',
    messageId: 'message-1',
  });

  assert.deepEqual(existingHookCalls, [session]);
  assert.equal(session.steerCalls.length, 1);
  assert.equal(session.followUpCalls.length, 0);
  assert.match(session.steerCalls[0], /Lead/);
  assert.match(session.steerCalls[0], /Need status/);
});

test('Pi onSessionCreated routes live messages via followUp when the agent is idle', async () => {
  const { onRelay } = await loadPiAdapterModule();
  const relay = new FakeRelay();

  const config = onRelay('PiTester', {}, relay);
  assert.equal(typeof config.onSessionCreated, 'function');

  const session = createSession(false);
  await config.onSessionCreated(session);
  await relay.emit({
    sender: 'Review-Adapters',
    text: 'Waiting on Gate 2.3',
    messageId: 'message-2',
  });

  assert.equal(session.steerCalls.length, 0);
  assert.equal(session.followUpCalls.length, 1);
  assert.match(session.followUpCalls[0], /Review-Adapters/);
  assert.match(session.followUpCalls[0], /Waiting on Gate 2.3/);
});
