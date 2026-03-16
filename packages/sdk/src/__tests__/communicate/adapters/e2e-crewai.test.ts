import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Relay } from '../../../communicate/core.js';
import { onRelay, onCrewRelay } from '../../../communicate/adapters/crewai.js';

const AGENT_NAME = `e2e-crewai-${randomUUID().slice(0, 8)}`;

function createAgent(role: string) {
  return {
    role,
    tools: [] as any[],
    step_callback: null as ((step: any) => void) | null,
  };
}

test('CrewAI adapter e2e: onRelay tools work against live Relaycast', async () => {
  const relay = new Relay(AGENT_NAME, { autoCleanup: false });

  try {
    const agent = createAgent(AGENT_NAME);
    const { unsubscribe } = onRelay(agent, relay);

    const findTool = (name: string) => {
      const tool = agent.tools.find((t: any) => t.tool_name === name);
      assert.ok(tool, `Tool ${name} not found`);
      return tool;
    };

    const relaySend = findTool('relay_send');
    const relayInbox = findTool('relay_inbox');
    const relayPost = findTool('relay_post');
    const relayAgents = findTool('relay_agents');

    // relay_agents: should list at least our agent
    const agentsResult = await relayAgents.execute({});
    console.log('relay_agents result:', agentsResult);
    assert.ok(agentsResult.includes(AGENT_NAME), `Expected agent list to include ${AGENT_NAME}`);

    // relay_send: send a DM to ourselves
    const sendResult = await relaySend.execute({ to: AGENT_NAME, text: 'e2e self-ping' });
    console.log('relay_send result:', sendResult);
    assert.ok(sendResult.includes('Sent relay message'), 'Expected send confirmation');

    // relay_post: post to general channel
    const postResult = await relayPost.execute({ channel: 'general', text: `e2e crewai test from ${AGENT_NAME}` });
    console.log('relay_post result:', postResult);
    assert.ok(postResult.includes('Posted relay message'), 'Expected post confirmation');

    // relay_inbox: drain inbox
    const inboxResult = await relayInbox.execute({});
    console.log('relay_inbox result:', inboxResult);
    assert.ok(typeof inboxResult === 'string', 'Expected inbox text string');

    // unsubscribe: stop message routing
    unsubscribe();
    console.log('onRelay unsubscribe called successfully.');

    console.log('All CrewAI onRelay e2e checks passed.');
  } finally {
    await relay.close();
    console.log('Relay connection closed.');
  }
});

test('CrewAI adapter e2e: onCrewRelay adds tools to all crew agents', async () => {
  const crewAgentName = `e2e-crew-${randomUUID().slice(0, 8)}`;
  const relay = new Relay(crewAgentName, { autoCleanup: false });

  try {
    const agent1 = createAgent('researcher');
    const agent2 = createAgent('writer');
    const crew = { agents: [agent1, agent2], task_callback: null };

    const { unsubscribe } = onCrewRelay(crew, relay);

    // Both agents should have all 4 relay tools
    for (const agent of [agent1, agent2]) {
      const toolNames = agent.tools.map((t: any) => t.tool_name);
      assert.ok(toolNames.includes('relay_send'), `${agent.role} missing relay_send`);
      assert.ok(toolNames.includes('relay_inbox'), `${agent.role} missing relay_inbox`);
      assert.ok(toolNames.includes('relay_post'), `${agent.role} missing relay_post`);
      assert.ok(toolNames.includes('relay_agents'), `${agent.role} missing relay_agents`);
    }

    // Use a tool from one of the crew agents against live API
    const agentsTool = agent1.tools.find((t: any) => t.tool_name === 'relay_agents');
    const agentsResult = await agentsTool.execute({});
    console.log('onCrewRelay relay_agents result:', agentsResult);
    assert.ok(agentsResult.includes(crewAgentName), `Expected crew agent ${crewAgentName} in list`);

    unsubscribe();
    console.log('onCrewRelay unsubscribe called successfully.');

    console.log('All CrewAI onCrewRelay e2e checks passed.');
  } finally {
    await relay.close();
    console.log('Crew relay connection closed.');
  }
});
