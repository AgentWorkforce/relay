import assert from 'node:assert/strict';
import test from 'node:test';

const adapterModulePath = '../../../communicate/adapters/ai-sdk.js';

async function loadModule(): Promise<any> {
  return import(adapterModulePath);
}

class FakeRelay {
  private callbacks: Array<(message: any) => void | Promise<void>> = [];

  sent: Array<{ to: string; text: string }> = [];
  posted: Array<{ channel: string; text: string }> = [];
  inboxMessages: any[] = [];

  async send(to: string, text: string): Promise<void> {
    this.sent.push({ to, text });
  }

  async post(channel: string, text: string): Promise<void> {
    this.posted.push({ channel, text });
  }

  async inbox(): Promise<any[]> {
    const messages = [...this.inboxMessages];
    this.inboxMessages = [];
    return messages;
  }

  async agents(): Promise<string[]> {
    return ['Lead', 'Researcher'];
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

test('AI SDK onRelay returns relay tool definitions', async () => {
  const { onRelay } = await loadModule();
  const relay = new FakeRelay();

  const session = onRelay({ name: 'AiSdkTester' }, relay);
  const toolNames = Object.keys(session.tools);

  assert.deepEqual(toolNames, ['relay_send', 'relay_inbox', 'relay_post', 'relay_agents']);
  assert.equal(typeof session.middleware.transformParams, 'function');
  assert.equal(typeof session.cleanup, 'function');
});

test('AI SDK relay tools execute against the relay client', async () => {
  const { onRelay } = await loadModule();
  const relay = new FakeRelay();
  relay.inboxMessages = [{ sender: 'Lead', text: 'Check status', messageId: 'msg-1' }];

  const session = onRelay({ name: 'AiSdkTester' }, relay);

  await session.tools.relay_send.execute?.({ to: 'Lead', text: 'Working on it' });
  await session.tools.relay_post.execute?.({ channel: 'ops', text: 'status update' });
  const inboxResult = await session.tools.relay_inbox.execute?.({});
  const agentsResult = await session.tools.relay_agents.execute?.({});

  assert.deepEqual(relay.sent, [{ to: 'Lead', text: 'Working on it' }]);
  assert.deepEqual(relay.posted, [{ channel: 'ops', text: 'status update' }]);
  assert.match(String((inboxResult as any).text), /Check status/);
  assert.deepEqual((agentsResult as any).agents, ['Lead', 'Researcher']);
});

test('AI SDK middleware appends relay instructions and pending messages to system', async () => {
  const { onRelay } = await loadModule();
  const relay = new FakeRelay();
  const session = onRelay({ name: 'AiSdkTester', instructions: 'Escalate blockers quickly.' }, relay);

  await relay.emit({ sender: 'Lead', text: 'Need an update', messageId: 'msg-2' });

  const first = await session.middleware.transformParams?.({ params: { system: 'Base system.' } });
  const second = await session.middleware.transformParams?.({ params: { system: 'Base system.' } });

  assert.match(String(first?.system), /Base system\./);
  assert.match(String(first?.system), /Use relay_send/);
  assert.match(String(first?.system), /Escalate blockers quickly\./);
  assert.match(String(first?.system), /Need an update/);
  assert.equal(second?.system?.includes('Need an update'), false);
});

test('AI SDK middleware prepends a synthetic system message for message-array calls', async () => {
  const { onRelay } = await loadModule();
  const relay = new FakeRelay();
  const session = onRelay({ name: 'AiSdkTester', instructions: 'Escalate blockers quickly.' }, relay);

  await relay.emit({ sender: 'Reviewer', text: 'Need approval on the fix', messageId: 'msg-4' });

  const result = await session.middleware.transformParams?.({
    params: {
      messages: [{ role: 'user', content: 'Can you ship this?' }],
    },
  });

  assert.equal(Array.isArray(result?.messages), true);
  assert.equal(result?.messages?.[0]?.role, 'system');
  assert.match(String(result?.messages?.[0]?.content), /Use relay_send/);
  assert.match(String(result?.messages?.[0]?.content), /Escalate blockers quickly\./);
  assert.match(String(result?.messages?.[0]?.content), /Need approval on the fix/);
  assert.equal(result?.messages?.[1]?.role, 'user');
});

test('AI SDK cleanup unsubscribes from live relay messages', async () => {
  const { onRelay } = await loadModule();
  const relay = new FakeRelay();
  const session = onRelay({ name: 'AiSdkTester' }, relay);

  session.cleanup();
  await relay.emit({ sender: 'Lead', text: 'Late ping', messageId: 'msg-3' });
  const result = await session.middleware.transformParams?.({ params: {} });

  assert.equal(String(result?.system).includes('Late ping'), false);
});
