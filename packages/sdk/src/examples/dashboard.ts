import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRelayClient } from "../client.js";
import type { BrokerEvent } from "../protocol.js";
import { RelaycastApi } from "../relaycast.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(resolve(__dirname, "dashboard.html"), "utf-8");

const PORT = parseInt(process.env.DASHBOARD_PORT ?? "3099", 10);

// ---------------------------------------------------------------------------
// PTY stream processor: turns raw PTY chunks into clean readable lines.
// Handles ANSI escape stripping, \r (carriage return) overwrites, and
// filters out TUI noise (spinners, progress bars, very short fragments).
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[()][0-9A-Za-z]|[\x20-\x2f]*[\x40-\x7e])|\x1b/g;
const ORPHAN_CSI_RE = /\[[?]?[0-9;]*[A-HJKSTfhilmnpsu]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "").replace(ORPHAN_CSI_RE, "");
}

/** Per-worker line accumulator — simulates a single-line terminal buffer. */
class PtyLineBuffer {
  private current = "";

  /** Feed a raw PTY chunk, get back zero or more complete clean lines. */
  feed(raw: string): string[] {
    const stripped = stripAnsi(raw);
    const lines: string[] = [];
    const len = stripped.length;

    for (let i = 0; i < len; i++) {
      const ch = stripped[i];
      if (ch === "\r") {
        // \r\n = normal line ending — flush the line
        if (i + 1 < len && stripped[i + 1] === "\n") {
          i++; // consume the \n
          const line = this.current.trimEnd();
          if (line.length > 0) lines.push(line);
          this.current = "";
        } else {
          // Standalone \r = carriage return (overwrite from start of line)
          this.current = "";
        }
      } else if (ch === "\n") {
        // Bare \n — flush
        const line = this.current.trimEnd();
        if (line.length > 0) lines.push(line);
        this.current = "";
      } else {
        this.current += ch;
      }
    }
    return lines;
  }
}

const ptyBuffers = new Map<string, PtyLineBuffer>();

function getPtyBuffer(name: string): PtyLineBuffer {
  let buf = ptyBuffers.get(name);
  if (!buf) {
    buf = new PtyLineBuffer();
    ptyBuffers.set(name, buf);
  }
  return buf;
}

