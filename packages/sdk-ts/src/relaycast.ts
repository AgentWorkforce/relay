import { RelayCast, RelayError, type AgentClient } from "@relaycast/sdk";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export type { AgentClient } from "@relaycast/sdk";

export interface CreateRelaycastClientOptions {
  apiKey?: string;
  baseUrl?: string;
  cachePath?: string;
  agentName?: string;
}

/**
 * Create an authenticated @relaycast/sdk AgentClient.
 * Handles API key resolution (options > env > cache file) and agent registration
 * with 409 conflict retry.
 */
export async function createRelaycastClient(
  options: CreateRelaycastClientOptions = {},
): Promise<AgentClient> {
  const baseUrl = options.baseUrl ?? process.env.RELAYCAST_BASE_URL ?? "https://api.relaycast.dev";
  const cachePath = options.cachePath ?? join(homedir(), ".agent-relay", "relaycast.json");
  const agentName = options.agentName ?? `sdk-${randomBytes(4).toString("hex")}`;

  // Resolve API key
  let apiKey = options.apiKey ?? process.env.RELAY_API_KEY;
  if (!apiKey) {
    const raw = await readFile(cachePath, "utf-8");
    const creds = JSON.parse(raw);
    apiKey = creds.api_key;
  }

  if (!apiKey) {
    throw new Error("Relaycast API key not found in options, RELAY_API_KEY, or cache file");
  }

  const relay = new RelayCast({ apiKey, baseUrl });

  // Register with 409 conflict retry
  let name = agentName;
  let registration;
  try {
    registration = await relay.agents.register({ name, type: "agent" });
  } catch (err) {
    if (err instanceof RelayError && err.code === "agent_already_exists") {
      name = `${agentName}-${randomBytes(4).toString("hex")}`;
      registration = await relay.agents.register({ name, type: "agent" });
    } else {
      throw err;
    }
  }

  return relay.as(registration.token);
}
