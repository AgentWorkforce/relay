/**
 * Reliability Benchmark
 *
 * Sends many messages and counts delivery_verified vs delivery_failed.
 * Reports success rate.
 * Run: npx tsx tests/benchmarks/reliability.ts [--quick]
 */

import { QUICK, startBroker, randomName, performance } from './harness.js';
import type { BrokerEvent } from '@agent-relay/sdk';

const MESSAGE_COUNT = QUICK ? 50 : 500;

async function main(): Promise<void> {
  console.log(`Reliability Benchmark (${MESSAGE_COUNT} messages)`);
  const client = await startBroker();
  const receiver = randomName('reliability-recv');

  let verified = 0;
  let failed = 0;

  const unsub = client.onEvent((event: BrokerEvent) => {
    if (event.kind === 'delivery_verified') verified++;
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
