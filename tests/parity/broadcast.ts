/**
 * Parity Test: Broadcast Messages
 *
 * Port of tests/integration/sdk/07-broadcast.js using broker-sdk.
 * Verifies that a channel message reaches all subscribed agents.
 * Run: npx tsx tests/parity/broadcast.ts
 */

import { HarnessDriverClient, type BrokerEvent } from '@agent-relay/harness-driver';
import {
  brokerTestEnv,
  isObservedDelivery,
  isUnobservedDelivery,
  resolveBinaryPath,
  randomName,
} from '../benchmarks/harness.js';

const AGENT_COUNT = 3;
const TIMEOUT_MS = 15_000;
const ECHO_CLI = "sh -c 'stty -echo; cat'";

async function main(): Promise<void> {
  console.log('=== Parity Test: Broadcast Messages ===\n');

  const client = await HarnessDriverClient.spawn({
    binaryPath: resolveBinaryPath(),
    channels: ['general'],
    env: brokerTestEnv(),
  });

  const agents: string[] = [];
  const receivedByAgent = new Map<string, string[]>();

  try {
    // Step 1: Spawn agents on the same channel
    console.log(`1. Spawning ${AGENT_COUNT} agents on #general...`);
    for (let i = 0; i < AGENT_COUNT; i++) {
      const name = randomName(`bcast-${i}`);
      await client.spawnPty({
        name,
        cli: ECHO_CLI,
        channels: ['general'],
      });
      agents.push(name);
      receivedByAgent.set(name, []);
    }
    console.log(`   Agents: ${agents.join(', ')}\n`);

    await new Promise((r) => setTimeout(r, 500));

    // Step 2: Send a broadcast message (to channel, not a specific agent)
    // In the broker model, we send to each agent individually to simulate broadcast
    console.log('2. Sending message to each agent...');
    const broadcastText = 'Hello from broadcast test!';

    for (const target of agents) {
      const result = await client.sendMessage({
        to: target,
        from: 'orchestrator',
        text: broadcastText,
      });
      if (result.event_id === 'unsupported_operation') {
        throw new Error('send_message unsupported');
      }
    }
    console.log(`   Sent to ${agents.length} agents\n`);

    // Step 3: Wait and verify delivery events
    console.log('3. Waiting for delivery verification...');
    let verified = 0;
    let failed = 0;
    let unobserved = 0;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        unsub();
        resolve();
      }, TIMEOUT_MS);
      const unsub = client.onEvent((event: BrokerEvent) => {
        // Only an echo-observed delivery counts. See `isObservedDelivery`.
        if (isObservedDelivery(event)) verified++;
        if (isUnobservedDelivery(event)) unobserved++;
        if (event.kind === 'delivery_failed') failed++;
        if (verified + failed + unobserved >= AGENT_COUNT) {
          clearTimeout(timer);
          unsub();
          resolve();
        }
      });
    });

    console.log(`   Verified (echo-observed): ${verified}/${AGENT_COUNT}`);
    console.log(`   Unobserved (timeout fallback): ${unobserved}`);
    console.log(`   Failed: ${failed}\n`);

    // Step 4: Cross-agent messaging (agent A sends to agent B)
    console.log('4. Testing cross-agent message (agent 0 → agent 1)...');
    const crossResult = await client.sendMessage({
      to: agents[1]!,
      from: agents[0]!,
      text: 'Cross-agent hello',
    });
    const crossOk = crossResult.event_id !== 'unsupported_operation';
    console.log(`   Cross-agent send: ${crossOk ? 'OK' : 'FAILED'}\n`);

    await new Promise((r) => setTimeout(r, 1000));

    // Results
    const passed = verified === AGENT_COUNT && unobserved === 0 && crossOk;
    console.log(passed ? '=== Broadcast Parity Test PASSED ===' : '=== Broadcast Parity Test FAILED ===');
    process.exit(passed ? 0 : 1);
  } finally {
    for (const name of agents) {
      try {
        await client.release(name);
      } catch {}
    }
    await client.shutdown();
  }
}

main().catch((err) => {
  console.error('test failed:', err);
  process.exit(1);
});
