#!/usr/bin/env node

import { AgentRelayClient } from "@agent-relay/sdk";

function usage() {
  console.error(
    "Usage: node scripts/e2e-sdk-lifecycle.mjs --name <agent> --cli <cli> --task <text> [--timeout <seconds>] [--cwd <path>]"
  );
}

function parseArgs(argv) {
  const out = {
    name: "",
    cli: "claude",
    task: "",
    timeout: 120,
    cwd: process.cwd(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--name" && next) {
      out.name = next;
      i += 1;
      continue;
    }
    if (arg === "--cli" && next) {
      out.cli = next;
      i += 1;
      continue;
    }
    if (arg === "--task" && next) {
      out.task = next;
      i += 1;
      continue;
    }
    if (arg === "--timeout" && next) {
      const parsed = Number.parseInt(next, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        out.timeout = parsed;
      }
      i += 1;
      continue;
    }
    if (arg === "--cwd" && next) {
      out.cwd = next;
      i += 1;
      continue;
    }
  }

  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isUserAgent(agent) {
  const name = agent?.name ?? "";
  if (!name) return false;
  if (name === "Dashboard" || name === "zed-bridge") return false;
  if (name.startsWith("__")) return false;
  return true;
}

function userAgents(agents) {
  return agents.filter(isUserAgent);
}

function timestamp() {
  return new Date().toISOString();
}

async function pollUntil(timeoutSecs, fn) {
  const deadline = Date.now() + timeoutSecs * 1000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result.done) {
      return result.value;
    }
    await sleep(2000);
  }
  return undefined;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.name || !args.task) {
    usage();
    process.exit(1);
  }

  console.log(`[sdk] ${timestamp()} Starting SDK lifecycle test`);
  console.log(`[sdk] agent=${args.name} cli=${args.cli} timeout=${args.timeout}s cwd=${args.cwd}`);

  const client = await AgentRelayClient.start({
    cwd: args.cwd,
    requestTimeoutMs: 30_000,
  });

  try {
    const before = await client.listAgents();
    const beforeUsers = userAgents(before);
    console.log(`[sdk] user agents before spawn: ${beforeUsers.length}`);
    if (beforeUsers.length !== 0) {
      throw new Error(`Expected 0 user agents before spawn, got ${beforeUsers.length}`);
    }

    await client.spawnPty({
      name: args.name,
      cli: args.cli,
      channels: ["general"],
      task: args.task,
      cwd: args.cwd,
    });
    console.log(`[sdk] spawn request accepted for ${args.name}`);

    const seenAfterSpawn = await pollUntil(args.timeout, async () => {
      const agents = await client.listAgents();
      const names = agents.map((agent) => agent.name).join(", ");
      console.log(`[sdk] polling registration: [${names}]`);
      const found = agents.some((agent) => agent.name === args.name);
      if (!found) return { done: false };
      return { done: true, value: agents };
    });

    if (!seenAfterSpawn) {
      throw new Error(`Agent '${args.name}' did not register within ${args.timeout}s`);
    }

    const usersAfterSpawn = userAgents(seenAfterSpawn);
    console.log(`[sdk] user agents after spawn: ${usersAfterSpawn.length}`);
    if (usersAfterSpawn.length !== 1) {
      throw new Error(`Expected 1 user agent after spawn, got ${usersAfterSpawn.length}`);
    }

    await client.release(args.name, "released via sdk e2e lifecycle");
    console.log(`[sdk] release request accepted for ${args.name}`);

    const seenAfterRelease = await pollUntil(30, async () => {
      const agents = await client.listAgents();
      const names = agents.map((agent) => agent.name).join(", ");
      console.log(`[sdk] polling release: [${names}]`);
      const found = agents.some((agent) => agent.name === args.name);
      if (found) return { done: false };
      return { done: true, value: agents };
    });

    if (!seenAfterRelease) {
      throw new Error(`Agent '${args.name}' still present 30s after release`);
    }

    const usersAfterRelease = userAgents(seenAfterRelease);
    console.log(`[sdk] user agents after release: ${usersAfterRelease.length}`);
    if (usersAfterRelease.length !== 0) {
      throw new Error(`Expected 0 user agents after release, got ${usersAfterRelease.length}`);
    }

    console.log(`[sdk] ${timestamp()} SDK lifecycle test passed`);
  } finally {
    await client.shutdown().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(`[sdk] lifecycle test failed: ${error?.message ?? String(error)}`);
  process.exit(1);
});
