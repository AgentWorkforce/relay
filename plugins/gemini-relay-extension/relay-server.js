#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startStdio } from "@relaycast/mcp/dist/transports.js";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(EXTENSION_DIR, ".env");
const RELAY_DIR = path.join(os.homedir(), ".relay");
const TOKEN_FILE = path.join(RELAY_DIR, "token");
const STATE_FILE = path.join(RELAY_DIR, "gemini-session.json");
const DEFAULT_BASE_URL = "https://www.relaycast.dev/api";

loadDotEnv(ENV_FILE);
fs.mkdirSync(RELAY_DIR, { recursive: true });

const workspaceKey = readEnv("RELAY_API_KEY");
const baseUrl = readEnv("RELAY_BASE_URL") || DEFAULT_BASE_URL;
const configuredName = readEnv("RELAY_AGENT_NAME");
const persisted = readStateFile();
const initialName = configuredName || persisted.agentName || deriveAgentName();
let agentName = initialName;
let agentToken = readEnv("RELAY_AGENT_TOKEN") || readTokenFile();

if (workspaceKey && agentName) {
  try {
    const registration = await registerAgent(workspaceKey, agentName);
    agentName = registration.name || agentName;
    agentToken = registration.token || agentToken;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[agent-relay] Gemini bootstrap register failed: ${message}\n`);
  }
}

if (workspaceKey) {
  process.env.RELAY_API_KEY = workspaceKey;
}
process.env.RELAY_BASE_URL = baseUrl;
process.env.RELAY_AGENT_NAME = agentName;
process.env.RELAY_AGENT_TYPE = readEnv("RELAY_AGENT_TYPE") || "agent";
process.env.RELAY_STRICT_AGENT_NAME = readEnv("RELAY_STRICT_AGENT_NAME") || "1";

if (agentToken) {
  process.env.RELAY_AGENT_TOKEN = agentToken;
  fs.writeFileSync(TOKEN_FILE, `${agentToken}\n`, "utf8");
}

writeStateFile({
  agentName,
  baseUrl,
  workspaceConfigured: Boolean(workspaceKey),
  updatedAt: new Date().toISOString(),
});

await startStdio({
  apiKey: workspaceKey,
  baseUrl,
  agentName,
  agentToken,
  agentType: "agent",
  strictAgentName: true,
});

function readEnv(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    if (!key || process.env[key]) {
      continue;
    }

    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function readTokenFile() {
  try {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

function readStateFile() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function writeStateFile(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function deriveAgentName() {
  const user = sanitize(process.env.USER || process.env.USERNAME || "gemini");
  const host = sanitize(os.hostname().split(".")[0] || "local");
  const suffix = Date.now().toString(36).slice(-6);
  return `gemini-${user}-${host}-${suffix}`.slice(0, 64);
}

function sanitize(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

async function registerAgent(workspace, name) {
  const registerUrl = baseUrl + "/v1/register";
  const response = await fetch(registerUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      workspace,
      name,
      cli: "gemini",
      type: "agent",
    }),
  });

  const payload = await response.json().catch(() => ({}));
  const token = payload?.token || payload?.data?.token || "";
  const resolvedName = payload?.name || payload?.data?.name || name;

  if (!response.ok || !token) {
    throw new Error(
      payload?.error?.message ||
        payload?.message ||
        `register request failed with status ${response.status}`
    );
  }

  return {
    name: resolvedName,
    token,
  };
}
