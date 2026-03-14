import assert from 'node:assert/strict';
import test from 'node:test';

const adapterModulePath = '../../../communicate/adapters/openai-agents.js';

async function loadModule(): Promise<any> {
  return import(adapterModulePath);
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

function createAgent(instructions = 'You are a helpful agent.') {
  return {
    name: 'TestAgent',
    instructions,
    tools: [] as any[],
  };
}

test('onRelay appends relay tools to agent.tools', async () => {
  const { onRelay } = await loadModule();
  const relay = new FakeRelay();
  const agent = createAgent();
  agent.tools.push({ type: 'function', name: 'existing-tool' });

  const result = onRelay(agent, relay);

  const toolNames = result.agent.tools.map((t: any) => t.name);
  assert.deepEqual(toolNames, [
    'existing-tool',
    'relay_send',
    'relay_inbox',
    'relay_post',
    'relay_agents',
  ]);

  for (const toolName of ['relay_send', 'relay_inbox', 'relay_post', 'relay_agents']) {
    const tool = result.agent.tools.find((t: any) => t.name === toolName);
    assert.ok(tool, `Expected ${toolName} to be registered`);
    assert.equal(tool.type, 'function');
    assert.equal(typeof tool.invoke, 'function');
    assert.ok(tool.parameters);
    assert.equal(tool.parameters.type, 'object');
  }
});

test('relay tools invoke correctly', async () => {
  const { onRelay } = await loadModule();
  const relay = new FakeRelay();
  const agent = createAgent();

  const result = onRelay(agent, relay);

  const agentsTool = result.agent.tools.find((t: any) => t.name === 'relay_agents');
  const output = await agentsTool.invoke(null, '{}');
  assert.equal(output, 'Lead\nImpl-TS');

  const inboxTool = result.agent.tools.find((t: any) => t.name === 'relay_inbox');
  const inboxOutput = await inboxTool.invoke(null, '{}');
  assert.equal(inboxOutput, 'No new relay messages.');
});

test('incoming relay messages are appended to instructions', async () => {
  const { onRelay } = await loadModule();
  const relay = new FakeRelay();
  const agent = createAgent('Base instructions.');

  onRelay(agent, relay);

  await relay.emit({ sender: 'Lead', text: 'Need status', messageId: 'msg-1' });

  const instructions = await agent.instructions();
  assert.match(instructions, /Base instructions\./);
  assert.match(instructions, /Lead/);
  assert.match(instructions, /Need status/);
});

test('pending messages are drained after instructions call', async () => {
  const { onRelay } = await loadModule();
  const relay = new FakeRelay();
  const agent = createAgent('Base.');

  onRelay(agent, relay);

  await relay.emit({ sender: 'Worker', text: 'Done', messageId: 'msg-2' });

  const first = await agent.instructions();
  assert.match(first, /Worker/);

  const second = await agent.instructions();
  assert.ok(!second.includes('Worker'), 'Messages should be drained after first read');
  assert.equal(second, 'Base.');
});

test('instructions function is preserved when original is a function', async () => {
  const { onRelay } = await loadModule();
  const relay = new FakeRelay();
  const agent = {
    name: 'FnAgent',
    instructions: async () => 'Dynamic instructions',
    tools: [] as any[],
  };

  onRelay(agent, relay);

  const output = await agent.instructions();
  assert.equal(output, 'Dynamic instructions');
});

test('cleanup restores original instructions and removes relay tools', async () => {
  const { onRelay } = await loadModule();
  const relay = new FakeRelay();
  const originalInstructions = 'Original.';
  const agent = createAgent(originalInstructions);

  const result = onRelay(agent, relay);

  assert.equal(result.agent.tools.length, 4);
  assert.equal(typeof result.agent.instructions, 'function');

  result.cleanup();

  assert.equal(result.agent.tools.length, 0);
  assert.equal(result.agent.instructions, originalInstructions);
});

test('cleanup stops message routing', async () => {
  const { onRelay } = await loadModule();
  const relay = new FakeRelay();
  const agent = createAgent('Base.');

  const result = onRelay(agent, relay);
  result.cleanup();

  await relay.emit({ sender: 'Late', text: 'Should not appear', messageId: 'msg-3' });

  // instructions was restored to a string, so no messages appended
  assert.equal(result.agent.instructions, 'Base.');
});
