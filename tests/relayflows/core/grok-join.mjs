// A running Grok session joins Relay on its own and receives messages through
// its leader. The core proves the leader from the kernel: its process, socket
// and peer. Without a leader there is no route, so the session stays off Relay.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { leaveRoot, repoRoot, scenario, waitFor, withSandbox } from './harness.mjs';

leaveRoot(import.meta.url);

/** A Grok TUI as the core finds it: a `grok` process and its registry record. */
function grokSession(machine) {
  const id = randomUUID();
  const tui = machine.fakeTool('grok', []);
  machine.write(
    '.grok/active_sessions.json',
    JSON.stringify([
      {
        session_id: id,
        pid: tui.child.pid,
        cwd: fs.realpathSync(machine.project),
        opened_at: new Date().toISOString(),
      },
    ])
  );
  return id;
}

function startLeader(machine) {
  fs.copyFileSync(
    path.join(repoRoot, 'tests/relayflows/core/fake-grok-agent.cjs'),
    path.join(machine.project, 'agent')
  );
  machine.spawn(path.join(machine.bin, 'grok'), ['agent', 'leader'], 'grok-leader');
}

await scenario('a Grok session with no leader stays off Relay', () =>
  withSandbox(async (machine) => {
    machine.markInstalled('grok');
    await machine.init(['grok']);
    const id = grokSession(machine);
    await waitFor('the core to list the session', async () =>
      JSON.stringify(await machine.call('sessions.list')).includes(id)
    );
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    assert.ok(!JSON.stringify(await machine.agents()).includes(id));
  })
);

await scenario('a Grok session joins Relay on its own and receives a message', () =>
  withSandbox(async (machine) => {
    machine.markInstalled('grok');
    await machine.init(['grok']);
    const id = grokSession(machine);
    startLeader(machine);
    const agent = await waitFor('the session to join Relay', async () => {
      const agents = await machine.agents();
      return agents.find((candidate) => JSON.stringify(candidate).includes(id));
    }).catch(async (error) => {
      const refused = await machine
        .call('agents.register', { target: { kind: 'grok-open', id } })
        .catch((failure) => failure.message);
      console.log(`uid ${process.getuid()} agents.register: ${JSON.stringify(refused)}`);
      throw error;
    });

    await machine.relayOk(['agent', 'register', 'alice']);
    const text = `hello ${randomUUID()}`;
    await machine.relayOk(['message', 'dm', 'send', agent.name, text, '--as', 'alice']);
    const prompts = path.join(machine.project, 'prompts.jsonl');
    const prompt = await waitFor('the prompt to reach the leader', () => {
      if (!fs.existsSync(prompts)) return undefined;
      return fs
        .readFileSync(prompts, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((candidate) => candidate.text.includes(text));
    });
    assert.equal(prompt.sessionId, id);
    assert.ok(prompt.text.includes('alice'));
    await machine.assertLocalOnly();
  })
);
