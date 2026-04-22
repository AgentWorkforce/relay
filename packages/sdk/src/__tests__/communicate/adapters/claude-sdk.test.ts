import assert from 'node:assert/strict';
import { test } from 'vitest';

const claudeAdapterModulePath = '../../../communicate/adapters/claude-sdk.js';

async function loadClaudeAdapterModule(): Promise<any> {
  return import(claudeAdapterModulePath);
}

class FakeRelay {
  inboxCalls = 0;
  private queuedMessages: any[] = [];

  queue(...messages: any[]): void {
    this.queuedMessages.push(...messages);
  }

  async inbox(): Promise<any[]> {
    this.inboxCalls += 1;
    const drained = [...this.queuedMessages];
    this.queuedMessages = [];
    return drained;
  }
}

function getAddedHook(options: any, eventName: 'PostToolUse' | 'Stop') {
  const matchers = options.hooks?.[eventName];
  assert.ok(Array.isArray(matchers), `Expected ${eventName} matchers to be configured`);
  assert.ok(matchers.length > 0, `Expected at least one ${eventName} matcher`);

  const matcher = matchers.at(-1);
  assert.ok(Array.isArray(matcher.hooks), `Expected ${eventName} matcher to contain hook callbacks`);
  assert.equal(matcher.hooks.length, 1);

  return matcher.hooks[0];
}

test('Claude onRelay injects the Relaycast MCP server into query options', async () => {
  const { onRelay } = await loadClaudeAdapterModule();
  const relay = new FakeRelay();

  const options = onRelay(
    'ClaudeTester',
    {
      mcpServers: {
        existing: {
          command: 'node',
          args: ['./other-mcp.js'],
        },
      },
    },
    relay
  );

  assert.ok(options.mcpServers);
  assert.deepEqual(options.mcpServers.existing, {
    command: 'node',
    args: ['./other-mcp.js'],
  });
  assert.deepEqual(options.mcpServers.relaycast, {
    command: 'agent-relay',
    args: ['mcp'],
  });
  assert.ok(options.hooks?.PostToolUse?.length);
  assert.ok(options.hooks?.Stop?.length);
});

test('Claude PostToolUse hook returns a systemMessage when relay inbox messages are pending', async () => {
  const { onRelay } = await loadClaudeAdapterModule();
  const relay = new FakeRelay();
  relay.queue({
    sender: 'Other',
    text: 'Hello',
    messageId: 'message-1',
  });

  const options = onRelay('ClaudeTester', {}, relay);
  const postToolUseHook = getAddedHook(options, 'PostToolUse');

  const result = await postToolUseHook(
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: {},
      tool_response: {},
      tool_use_id: 'tool-1',
    },
    'tool-1',
    { signal: new AbortController().signal }
  );

  assert.equal(relay.inboxCalls, 1);
  assert.ok(result);
  assert.equal(typeof result.systemMessage, 'string');
  assert.match(result.systemMessage, /New messages from other agents:/);
  assert.match(result.systemMessage, /Relay message from Other: Hello/);
});

test('Claude Stop hook continues the agent when relay messages are pending', async () => {
  const { onRelay } = await loadClaudeAdapterModule();
  const relay = new FakeRelay();
  relay.queue({
    sender: 'Other',
    text: 'Wait!',
    messageId: 'message-2',
  });

  const options = onRelay('ClaudeTester', {}, relay);
  const stopHook = getAddedHook(options, 'Stop');

  const result = await stopHook(
    {
      hook_event_name: 'Stop',
      stop_hook_active: true,
      last_assistant_message: 'Stopping now',
    },
    undefined,
    { signal: new AbortController().signal }
  );

  assert.equal(relay.inboxCalls, 1);
  assert.ok(result);
  assert.equal(result.continue, true);
  assert.equal(typeof result.systemMessage, 'string');
  assert.match(result.systemMessage, /Relay message from Other: Wait!/);
});

test('Claude onRelay preserves existing PostToolUse and Stop hook matchers', async () => {
  const { onRelay } = await loadClaudeAdapterModule();
  const relay = new FakeRelay();

  const existingPostToolUse = async () => ({ systemMessage: 'Existing post hook' });
  const existingStop = async () => ({ continue: false, systemMessage: 'Existing stop hook' });

  const options = onRelay(
    'ClaudeTester',
    {
      hooks: {
        PostToolUse: [
          {
            matcher: 'existing-post',
            hooks: [existingPostToolUse],
          },
        ],
        Stop: [
          {
            matcher: 'existing-stop',
            hooks: [existingStop],
          },
        ],
      },
    },
    relay
  );

  assert.equal(options.hooks.PostToolUse.length, 2);
  assert.equal(options.hooks.PostToolUse[0].hooks[0], existingPostToolUse);
  assert.equal(options.hooks.PostToolUse[0].matcher, 'existing-post');

  assert.equal(options.hooks.Stop.length, 2);
  assert.equal(options.hooks.Stop[0].hooks[0], existingStop);
  assert.equal(options.hooks.Stop[0].matcher, 'existing-stop');
});
