/**
 * Multi-Agent Code Review via agent-relay SDK
 *
 * Spawns 3 REAL codex agents, each reviews one repo:
 *   - Rex   → ../relay        (CLI + daemon monorepo)
 *   - Dash  → ../relay-dashboard (Next.js dashboard)
 *   - Skye  → ../relay-cloud  (cloud SaaS backend)
 *
 * Rex is instructed to spawn a 4th agent (Synth) who synthesizes.
 * All agents chat in a shared #code-review channel via Relaycast.
 * Reuses the dashboard UI from packages/sdk-ts/src/examples/dashboard.html
 *
 * Usage:
 *   RELAY_API_KEY=rk_live_... node review.mjs
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRelayClient, RelaycastApi } from "@agent-relay/sdk-ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML = readFileSync(
  resolve(__dirname, "../../packages/sdk-ts/src/examples/dashboard.html"),
  "utf-8",
);

const PORT = parseInt(process.env.DASHBOARD_PORT ?? "3099", 10);
const CHANNEL = "code-review";
const CLI = process.env.CODEX_CMD ?? "codex";
const CLI_ARGS = (process.env.CODEX_ARGS ?? "--full-auto").split(" ").filter(Boolean);
const BASE_URL = process.env.RELAYCAST_BASE_URL ?? "https://api.relaycast.dev";

// ─── PTY stream processor ────────────────────────────────────────────────────

const ANSI_RE = /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[()][0-9A-Za-z]|[\x20-\x2f]*[\x40-\x7e])|\x1b/g;
const ORPHAN_CSI_RE = /\[[?]?[0-9;]*[A-HJKSTfhilmnpsu]/g;

function stripAnsi(s) {
  return s.replace(ANSI_RE, "").replace(ORPHAN_CSI_RE, "");
}

class PtyLineBuffer {
  constructor() { this.current = ""; }
  feed(raw) {
    const stripped = stripAnsi(raw);
    const lines = [];
    for (let i = 0; i < stripped.length; i++) {
      const ch = stripped[i];
      if (ch === "\r") {
        if (i + 1 < stripped.length && stripped[i + 1] === "\n") {
          i++;
          const line = this.current.trimEnd();
          if (line.length > 0) lines.push(line);
          this.current = "";
        } else {
          this.current = "";
        }
      } else if (ch === "\n") {
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

const ptyBuffers = new Map();
function getPtyBuffer(name) {
  let buf = ptyBuffers.get(name);
  if (!buf) { buf = new PtyLineBuffer(); ptyBuffers.set(name, buf); }
  return buf;
}

// ─── Agent task prompts ──────────────────────────────────────────────────────

const RELAY_PATH = "/Users/khaliqgant/Projects/agent-workforce/relay";
const DASHBOARD_PATH = "/Users/khaliqgant/Projects/agent-workforce/relay-dashboard";
const CLOUD_PATH = "/Users/khaliqgant/Projects/agent-workforce/relay-cloud";

const REX_TASK = [
  `You are Rex, a senior engineer doing an honest code review of the relay monorepo at ${RELAY_PATH}.`,
  "This is a TypeScript monorepo with ~20 packages: daemon, SDK, wrapper, bridge, config, storage, etc.",
  "",
  "Instructions:",
  "1. Use the Relaycast MCP tools to communicate. First call set_workspace_key with your RELAY_API_KEY env var, register as an agent named 'Rex', then post messages to the #code-review channel.",
  "2. Explore the codebase: look at the directory structure, package.json, the largest files (cli/index.ts, daemon/server.ts, daemon/router.ts), and key architectural decisions.",
  "3. Post your review to #code-review with sections: Architecture Overview, The Good, The Bad, The Ugly, and a score out of 10.",
  "4. Be HONEST and specific — cite file names, line counts, actual code patterns you find. Don't be generic.",
  "5. After you post your review, read the other agents' reviews (Dash reviews relay-dashboard, Skye reviews relay-cloud) and reply with cross-cutting observations.",
  "6. After cross-discussion, spawn a new agent named 'Synth' by sending a message: 'I'll bring in a synthesizer to pull this together.'",
  "7. Then send Synth a DM explaining they should read all reviews in #code-review and post a synthesis with prioritized recommendations.",
  "",
  "Keep responses concise but substantive. This is a real code review, not a demo.",
].join("\n");

const DASH_TASK = [
  `You are Dash, a frontend specialist doing an honest code review of the relay-dashboard at ${DASHBOARD_PATH}.`,
  "This is a Next.js 14 + Express monorepo with a frontend dashboard and backend server.",
  "",
  "Instructions:",
  "1. Use the Relaycast MCP tools to communicate. First call set_workspace_key with your RELAY_API_KEY env var, register as an agent named 'Dash', then post messages to the #code-review channel.",
  "2. Explore the codebase: look at directory structure, the server.ts (largest file), proxy-server.ts, App.tsx, package.json, and key components.",
  "3. Post your review to #code-review with sections: Architecture Overview, The Good, The Bad, and a score out of 10.",
  "4. Be HONEST — cite file names, line counts, actual patterns. Note the difference between proxy-server.ts (clean) and server.ts (messy).",
  "5. After posting, read Rex's and Skye's reviews and comment on patterns you see across repos.",
  "",
  "Keep responses concise but substantive. This is a real code review.",
].join("\n");

const SKYE_TASK = [
  `You are Skye, a cloud infrastructure engineer doing an honest code review of relay-cloud at ${CLOUD_PATH}.`,
  "This is an Express.js 5 backend with PostgreSQL (Drizzle ORM), Redis, Stripe billing, deployed on Fly.io.",
  "",
  "Instructions:",
  "1. Use the Relaycast MCP tools to communicate. First call set_workspace_key with your RELAY_API_KEY env var, register as an agent named 'Skye', then post messages to the #code-review channel.",
  "2. Explore the codebase: look at the API routes (especially workspaces.ts), database schema, server.ts, provisioner, services directory, and deploy configs.",
  "3. Post your review to #code-review with sections: Architecture Overview, The Good, The Bad, Security Concerns, and a score out of 10.",
  "4. Be HONEST — look for input validation (or lack thereof), check if Zod is actually used, count `any` types, check the health endpoint.",
  "5. After posting, read Rex's and Dash's reviews and comment on patterns you see across repos.",
  "",
  "Keep responses concise but substantive. This is a real code review.",
].join("\n");

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.RELAY_API_KEY;
  if (!apiKey) {
    console.error("RELAY_API_KEY required. Set it in your environment.");
    process.exit(1);
  }

  let eventSeq = 0;
  const eventLog = [];
  const sseClients = new Set();

  function broadcast(evt) {
    eventLog.push(evt);
    if (eventLog.length > 2000) eventLog.splice(0, eventLog.length - 2000);
    const payload = `data: ${JSON.stringify(evt)}\n\n`;
    for (const res of sseClients) {
      res.write(payload);
    }
  }

  function push(source, data) {
    broadcast({ id: ++eventSeq, ts: new Date().toISOString(), source, data });
  }

  push("system", { kind: "system", message: "Starting multi-agent code review..." });

  // Start broker
  const brokerEnv = {
    ...process.env,
    RELAY_API_KEY: apiKey,
    RELAY_BASE_URL: BASE_URL,
  };

  push("system", { kind: "system", message: "Starting broker..." });
  const client = await AgentRelayClient.start({
    channels: [CHANNEL],
    env: brokerEnv,
  });
  push("system", { kind: "system", message: "Broker connected." });

  // Wire events
  client.onEvent((event) => {
    if (event.kind === "worker_stream") {
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

  // Spawn reviewers
  push("system", { kind: "system", message: `Spawning Rex (${CLI} reviewing relay)...` });
  await client.spawnPty({ name: "Rex", cli: CLI, args: [...CLI_ARGS, REX_TASK], channels: [CHANNEL] });

  push("system", { kind: "system", message: `Spawning Dash (${CLI} reviewing relay-dashboard)...` });
  await client.spawnPty({ name: "Dash", cli: CLI, args: [...CLI_ARGS, DASH_TASK], channels: [CHANNEL] });

  push("system", { kind: "system", message: `Spawning Skye (${CLI} reviewing relay-cloud)...` });
  await client.spawnPty({ name: "Skye", cli: CLI, args: [...CLI_ARGS, SKYE_TASK], channels: [CHANNEL] });

  push("system", { kind: "system", message: "All 3 reviewers spawned. Sending kickoff in 8s..." });

  // Kickoff after agents init
  setTimeout(async () => {
    try {
      const relay = new RelaycastApi({ apiKey, baseUrl: BASE_URL });
      await relay.sendToChannel(
        CHANNEL,
        "Review kickoff: Rex is reviewing relay, Dash is reviewing relay-dashboard, Skye is reviewing relay-cloud. " +
          "Each of you: explore your assigned repo, post an honest review to this channel, then discuss. " +
          "Rex: after discussion, spawn a Synth agent to write a final synthesis. Go!"
      );
      push("system", { kind: "system", message: "Kickoff sent to #code-review. Reviews in progress!" });
    } catch (err) {
      push("system", { kind: "system", message: `Kickoff: ${err}. Agents will use MCP to communicate.` });
    }
  }, 8000);

  // ─── HTTP Dashboard ─────────────────────────────────────────────────────────

  const server = createServer((req, res) => {
    const url = req.url ?? "/";

    if (url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.flushHeaders();
      for (const evt of eventLog) {
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
      }
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (url === "/api/agents") {
      client.listAgents()
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

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(DASHBOARD_HTML);
  });

  server.listen(PORT, () => {
    const msg = `Dashboard at http://localhost:${PORT}`;
    console.log(msg);
    push("system", { kind: "system", message: msg });
  });

  // Graceful shutdown
  const cleanup = async () => {
    push("system", { kind: "system", message: "Shutting down..." });
    server.close();
    for (const name of ["Rex", "Dash", "Skye", "Synth"]) {
      try { await client.release(name); } catch { /* may not exist */ }
    }
    await client.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
