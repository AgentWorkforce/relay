import { AgentRelayClient } from "../client.js";

function parseArgs(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") {
    return [];
  }
  return raw
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function now(): string {
  return new Date().toISOString();
}

async function main(): Promise<void> {
  const codexCmd = process.env.CODEX_CMD ?? "codex";
  const codexArgs = parseArgs(process.env.CODEX_ARGS);
  const channel = process.env.RELAY_CHANNEL ?? "general";
  const xName = process.env.AGENT_X_NAME ?? "CodexX";
  const oName = process.env.AGENT_O_NAME ?? "CodexO";

  const client = await AgentRelayClient.start({
    channels: [channel],
  });

  const stopLogging = client.onEvent((event) => {
    console.log(`[${now()}] event`, JSON.stringify(event));
  });
  const stopStderrLogging = client.onBrokerStderr((line) => {
    console.log(`[${now()}] broker:stderr ${line}`);
  });

  const cleanup = async () => {
    console.log(`[${now()}] cleaning up agents + broker`);
    try {
      await client.release(xName);
    } catch {
      // ignore
    }
    try {
      await client.release(oName);
    } catch {
      // ignore
    }
    await client.shutdown();
    stopLogging();
    stopStderrLogging();
  };

  process.on("SIGINT", async () => {
    console.log(`[${now()}] SIGINT received`);
    await cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log(`[${now()}] SIGTERM received`);
    await cleanup();
    process.exit(0);
  });

  console.log(`[${now()}] spawning ${xName} (${codexCmd} ${codexArgs.join(" ")})`);
  await client.spawnPty({
    name: xName,
    cli: codexCmd,
    args: codexArgs,
    channels: [channel],
  });

  console.log(`[${now()}] spawning ${oName} (${codexCmd} ${codexArgs.join(" ")})`);
  await client.spawnPty({
    name: oName,
    cli: codexCmd,
    args: codexArgs,
    channels: [channel],
  });

  console.log(
    `[${now()}] workers spawned. send kickoff via Relaycast (MCP relay_send) and watch events here (Ctrl+C to stop).`,
  );
  await new Promise<void>(() => {
    // keep process alive while events stream
  });
}

main().catch((error) => {
  console.error(`[${now()}] fatal`, error);
  process.exit(1);
});
