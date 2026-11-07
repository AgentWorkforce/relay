// A message sent on Relay reaches a running session through the route the tool
// itself uses. The session is the contract the core discovers, nothing more: a
// process named `cursor-agent` holding its conversation's store open, running
// the hooks in `~/.cursor/hooks.json` as children, with no model behind it.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import { scenario, waitFor, withSandbox } from './harness.mjs';

/** Starts a fake `cursor-agent` for a new conversation. */
function cursorSession(machine) {
  const id = randomUUID();
  const store = machine.write(`.cursor/chats/workspace/${id}/store.db`, '');
  const running = machine.fakeTool('cursor-agent', [store]);
  /** Runs the hook Cursor would, under this process, with Cursor's payload. */
  const hook = async (payload) => {
    const hooks = JSON.parse(machine.read('.cursor/hooks.json')).hooks.stop;
    const { command } = hooks.find((entry) => entry.command.includes('cursor-hook'));
    const input = machine.write(`.hook-${randomUUID()}.json`, JSON.stringify(payload));
    const output = `${input}.out`;
    running.child.stdin.write(`${JSON.stringify({ command, input, output })}\n`);
    await waitFor('the hook to finish', () => fs.existsSync(output));
    return fs.readFileSync(output, 'utf8');
  };
  return { id, hook };
}

/** Whichever agent the core registered for a session. */
async function registered(machine, id) {
  return waitFor('the session to join Relay', async () => {
    const agents = await machine.agents();
    return agents.find((agent) => JSON.stringify(agent).includes(id));
  });
}

const stopPayload = (id) => ({
  hook_event_name: 'stop',
  conversation_id: id,
  status: 'completed',
  loop_count: 0,
});

await scenario('a message reaches a running Cursor session and wakes it when its turn ends', () =>
  withSandbox(async (machine) => {
    machine.markInstalled('cursor');
    await machine.init(['cursor']);
    const session = cursorSession(machine);
    const agent = await registered(machine, session.id);
    assert.deepEqual(JSON.parse((await session.hook(stopPayload(session.id))) || '{}'), {});

    await machine.relayOk(['agent', 'register', 'alice']);
    const text = `hello ${randomUUID()}`;
    await machine.relayOk(['message', 'dm', 'send', agent.name, text, '--as', 'alice']);
    const answer = await waitFor('the message to reach the session', async () => {
      const raw = await session.hook(stopPayload(session.id));
      return raw.includes(text) ? JSON.parse(raw) : undefined;
    });
    assert.ok(answer.followup_message.includes(text));
    assert.ok(answer.followup_message.includes('alice'));
    await machine.assertLocalOnly();
  })
);
