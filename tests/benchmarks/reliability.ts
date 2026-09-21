/**
 * Reliability Benchmark
 *
 * Sends many messages and counts OBSERVED deliveries vs failures.
 *
 * Counting every `delivery_verified` as a success reported 100% reliability on
 * messages that were all `timeout_fallback` — a delivery nobody saw land. The
 * reliability number has to mean "observed", or it measures whether the broker
 * emitted a frame rather than whether the message arrived.
 * Reports success rate.
 * Run: npx tsx tests/benchmarks/reliability.ts [--quick]
 */

import {
  QUICK,
  startBroker,
  randomName,
  performance,
  isObservedDelivery,
  isUnobservedDelivery,
} from './harness.js';
import type { BrokerEvent } from '@agent-relay/sdk';

const MESSAGE_COUNT = QUICK ? 50 : 500;

async function main(): Promise<void> {
  console.log(`Reliability Benchmark (${MESSAGE_COUNT} messages)`);
  const client = await startBroker();
  const receiver = randomName('reliability-recv');

  let verified = 0;
  let unobserved = 0;
  let failed = 0;

  const unsub = client.onEvent((event: BrokerEvent) => {
    if (isObservedDelivery(event)) verified++;
    else if (isUnobservedDelivery(event)) unobserved++;
    if (event.kind === 'delivery_failed') failed++;
  });

  try {
    await client.spawnPty({
      name: receiver,
      cli: 'cat',
      channels: ['general'],
    });

    // Warmup
    await client.sendMessage({ to: receiver, from: 'bench', text: 'warmup' });
    await new Promise((r) => setTimeout(r, 500));

    const start = performance.now();

    for (let i = 0; i < MESSAGE_COUNT; i++) {
      await client.sendMessage({
        to: receiver,
        from: 'bench',
        text: `reliability-${i}`,
      });
      // Small spacing to let broker process
      if (i % 10 === 0) {
        await new Promise((r) => setTimeout(r, 20));
      }
    }

    // Wait for trailing verifications
    await new Promise((r) => setTimeout(r, 3000));
    const elapsed = performance.now() - start;

    const total = verified + failed;
    const successRate = total > 0 ? (verified / total) * 100 : 0;

    console.log(`\n  Messages sent:      ${MESSAGE_COUNT}`);
    console.log(`  Delivery verified:  ${verified}`);
    console.log(`  Delivery failed:    ${failed}`);
    console.log(`  Success rate:       ${successRate.toFixed(1)}%`);
    console.log(`  Total time:         ${elapsed.toFixed(0)} ms`);
    console.log('\nDONE');
  } finally {
    unsub();
    try {
      await client.release(receiver);
    } catch {}
    await client.shutdown();
  }
}

main().catch((err) => {
  console.error('benchmark failed:', err);
  process.exit(1);
});
