/**
 * Parity Test: Multiple Workers Communication
 *
 * Port of tests/integration/sdk/06-multi-worker.js using broker-sdk.
 * Spawns 3 workers, sends ping to each, verifies all respond.
 * Run: npx tsx tests/parity/multi-worker.ts
 */

import { AgentRelayClient, type BrokerEvent } from '@agent-relay/sdk';
import { resolveBinaryPath, randomName } from '../benchmarks/harness.js';

const WORKER_COUNT = 3;

async function main(): Promise<void> {
  console.log('=== Parity Test: Multiple Workers Communication ===\n');

  const client = await AgentRelayClient.start({
    binaryPath: resolveBinaryPath(),
    channels: ['general'],
    env: process.env,
  });

  const workers: string[] = [];

  try {
    // Step 1: Spawn workers
    console.log(`1. Spawning ${WORKER_COUNT} workers...`);
    for (let i = 0; i < WORKER_COUNT; i++) {
      const name = randomName(`mw-${i}`);
      await client.spawnPty({
        name,
        cli: 'cat',
        channels: ['general'],
      });
      workers.push(name);
      console.log(`   Spawned: ${name}`);
    }
    console.log('');

    await new Promise((r) => setTimeout(r, 500));

    // Step 2: Send ping to each worker
    console.log('2. Sending ping to each worker...');
    let sendOk = 0;
    for (const worker of workers) {
      const result = await client.sendMessage({
        to: worker,
        from: 'orchestrator',
        text: JSON.stringify({ type: 'ping', from: 'orchestrator' }),
      });
      if (result.event_id !== 'unsupported_operation') {
        sendOk++;
        console.log(`   Ping → ${worker}: OK`);
      } else {
        console.log(`   Ping → ${worker}: FAILED`);
      }
    }
    console.log('');

    // Step 3: Wait for delivery verification
    console.log('3. Waiting for delivery verifications...');
    let verified = 0;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      const unsub = client.onEvent((event: BrokerEvent) => {
        if (event.kind === 'delivery_verified') {
          verified++;
          if (verified >= WORKER_COUNT) {
            clearTimeout(timer);
            unsub();
            resolve();
          }
        }
      });
    });
    console.log(`   Deliveries verified: ${verified}/${WORKER_COUNT}\n`);

    // Step 4: Send messages between workers (worker 0 → worker 1, worker 1 → worker 2)
    console.log('4. Testing inter-worker messages...');
    let interOk = 0;
    for (let i = 0; i < WORKER_COUNT - 1; i++) {
      const result = await client.sendMessage({
        to: workers[i + 1]!,
        from: workers[i]!,
        text: `Message from worker ${i} to worker ${i + 1}`,
      });
      if (result.event_id !== 'unsupported_operation') {
        interOk++;
      }
    }
    console.log(`   Inter-worker sends: ${interOk}/${WORKER_COUNT - 1}\n`);

    await new Promise((r) => setTimeout(r, 1000));

    // Results
    const passed = sendOk === WORKER_COUNT && verified === WORKER_COUNT && interOk === WORKER_COUNT - 1;
    console.log(
      passed ? '=== Multi-Worker Parity Test PASSED ===' : '=== Multi-Worker Parity Test FAILED ==='
    );
    process.exit(passed ? 0 : 1);
  } finally {
    for (const name of workers) {
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
