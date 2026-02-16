import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";

import {
  AgentRelayClient,
  type BrokerEvent,
} from "@agent-relay/broker-sdk";

const DEFAULT_CHANNEL = "general";
const TIMEOUT_MS = 30_000;

function resolveBinaryPath(): string {
  if (process.env.AGENT_RELAY_BIN) {
    return process.env.AGENT_RELAY_BIN;
  }

  const exe = process.platform === "win32" ? "agent-relay.exe" : "agent-relay";
  const candidates = [
    path.resolve(process.cwd(), "target", "debug", exe),
    path.resolve(process.cwd(), "target", "release", exe),
    path.resolve(process.cwd(), "packages", "sdk-ts", "bin", exe),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return exe;
}

function waitForMessageDelivery(
  client: AgentRelayClient,
  target: string,
  timeoutMs = TIMEOUT_MS,
): Promise<BrokerEvent> {
  return new Promise<BrokerEvent>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for relay_inbound delivery to ${target}`));
    }, timeoutMs);

    let unsubscribe: () => void = () => {};
    unsubscribe = client.onEvent((event) => {
      if (
        event.kind === "relay_inbound" &&
        event.target === target
      ) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(event);
      }
    });
  });
}

function randomName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

async function main(): Promise<void> {
  const binaryPath = resolveBinaryPath();

  const client = await AgentRelayClient.start({
    binaryPath,
    channels: [DEFAULT_CHANNEL],
    env: process.env,
  });

  const startedAt = performance.now();
  const receiver = randomName("bench-recv");

  try {
    await client.spawnPty({
      name: receiver,
      cli: "cat",
      channels: [DEFAULT_CHANNEL],
    });

    const deliveryPromise = waitForMessageDelivery(client, receiver);
    const sendResult = await client.sendMessage({
      to: receiver,
      from: "benchmark-producer",
      text: "cold start benchmark message",
    });

    if (sendResult.event_id === "unsupported_operation") {
      throw new Error("send_message is unsupported by this broker build");
    }

    await deliveryPromise;
    const elapsedMs = performance.now() - startedAt;

    console.log(`cold-start-to-first-delivery: ${elapsedMs.toFixed(2)} ms`);
    console.log(`message event id: ${sendResult.event_id}`);
    console.log(`receiver: ${receiver}`);
    console.log(`broker binary: ${binaryPath}`);
    console.log("DONE");
  } finally {
    try {
      await client.release(receiver);
    } catch {
      // ignore release failures in benchmark cleanup
    }
    await client.shutdown();
  }
}

main().catch((error) => {
  console.error("benchmark failed:", error);
  process.exit(1);
});
