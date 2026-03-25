/**
 * Lightweight HTTP client for Relaycast API — safe for bundlers (Vite, Rollup, Webpack).
 * No native dependencies, no broker binary, no process spawning.
 *
 * Usage:
 *   import { RelayCast, createWorkspace, registerAgent } from '@agent-relay/sdk/http';
 */

// Re-export the HTTP-safe parts of @relaycast/sdk
export { RelayCast, RelayError } from '@relaycast/sdk';
export type { RelayCastOptions, CreateWorkspaceResponse } from '@relaycast/sdk';

// Re-export useful protocol types from the SDK
export type { AgentSpec, AgentRuntime } from './protocol.js';

const DEFAULT_BASE_URL = 'https://api.relaycast.dev';

interface CreateWorkspaceResult {
  workspace_id: string;
  api_key: string;
}

interface RegisterAgentResult {
  name: string;
  token: string;
}

/**
 * Create a new Relaycast workspace using plain fetch.
 * This function has zero dependencies beyond the Fetch API.
 *
 * @param name - Human-readable workspace name
 * @param baseUrl - API base URL (defaults to https://api.relaycast.dev)
 * @returns The workspace ID and API key
 */
export async function createWorkspace(
  name: string,
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<CreateWorkspaceResult> {
  const url = `${baseUrl}/v1/workspaces`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Failed to create workspace (HTTP ${response.status}): ${body}`,
    );
  }

  const body = (await response.json()) as
    | CreateWorkspaceResult
    | { ok: boolean; data: CreateWorkspaceResult };
  // The API wraps responses in { ok, data } — unwrap transparently
  return 'data' in body && body.data ? body.data : body as CreateWorkspaceResult;
}

/**
 * Register an agent in a workspace using plain fetch.
 * This function has zero dependencies beyond the Fetch API.
 *
 * @param apiKey - Workspace API key
 * @param name - Agent name to register
 * @param baseUrl - API base URL (defaults to https://api.relaycast.dev)
 * @returns The registered agent name and token
 */
export async function registerAgent(
  apiKey: string,
  name: string,
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<RegisterAgentResult> {
  const url = `${baseUrl}/v1/agents`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ name }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(
      `Failed to register agent (HTTP ${response.status}): ${errBody}`,
    );
  }

  const body = (await response.json()) as
    | RegisterAgentResult
    | { ok: boolean; data: RegisterAgentResult };
  return 'data' in body && body.data ? body.data : body as RegisterAgentResult;
}
