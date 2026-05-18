import assert from 'node:assert/strict';
import { test } from 'vitest';

const crewaiAdapterModulePath = '../../../communicate/adapters/crewai.js';

async function loadCrewAIAdapterModule(): Promise<any> {
  return import(crewaiAdapterModulePath);
}

class FakeRelay {
  private callbacks: Array<(message: any) => void | Promise<void>> = [];
  sendCalls: Array<{ to: string; text: string }> = [];
  postCalls: Array<{ channel: string; text: string }> = [];

  async send(to: string, text: string): Promise<void> {
    this.sendCalls.push({ to, text });
  }

  async post(channel: string, text: string): Promise<void> {
    this.postCalls.push({ channel, text });
  }

  async inbox(): Promise<any[]> {
    return [];
  }

  async agents(): Promise<string[]> {
    return ['Lead', 'Worker-1'];
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

function createAgent(opts: { role?: string; tools?: any[]; step_callback?: any } = {}) {
  return {
    role: opts.role ?? 'researcher',
    tools: opts.tools ?? [],
    step_callback: opts.step_callback ?? null,
  };
}

function createCrew(agents: any[]) {
  return {
    agents,
    task_callback: null,
  };
}

test('CrewAI onRelay appends relay tools to agent.tools', async () => {
  const { onRelay } = await loadCrewAIAdapterModule();
  const relay = new FakeRelay();
  const agent = createAgent({ tools: [{ tool_name: 'existing_tool', description: 'Existing' }] });

  onRelay(agent, relay);

  const toolNames = agent.tools.map((t: any) => t.tool_name);
  assert.deepEqual(toolNames, ['existing_tool', 'relay_send', 'relay_inbox', 'relay_post', 'relay_agents']);

  for (const toolName of ['relay_send', 'relay_inbox', 'relay_post', 'relay_agents']) {
    const tool = agent.tools.find((t: any) => t.tool_name === toolName);
    assert.ok(tool, `Expected ${toolName} to be registered`);
    assert.equal(typeof tool.execute, 'function');
    assert.ok(tool.description);
  }
});

test('CrewAI relay_send tool calls relay.send', async () => {
  const { onRelay } = await loadCrewAIAdapterModule();
  const relay = new FakeRelay();
  const agent = createAgent();

  onRelay(agent, relay);

  const sendTool = agent.tools.find((t: any) => t.tool_name === 'relay_send');
  const result = await sendTool.execute({ to: 'Worker-1', text: 'hello' });

  assert.equal(relay.sendCalls.length, 1);
  assert.deepEqual(relay.sendCalls[0], { to: 'Worker-1', text: 'hello' });
  assert.match(result, /Sent relay message to Worker-1/);
});

test('CrewAI relay_post tool calls relay.post', async () => {
  const { onRelay } = await loadCrewAIAdapterModule();
  const relay = new FakeRelay();
  const agent = createAgent();

  onRelay(agent, relay);

  const postTool = agent.tools.find((t: any) => t.tool_name === 'relay_post');
  const result = await postTool.execute({ channel: 'general', text: 'update' });

  assert.equal(relay.postCalls.length, 1);
  assert.deepEqual(relay.postCalls[0], { channel: 'general', text: 'update' });
  assert.match(result, /Posted relay message to #general/);
});

test('CrewAI relay_inbox tool returns formatted inbox', async () => {
  const { onRelay } = await loadCrewAIAdapterModule();
  const relay = new FakeRelay();
  const agent = createAgent();

  onRelay(agent, relay);

  const inboxTool = agent.tools.find((t: any) => t.tool_name === 'relay_inbox');
  const result = await inboxTool.execute({});

  assert.equal(result, 'No new relay messages.');
});

test('CrewAI relay_agents tool lists agents', async () => {
  const { onRelay } = await loadCrewAIAdapterModule();
  const relay = new FakeRelay();
  const agent = createAgent();

  onRelay(agent, relay);

  const agentsTool = agent.tools.find((t: any) => t.tool_name === 'relay_agents');
  const result = await agentsTool.execute({});

  assert.equal(result, 'Lead\nWorker-1');
});

test('CrewAI onRelay routes incoming messages via step_callback', async () => {
  const { onRelay } = await loadCrewAIAdapterModule();
  const relay = new FakeRelay();
  const stepCalls: any[] = [];
  const agent = createAgent({
    step_callback: (step: any) => {
      stepCalls.push(step);
    },
  });

  onRelay(agent, relay);

  await relay.emit({
    sender: 'Lead',
    text: 'Need status update',
    messageId: 'msg-1',
  });

  assert.equal(stepCalls.length, 1);
  assert.ok(stepCalls[0].relay_message);
  assert.match(stepCalls[0].relay_message, /Lead/);
  assert.match(stepCalls[0].relay_message, /Need status update/);
});

test('CrewAI onRelay unsubscribe stops message routing', async () => {
  const { onRelay } = await loadCrewAIAdapterModule();
  const relay = new FakeRelay();
  const stepCalls: any[] = [];
  const agent = createAgent({
    step_callback: (step: any) => {
      stepCalls.push(step);
    },
  });

  const { unsubscribe } = onRelay(agent, relay);

  await relay.emit({ sender: 'A', text: 'first', messageId: 'm1' });
  assert.equal(stepCalls.length, 1);

  unsubscribe();

  await relay.emit({ sender: 'B', text: 'second', messageId: 'm2' });
  assert.equal(stepCalls.length, 1); // no new calls after unsubscribe
});

test('CrewAI onCrewRelay adds tools to all agents in a crew', async () => {
  const { onCrewRelay } = await loadCrewAIAdapterModule();
  const relay = new FakeRelay();
  const agent1 = createAgent({ role: 'researcher' });
  const agent2 = createAgent({ role: 'writer' });
  const crew = createCrew([agent1, agent2]);

  onCrewRelay(crew, relay);

  for (const agent of [agent1, agent2]) {
    const toolNames = agent.tools.map((t: any) => t.tool_name);
    assert.ok(toolNames.includes('relay_send'), `${agent.role} should have relay_send`);
    assert.ok(toolNames.includes('relay_inbox'), `${agent.role} should have relay_inbox`);
    assert.ok(toolNames.includes('relay_post'), `${agent.role} should have relay_post`);
    assert.ok(toolNames.includes('relay_agents'), `${agent.role} should have relay_agents`);
  }
});

test('CrewAI onCrewRelay unsubscribe stops all routing', async () => {
  const { onCrewRelay } = await loadCrewAIAdapterModule();
  const relay = new FakeRelay();
  const stepCalls1: any[] = [];
  const stepCalls2: any[] = [];
  const agent1 = createAgent({
    role: 'a1',
    step_callback: (s: any) => {
      stepCalls1.push(s);
    },
  });
  const agent2 = createAgent({
    role: 'a2',
    step_callback: (s: any) => {
      stepCalls2.push(s);
    },
  });
  const crew = createCrew([agent1, agent2]);

  const { unsubscribe } = onCrewRelay(crew, relay);

  await relay.emit({ sender: 'X', text: 'ping', messageId: 'm1' });
  assert.equal(stepCalls1.length, 1);
  assert.equal(stepCalls2.length, 1);

  unsubscribe();

  await relay.emit({ sender: 'Y', text: 'pong', messageId: 'm2' });
  assert.equal(stepCalls1.length, 1);
  assert.equal(stepCalls2.length, 1);
});
