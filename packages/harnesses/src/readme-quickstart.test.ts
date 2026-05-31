import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AgentRelay } from '@agent-relay/sdk';
import { registerDriverActions, type AgentDriver } from '@agent-relay/runtime';

import { claude, codex } from './index.js';

/**
 * Compile-time proof that the README's documented public API exists with the
 * documented shapes. The body is never executed (no broker / network) — if this
 * file type-checks, the implementation matches the README.
 */
async function quickStart(): Promise<void> {
  const relay = await AgentRelay.createWorkspace({ name: 'support-triage' });
  const harnesses = { claude, codex };

  const complaintTriager = await harnesses.claude.create({ model: 'sonnet' });
  const engineer = await harnesses.codex.create({ model: 'gpt-5.5' });
  const taskManager = await harnesses.claude.create({ model: 'sonnet' });

  await relay.workspace.register([complaintTriager, engineer, taskManager]);

  await relay.sendMessage({
    to: '#customer-complaints',
    msg: `${complaintTriager.handle} please work with ${taskManager.handle} and ${engineer.handle}`,
  });

  relay.on(
    engineer.status.becomes('idle'),
    relay.notify(taskManager, {
      type: 'agent.status.idle',
      subject: engineer,
      delivery: 'next-tool-call',
    })
  );

  relay.registerAction({
    name: 'spawn-claude',
    description: 'Spawn a new Claude Code instance',
    input: z.object({ model: z.enum(['opus', 'sonnet']) }),
    availableTo: [taskManager, engineer],
    handler: async ({ input }) => {
      const agent = claude.new({ model: input.model });
      await relay.workspace.register(agent);
      return { agentId: agent.id, handle: agent.handle };
    },
  });

  relay.on(
    relay.action('spawn-claude').calledBy(engineer),
    relay.notify(taskManager, { action: 'spawn-claude', subject: engineer })
  );

  relay.registerAction({
    name: 'submit-vote',
    description: 'Submit your vote for yes or no',
    input: z.object({ vote: z.enum(['yes', 'no']) }),
    handler: async ({ agent, input }) => {
      void agent.name;
      void input.vote;
    },
  });
}

async function messagingExample(): Promise<void> {
  const relay = await AgentRelay.createWorkspace({ name: 'ops' });
  const engineer = claude.new();
  const taskManager = claude.new();

  const message = await relay.messages.send({
    to: '#customer-complaints',
    from: taskManager,
    text: `${engineer.handle} please turn the top billing complaint into a PR.`,
    mentions: [engineer],
    mode: 'wait',
    attachments: [
      { type: 'link', url: 'https://linear.app/acme/issue/BILL-123' },
      { type: 'file', path: 'support/export/customer-complaints.csv' },
    ],
    idempotencyKey: 'complaint:1:triage-request',
  });

  await relay.messages.reply({
    thread: message.threadId,
    from: engineer,
    text: 'I am checking the billing repro now.',
  });

  await relay.messages.react({ message: message.id, agent: taskManager, emoji: 'eyes' });
}

async function listenerExample(): Promise<void> {
  const relay = await AgentRelay.createWorkspace({ name: 'ops' });
  const engineer = claude.new();
  const taskManager = claude.new();

  relay.on(relay.events.message.created().in('#customer-complaints').mentions(engineer), async (event) => {
    await relay.messages.direct({
      to: taskManager.name,
      text: `${engineer.handle} was asked to handle ${event.message.id}`,
    });
  });

  relay.on(
    engineer.tools.called('bash').where((call) => String((call.input as { command?: string })?.command).includes('npm test')),
    async (event) => {
      void event.run;
    }
  );
}

async function actionsExample(driver: AgentDriver): Promise<void> {
  const relay = await AgentRelay.createWorkspace({ name: 'operator-workspace' });

  relay.actions.register({
    name: 'ui.show_search_results',
    description: 'Show a result set in the operator UI.',
    inputSchema: z.object({ query: z.string() }),
    outputSchema: z.object({ displayed: z.boolean() }),
    handler: async (input) => {
      void input.query;
      return { displayed: true };
    },
  });

  registerDriverActions(relay.actions, driver);

  const result = await relay.actions.invoke({
    name: 'agent.create',
    input: { name: 'reviewer', cli: 'codex', task: 'Review the migration guide.', channels: ['planning'] },
    caller: { name: 'planner', type: 'agent' },
  });

  if (!result.ok) {
    throw new Error(result.error?.message);
  }
}

describe('README examples (compile-time contract)', () => {
  it('exposes every documented API shape', () => {
    expect(typeof quickStart).toBe('function');
    expect(typeof messagingExample).toBe('function');
    expect(typeof listenerExample).toBe('function');
    expect(typeof actionsExample).toBe('function');
  });
});
