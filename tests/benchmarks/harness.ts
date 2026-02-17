/**
 * Benchmark Harness
 *
 * Shared utilities for broker benchmark tests.
 * Run any benchmark with: npx tsx tests/benchmarks/<name>.ts [--quick]
 */

import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";
import {
  AgentRelayClient,
  type BrokerEvent,
} from "@agent-relay/broker-sdk";

export const QUICK = process.argv.includes("--quick");

export function resolveBinaryPath(): string {
  if (process.env.AGENT_RELAY_BIN) {
    return process.env.AGENT_RELAY_BIN;
  }
  const exe = process.platform === "win32" ? "agent-relay.exe" : "agent-relay";
  const candidates = [
    path.resolve(process.cwd(), "target", "debug", exe),
    path.resolve(process.cwd(), "target", "release", exe),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return exe;
}

export function randomName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function startBroker(): Promise<AgentRelayClient> {
  return AgentRelayClient.start({
    binaryPath: resolveBinaryPath(),
    channels: ["general"],
    env: process.env,
  });
}

export function waitForEvent(
  client: AgentRelayClient,
  kind: string,
  timeoutMs = 15_000,
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
