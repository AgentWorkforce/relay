import assert from 'node:assert/strict';
import { test } from 'vitest';

const adkAdapterModulePath = '../../../communicate/adapters/google-adk.js';

async function loadAdkAdapterModule(): Promise<any> {
  return import(adkAdapterModulePath);
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

function createMockAgent() {
  return {
    name: 'test-agent',
    tools: [] as any[],
  };
}

function createMockRunner() {
  const calls: Array<{ userId: string; sessionId: string; newMessage: any }> = [];
  return {
    calls,
    async *runAsync(params: { userId: string; sessionId: string; newMessage: any }) {
      calls.push(params);
      yield { type: 'done' };
    },
  };
}

test('Google ADK onRelay appends relay tools to agent.tools', async () => {
  const { onRelay } = await loadAdkAdapterModule();
  const relay = new FakeRelay();
  const agent = createMockAgent();

  // Add an existing tool
  agent.tools.push({ name: 'existing-tool', description: 'Existing tool' });

  const result = onRelay('AdkTester', { agent }, relay);

  const toolNames = result.agent.tools.map((tool: any) => tool.name);
  assert.deepEqual(toolNames, ['existing-tool', 'relay_send', 'relay_inbox', 'relay_post', 'relay_agents']);
});

test('Google ADK onRelay tools have correct structure', async () => {
  const { onRelay } = await loadAdkAdapterModule();
  const relay = new FakeRelay();
  const agent = createMockAgent();

  const result = onRelay('AdkTester', { agent }, relay);

  for (const toolName of ['relay_send', 'relay_inbox', 'relay_post', 'relay_agents']) {
    const tool = result.tools.find((entry: any) => entry.name === toolName);
    assert.ok(tool, `Expected ${toolName} to be registered`);
    assert.equal(typeof tool.execute, 'function');
    assert.ok(tool.parameters, `Expected ${toolName} to have parameters`);
    assert.ok(tool.description, `Expected ${toolName} to have a description`);
  }
});

test('Google ADK relay_send tool calls relay.send', async () => {
  const { onRelay } = await loadAdkAdapterModule();
  const relay = new FakeRelay();
  const sendCalls: Array<{ to: string; text: string }> = [];
  relay.send = async (to: string, text: string) => {
    sendCalls.push({ to, text });
  };
  const agent = createMockAgent();

  const result = onRelay('AdkTester', { agent }, relay);
  const sendTool = result.tools.find((t: any) => t.name === 'relay_send');

  const output = await sendTool.execute({ to: 'Lead', text: 'Hello' });
  assert.equal(sendCalls.length, 1);
  assert.deepEqual(sendCalls[0], { to: 'Lead', text: 'Hello' });
  assert.ok(output.result.includes('Lead'));
});

test('Google ADK relay_inbox tool returns formatted inbox', async () => {
  const { onRelay } = await loadAdkAdapterModule();
  const relay = new FakeRelay();
  const agent = createMockAgent();

  const result = onRelay('AdkTester', { agent }, relay);
  const inboxTool = result.tools.find((t: any) => t.name === 'relay_inbox');

  const output = await inboxTool.execute({});
  assert.equal(output.result, 'No new relay messages.');
});

test('Google ADK relay_agents tool returns agent list', async () => {
  const { onRelay } = await loadAdkAdapterModule();
  const relay = new FakeRelay();
  const agent = createMockAgent();

  const result = onRelay('AdkTester', { agent }, relay);
  const agentsTool = result.tools.find((t: any) => t.name === 'relay_agents');

  const output = await agentsTool.execute({});
  assert.equal(output.result, 'Lead\nImpl-TS');
});

test('Google ADK onRelay routes incoming messages to the runner', async () => {
  const { onRelay } = await loadAdkAdapterModule();
  const relay = new FakeRelay();
  const agent = createMockAgent();
  const runner = createMockRunner();

  onRelay('AdkTester', { agent, runner }, relay);

  await relay.emit({
    sender: 'Lead',
    text: 'Need status update',
    messageId: 'msg-1',
  });

  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].userId, 'relay');
  assert.equal(runner.calls[0].sessionId, 'relay-session');
  assert.ok(runner.calls[0].newMessage.parts[0].text.includes('Lead'));
  assert.ok(runner.calls[0].newMessage.parts[0].text.includes('Need status update'));
});

test('Google ADK onRelay uses custom userId and sessionId', async () => {
  const { onRelay } = await loadAdkAdapterModule();
  const relay = new FakeRelay();
  const agent = createMockAgent();
  const runner = createMockRunner();

  onRelay('AdkTester', { agent, runner, userId: 'custom-user', sessionId: 'custom-session' }, relay);

  await relay.emit({ sender: 'Peer', text: 'ping', messageId: 'msg-2' });

  assert.equal(runner.calls[0].userId, 'custom-user');
  assert.equal(runner.calls[0].sessionId, 'custom-session');
});

test('Google ADK onRelay unsubscribe stops message routing', async () => {
  const { onRelay } = await loadAdkAdapterModule();
  const relay = new FakeRelay();
  const agent = createMockAgent();
  const runner = createMockRunner();

  const result = onRelay('AdkTester', { agent, runner }, relay);

  // Unsubscribe from message routing
  result.unsubscribe();

  await relay.emit({ sender: 'Lead', text: 'Should not arrive', messageId: 'msg-3' });

  assert.equal(runner.calls.length, 0);
});

test('Google ADK onRelay without runner does not subscribe to messages', async () => {
  const { onRelay } = await loadAdkAdapterModule();
  const relay = new FakeRelay();
  const agent = createMockAgent();

  const result = onRelay('AdkTester', { agent }, relay);

  // unsubscribe should be a no-op
  assert.equal(typeof result.unsubscribe, 'function');
  result.unsubscribe(); // should not throw
});