function parseArgs(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") return [];
  return raw
    .split(" ")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

interface DashboardEvent {
  id: number;
  ts: string;
  source: "event" | "stderr" | "system";
  data: BrokerEvent | { kind: "broker_stderr"; line: string } | { kind: "system"; message: string };
}

const TASK_X = [
  "You are playing tic-tac-toe as X against another agent on the #general Relaycast channel.",
  "To send moves, use the relaycast MCP tools: first call set_workspace_key with your RELAY_API_KEY env var, then register as an agent, then use post_message or send_dm.",
  "Alternatively, post to the channel with the relaycast MCP send tool.",
  "Format each move as a JSON object: {\"move\": <1-9>, \"board\": \"...\"}",
  "Positions are numbered 1-9 (left-to-right, top-to-bottom).",
  "Always include the full board state as a 9-char string (X, O, or . for empty).",
  "You go first. Send your opening move now.",
  "When the game ends, send a message with {\"result\": \"X wins\" | \"O wins\" | \"draw\"}.",
].join(" ");

const TASK_O = [
  "You are playing tic-tac-toe as O against another agent on the #general Relaycast channel.",
  "To send moves, use the relaycast MCP tools: first call set_workspace_key with your RELAY_API_KEY env var, then register as an agent, then use post_message or send_dm.",
  "Alternatively, post to the channel with the relaycast MCP send tool.",
  "Format each move as a JSON object: {\"move\": <1-9>, \"board\": \"...\"}",
  "Positions are numbered 1-9 (left-to-right, top-to-bottom).",
  "Always include the full board state as a 9-char string (X, O, or . for empty).",
  "Wait for X to move first, then respond with your move.",
  "When the game ends, send a message with {\"result\": \"X wins\" | \"O wins\" | \"draw\"}.",
].join(" ");

async function main(): Promise<void> {
  const codexCmd = process.env.CODEX_CMD ?? "codex";
  // Agents need --full-auto to bypass sandbox and reach the Relaycast API over the network.
  const codexArgs = parseArgs(process.env.CODEX_ARGS ?? "--full-auto");
  const channel = process.env.RELAY_CHANNEL ?? "general";
  const xName = process.env.AGENT_X_NAME ?? "CodexX";
  const oName = process.env.AGENT_O_NAME ?? "CodexO";
  const autoSpawn = process.env.DASHBOARD_NO_SPAWN !== "1";
  const baseUrl = process.env.RELAYCAST_BASE_URL ?? "https://api.relaycast.dev";

  let eventSeq = 0;
  const eventLog: DashboardEvent[] = [];
  const sseClients = new Set<ServerResponse>();

  function broadcast(evt: DashboardEvent): void {
    eventLog.push(evt);
    // Keep last 2000 events in memory
    if (eventLog.length > 2000) eventLog.splice(0, eventLog.length - 2000);
    const payload = `data: ${JSON.stringify(evt)}\n\n`;
    for (const res of sseClients) {
      res.write(payload);
    }
  }

  function push(
    source: DashboardEvent["source"],
    data: DashboardEvent["data"],
  ): void {
    broadcast({ id: ++eventSeq, ts: new Date().toISOString(), source, data });
  }

  // --- Bootstrap a Relaycast workspace ---
  // This creates a fresh workspace so the dashboard is self-contained —
  // no manual credential setup required.
  push("system", { kind: "system", message: "Creating Relaycast workspace..." });

  let apiKey: string;
  if (process.env.RELAY_API_KEY) {
    apiKey = process.env.RELAY_API_KEY;
    push("system", { kind: "system", message: "Using existing RELAY_API_KEY from environment." });
  } else {
    const ws = await RelaycastApi.createWorkspace("dashboard", baseUrl);
    apiKey = ws.apiKey;
    push("system", { kind: "system", message: `Workspace created (${ws.workspaceId}).` });
  }

  // Build env that the broker (and spawned PTY agents) will inherit.
  const brokerEnv: NodeJS.ProcessEnv = {
    ...process.env,
    RELAY_API_KEY: apiKey,
    RELAY_BASE_URL: baseUrl,
  };

  // --- Broker ---
  push("system", { kind: "system", message: "Starting broker..." });

  const client = await AgentRelayClient.start({ channels: [channel], env: brokerEnv });

  push("system", { kind: "system", message: "Broker connected." });

  client.onEvent((event) => {
    if (event.kind === "worker_stream") {
      // Process through PTY line buffer — emits clean, complete lines only
      const buf = getPtyBuffer(event.name);
      const lines = buf.feed(event.chunk);
      for (const line of lines) {
        push("event", { ...event, chunk: line });
      }
      return;
    }
    push("event", event);
  });
  client.onBrokerStderr((line) => push("stderr", { kind: "broker_stderr", line }));

  if (autoSpawn) {
    const xArgs = [...codexArgs, TASK_X];
    const oArgs = [...codexArgs, TASK_O];

    push("system", { kind: "system", message: `Spawning ${xName} (plays X)...` });
    await client.spawnPty({ name: xName, cli: codexCmd, args: xArgs, channels: [channel] });

    push("system", { kind: "system", message: `Spawning ${oName} (plays O)...` });
    await client.spawnPty({ name: oName, cli: codexCmd, args: oArgs, channels: [channel] });

    push("system", { kind: "system", message: "Both agents spawned. Sending kickoff via Relaycast..." });

    // Give agents a moment to finish init, then kick off the game via Relaycast API.
    // Send to the channel (not a DM) because agent names in Relaycast may differ
    // from the broker names (e.g. agents self-register as "codex-x" not "CodexX").
    setTimeout(async () => {
      try {
        const relay = new RelaycastApi({ apiKey, baseUrl });
        const kickoff = `Game start! ${xName} (X) plays first. Send your move as JSON {"move":<1-9>,"board":"..."} to the #${channel} channel. ${oName} (O) responds after each X move.`;
        await relay.sendToChannel(channel, kickoff);
        push("system", { kind: "system", message: `Kickoff sent to #${channel}. Game on!` });
      } catch (err) {
        push("system", {
          kind: "system",
          message: `Kickoff failed (${err}). Send manually via Relaycast MCP: relay_send("${xName}", "start the game").`,
        });
      }
    }, 5000);
  } else {
    push("system", {
      kind: "system",
      message: "Broker running (DASHBOARD_NO_SPAWN=1). Spawn agents via the SDK.",
    });
  }

  // --- HTTP server ---
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";

    if (url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.flushHeaders();
      // Send full history on connect
      for (const evt of eventLog) {
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
      }
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (url === "/api/agents") {
      client
        .listAgents()
        .then((agents) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(agents));
        })
        .catch((err) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        });
      return;
    }

    // Serve dashboard HTML
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
  });

  server.listen(PORT, () => {
    const msg = `Dashboard running at http://localhost:${PORT}`;
    console.log(msg);
    push("system", { kind: "system", message: msg });
  });

  // --- Graceful shutdown ---
  const cleanup = async () => {
    push("system", { kind: "system", message: "Shutting down..." });
    server.close();
    try { await client.release(xName); } catch { /* */ }
    try { await client.release(oName); } catch { /* */ }
    await client.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
