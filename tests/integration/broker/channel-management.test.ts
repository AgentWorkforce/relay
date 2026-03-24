/**
 * Broker channel-management integration tests.
 *
 * Verifies subscribe/unsubscribe state changes and mute/unmute routing
 * behavior against the real broker binary when available.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { BrokerEvent } from '@agent-relay/sdk';
import { BrokerHarness, checkPrerequisites, uniqueSuffix } from './utils/broker-harness.js';
import { assertAgentExists, eventsForAgent } from './utils/assert-helpers.js';

function skipIfMissing(t: TestContext): boolean {
  const reason = checkPrerequisites();
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function workerOutput(events: BrokerEvent[], name: string): string {
  return eventsForAgent(events, name, 'worker_stream')
    .map((event) => (event as Extract<BrokerEvent, { kind: 'worker_stream' }>).chunk)
    .join('');
}

function isNamedChannelEvent(
  event: BrokerEvent,
  kind: string
): event is BrokerEvent & { kind: string; name: string; channels?: string[]; channel?: string } {
  const candidate = event as BrokerEvent & { kind?: string; name?: string };
  return candidate.kind === kind && typeof candidate.name === 'string';
}

async function sendMessageOrSkip(
  t: TestContext,
  harness: BrokerHarness,
  input: { to: string; text: string; from?: string }
): Promise<{ event_id: string; targets: string[] }> {
  try {
    const result = await harness.sendMessage(input);
    if (result.event_id === 'unsupported_operation') {
      t.skip('send_message is unsupported by this broker build');
      return result;
    }
    return result;
  } catch (error) {
    if ((error as { code?: string })?.code === 'unsupported_operation') {
      t.skip('send_message is unsupported by this broker build');
      return { event_id: 'unsupported_operation', targets: [] };
    }
    throw error;
  }
}

test('broker: channel management subscribe, mute, unmute, and unsubscribe flow', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `channel-mgmt-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, 'cat', ['ch-a']);
    await harness.waitForEvent(
      'agent_spawned',
      10_000,
      (event) => event.kind === 'agent_spawned' && event.name === agentName
    ).promise;
    await harness.waitForEvent(
      'worker_ready',
      10_000,
      (event) => event.kind === 'worker_ready' && event.name === agentName
    ).promise;

    await (harness.client as any).subscribeChannels(agentName, ['ch-b']);
    await harness.waitForEvent(
      'channel_subscribed',
      10_000,
      (event) =>
        isNamedChannelEvent(event, 'channel_subscribed') &&
        event.name === agentName &&
        Array.isArray(event.channels) &&
        event.channels.includes('ch-b')
    ).promise;

    let agent = await assertAgentExists(harness, agentName);
    assert.deepEqual(
      [...agent.channels].sort(),
      ['ch-a', 'ch-b'].sort(),
      'agent should be subscribed to both channels after subscribeChannels'
    );

    await (harness.client as any).muteChannel(agentName, 'ch-a');
    await harness.waitForEvent(
      'channel_muted',
      10_000,
      (event) => isNamedChannelEvent(event, 'channel_muted') && event.name === agentName && event.channel === 'ch-a'
    ).promise;

    harness.clearEvents();
    const mutedText = `muted-message-${uniqueSuffix()}`;
    await sendMessageOrSkip(t, harness, { to: '#ch-a', text: mutedText, from: 'system' });
    await sleep(1_500);

    let output = workerOutput(harness.getEvents(), agentName);
    assert.equal(
      output.includes(mutedText),
      false,
      `muted channel message should not reach PTY output, got: ${JSON.stringify(output)}`
    );

    await (harness.client as any).unmuteChannel(agentName, 'ch-a');
    await harness.waitForEvent(
      'channel_unmuted',
      10_000,
      (event) =>
        isNamedChannelEvent(event, 'channel_unmuted') && event.name === agentName && event.channel === 'ch-a'
    ).promise;

    harness.clearEvents();
    const unmutedText = `unmuted-message-${uniqueSuffix()}`;
    await sendMessageOrSkip(t, harness, { to: '#ch-a', text: unmutedText, from: 'system' });
    await sleep(1_500);

    output = workerOutput(harness.getEvents(), agentName);
    assert.ok(
      output.includes(unmutedText),
      `unmuted channel message should reach PTY output, got: ${JSON.stringify(output)}`
    );

    await (harness.client as any).unsubscribeChannels(agentName, ['ch-b']);
    await harness.waitForEvent(
      'channel_unsubscribed',
      10_000,
      (event) =>
        isNamedChannelEvent(event, 'channel_unsubscribed') &&
        event.name === agentName &&
        Array.isArray(event.channels) &&
        event.channels.includes('ch-b')
    ).promise;

    agent = await assertAgentExists(harness, agentName);
    assert.deepEqual(agent.channels, ['ch-a'], 'agent should only remain subscribed to ch-a after unsubscribe');
  } finally {
    try {
      await harness.releaseAgent(agentName);
    } catch {
      // Ignore cleanup errors when a test exits early.
    }
    await harness.stop();
  }
});
