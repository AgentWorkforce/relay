/**
 * Benchmark Harness
 *
 * Shared utilities for broker benchmark tests.
 * Run any benchmark with: npx tsx tests/benchmarks/<name>.ts [--quick]
 */

import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { HarnessDriverClient, type BrokerEvent } from '@agent-relay/harness-driver';

export const QUICK = process.argv.includes('--quick');

export function resolveBinaryPath(): string {
  if (process.env.AGENT_RELAY_BIN) {
    return process.env.AGENT_RELAY_BIN;
  }
  const exe = process.platform === 'win32' ? 'agent-relay-broker.exe' : 'agent-relay-broker';
  const candidates = [
    path.resolve(process.cwd(), 'target', 'debug', exe),
    path.resolve(process.cwd(), 'target', 'release', exe),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return exe;
}

export function randomName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function brokerTestEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RELAY_INJECT_RATE_MS: process.env.RELAY_INJECT_RATE_MS ?? '0',
  };
}

/**
 * The broker emits `delivery_verified` for two very different things, and only
 * one of them is evidence that a message landed:
 *
 *   - `verification: 'echo'` — the injection was read back out of the PTY.
 *   - `verification: 'timeout_fallback'` — the verification window expired and
 *     the worker never saw the echo. That is an explicit hand-off in doubt.
 *
 * Seam rule 4 in `docs/native-delivery-migration.md`: "Never claim an
 * acknowledgement you did not observe." A parity gate that matches on `kind`
 * alone counts the fallback as a delivery and goes green on a message nobody
 * ever saw arrive, which is exactly the silent semantic drift the parity suite
 * exists to catch.
 *
 * This is an allow-list, not a deny-list: any future `verification` value the
 * broker learns to emit must be opted in here deliberately, and it must be
 * opted in to match `is_observed` in
 * `crates/broker/src/broker/delivery_verification.rs`, which is the source of
 * truth for what counts as an observation.
 */
const OBSERVED_VERIFICATIONS = new Set(['echo', 'process_exit']);

export function isObservedDelivery(event: BrokerEvent): boolean {
  if (event.kind !== 'delivery_verified') return false;
  const { verification } = event as BrokerEvent & { verification?: string };
  return verification !== undefined && OBSERVED_VERIFICATIONS.has(verification);
}

/**
 * True for a `delivery_verified` that does NOT report an observation.
 *
 * Defined as the negation of `isObservedDelivery` over `delivery_verified`, so
 * the two cannot drift apart. They previously could: this file tested
 * `=== 'echo'` while the broker's `is_observed` accepted `echo | process_exit`,
 * so a headless delivery reporting `process_exit` — a genuine observation, the
 * child consumed the message and exited cleanly — was counted as unobserved.
 * Every parity harness hard-fails on `unobserved !== 0`, so the parity suite
 * would have gone red on a correctly delivered message.
 *
 * A frame with no `verification` counts as unobserved here. This is the
 * conservative direction for a parity gate: an unlabelled frame is not
 * evidence that anything was seen.
 */
export function isUnobservedDelivery(event: BrokerEvent): boolean {
  return event.kind === 'delivery_verified' && !isObservedDelivery(event);
}

export async function startBroker(): Promise<HarnessDriverClient> {
  return HarnessDriverClient.spawn({
    binaryPath: resolveBinaryPath(),
    channels: ['general'],
    env: brokerTestEnv(),
  });
}

export function waitForEvent(
  client: HarnessDriverClient,
  kind: string,
  timeoutMs = 15_000
): Promise<BrokerEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`timed out waiting for ${kind}`));
    }, timeoutMs);
    const unsub = client.onEvent((ev) => {
      if (ev.kind === kind) {
        clearTimeout(timer);
        unsub();
        resolve(ev);
      }
    });
  });
}

export interface Stats {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export function computeStats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count,
    min: sorted[0] ?? 0,
    max: sorted[count - 1] ?? 0,
    mean: sum / count,
    p50: sorted[Math.floor(count * 0.5)] ?? 0,
    p95: sorted[Math.floor(count * 0.95)] ?? 0,
    p99: sorted[Math.floor(count * 0.99)] ?? 0,
  };
}

export function printStats(label: string, stats: Stats): void {
  console.log(`\n  ${label} (n=${stats.count})`);
  console.log(`    min:  ${stats.min.toFixed(2)} ms`);
  console.log(`    p50:  ${stats.p50.toFixed(2)} ms`);
  console.log(`    p95:  ${stats.p95.toFixed(2)} ms`);
  console.log(`    p99:  ${stats.p99.toFixed(2)} ms`);
  console.log(`    max:  ${stats.max.toFixed(2)} ms`);
  console.log(`    mean: ${stats.mean.toFixed(2)} ms`);
}

export { performance };
