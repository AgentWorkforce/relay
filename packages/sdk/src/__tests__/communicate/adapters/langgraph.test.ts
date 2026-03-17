import assert from 'node:assert/strict';
import test from 'node:test';

const langgraphAdapterModulePath = '../../../communicate/adapters/langgraph.js';

async function loadLangGraphAdapterModule(): Promise<any> {
  return import(langgraphAdapterModulePath);
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

function createFakeGraph() {
  return {
    nodes: {},
    invokeCalls: [] as Array<{ input: Record<string, unknown>; config?: Record<string, unknown> }>,
    async invoke(input: Record<string, unknown>, config?: Record<string, unknown>) {
      this.invokeCalls.push({ input, config });
      return { messages: [] };
    },
  };
}

test('LangGraph onRelay returns relay tools', async () => {
  const { onRelay } = await loadLangGraphAdapterModule();
  const relay = new FakeRelay();
  const graph = createFakeGraph();

  const result = onRelay(graph, relay);

  const toolNames = result.tools.map((tool: any) => tool.name);
  assert.deepEqual(toolNames, ['relay_send', 'relay_inbox', 'relay_post', 'relay_agents']);

  for (const tool of result.tools) {
    assert.equal(typeof tool.invoke, 'function');
    assert.ok(tool.schema);
    assert.ok(tool.description);
  }
});

test('LangGraph relay_send tool calls relay.send', async () => {
  const { onRelay } = await loadLangGraphAdapterModule();
  const relay = new FakeRelay();
  const sendCalls: Array<{ to: string; text: string }> = [];
  relay.send = async (to: string, text: string) => {
    sendCalls.push({ to, text });
  };
  const graph = createFakeGraph();

  const result = onRelay(graph, relay);
  const sendTool = result.tools.find((t: any) => t.name === 'relay_send');

  const output = await sendTool.invoke({ to: 'Lead', text: 'Hello' });
  assert.equal(output, 'Sent relay message to Lead.');
  assert.deepEqual(sendCalls, [{ to: 'Lead', text: 'Hello' }]);
});

test('LangGraph relay_inbox tool returns formatted inbox', async () => {
  const { onRelay } = await loadLangGraphAdapterModule();
  const relay = new FakeRelay();
  const graph = createFakeGraph();

  const result = onRelay(graph, relay);
  const inboxTool = result.tools.find((t: any) => t.name === 'relay_inbox');

  const output = await inboxTool.invoke({});
  assert.equal(output, 'No new relay messages.');
});

test('LangGraph relay_post tool calls relay.post', async () => {
  const { onRelay } = await loadLangGraphAdapterModule();
  const relay = new FakeRelay();
  const postCalls: Array<{ channel: string; text: string }> = [];
  relay.post = async (channel: string, text: string) => {
    postCalls.push({ channel, text });
  };
  const graph = createFakeGraph();

  const result = onRelay(graph, relay);
  const postTool = result.tools.find((t: any) => t.name === 'relay_post');

  const output = await postTool.invoke({ channel: 'general', text: 'Update' });
  assert.equal(output, 'Posted relay message to #general.');
  assert.deepEqual(postCalls, [{ channel: 'general', text: 'Update' }]);
});

test('LangGraph relay_agents tool lists agents', async () => {
  const { onRelay } = await loadLangGraphAdapterModule();
  const relay = new FakeRelay();
  const graph = createFakeGraph();

  const result = onRelay(graph, relay);
  const agentsTool = result.tools.find((t: any) => t.name === 'relay_agents');

  const output = await agentsTool.invoke({});
  assert.equal(output, 'Lead\nImpl-TS');
});

test('LangGraph onRelay routes incoming messages via graph.invoke', async () => {
  const { onRelay } = await loadLangGraphAdapterModule();
  const relay = new FakeRelay();
  const graph = createFakeGraph();

  onRelay(graph, relay);

  await relay.emit({
    sender: 'Lead',
    text: 'Need status update',
    messageId: 'msg-1',
  });

  assert.equal(graph.invokeCalls.length, 1);
  const call = graph.invokeCalls[0];
  assert.ok(Array.isArray(call.input.messages));
  const msg = (call.input.messages as any[])[0];
  assert.equal(msg.role, 'user');
  assert.match(msg.content, /Lead/);
  assert.match(msg.content, /Need status update/);
});

test('LangGraph onRelay unsubscribe stops message routing', async () => {
  const { onRelay } = await loadLangGraphAdapterModule();
  const relay = new FakeRelay();
  const graph = createFakeGraph();

  const result = onRelay(graph, relay);
  result.unsubscribe();

  await relay.emit({
    sender: 'Lead',
    text: 'Should not arrive',
    messageId: 'msg-2',
  });

  assert.equal(graph.invokeCalls.length, 0);
});
