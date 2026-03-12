import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { RelayCast } from '@relaycast/sdk';

import type { GatewayConfig, WorkspacesConfig } from './types.js';
import { buildWorkspacesJson } from './config.js';

export interface McporterCommand {
  cmd: string;
  prefix: string[];
}

export interface AgentRegistration {
  agentToken?: string;
  workspaceId?: string;
}

export interface SyncMcporterServersOptions {
  gatewayConfig: GatewayConfig;
  workspacesConfig: WorkspacesConfig | null;
  agentToken?: string;
}

export interface SyncMcporterServersResult {
  configured: boolean;
  agentToken?: string;
  tokenAction: 'provided' | 'preserved' | 'cleared' | 'none';
}

function mcporterConfigPath(): string {
  return join(homedir(), '.mcporter', 'mcporter.json');
}

function createRelaycastClient(
  gatewayConfig: Pick<GatewayConfig, 'apiKey' | 'baseUrl'>
): RelayCast {
  return new RelayCast({
    apiKey: gatewayConfig.apiKey,
    baseUrl: gatewayConfig.baseUrl,
  });
}

function extractNestedString(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current.trim() ? current : undefined;
}

async function resolveWorkspaceIdFromClient(relaycast: RelayCast): Promise<string | undefined> {
  const workspace = (await relaycast.workspace.info()) as Record<string, unknown>;
  return (
    extractNestedString(workspace, ['id']) ??
    extractNestedString(workspace, ['workspaceId']) ??
    extractNestedString(workspace, ['workspace_id'])
  );
}

async function loadMcporterServerEnv(serverName: string): Promise<Record<string, string>> {
  const configPath = mcporterConfigPath();
  if (!existsSync(configPath)) return {};

  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const env = ((parsed.mcpServers as Record<string, unknown> | undefined)?.[serverName] as
      | { env?: Record<string, unknown> }
      | undefined)?.env;
    if (!env || typeof env !== 'object') return {};

    return Object.fromEntries(
      Object.entries(env).filter(([, value]) => typeof value === 'string')
    ) as Record<string, string>;
  } catch (err) {
    console.warn(
      `[mcporter] Failed to read ${serverName} env from ${configPath}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return {};
  }
}

function buildRelaycastEnv(
  gatewayConfig: GatewayConfig,
  workspacesConfig: WorkspacesConfig | null,
  agentToken?: string
): Record<string, string> {
  const env: Record<string, string> = {
    RELAY_API_KEY: gatewayConfig.apiKey,
  };

  if (gatewayConfig.baseUrl !== 'https://api.relaycast.dev') {
    env.RELAY_BASE_URL = gatewayConfig.baseUrl;
  }

  const workspacesJson = workspacesConfig ? buildWorkspacesJson(workspacesConfig) : null;
  if (workspacesJson) {
    env.RELAY_WORKSPACES_JSON = workspacesJson;
  }
  if (workspacesConfig?.default_workspace_id) {
    env.RELAY_DEFAULT_WORKSPACE = workspacesConfig.default_workspace_id;
  }
  if (agentToken) {
    env.RELAY_AGENT_TOKEN = agentToken;
  }

  return env;
}

function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
}

function removeServer(mcp: McporterCommand, name: string): void {
  try {
    execFileSync(mcp.cmd, [...mcp.prefix, 'config', 'remove', name], { stdio: 'pipe' });
  } catch {
    // Missing entries are expected on first run.
  }
}

function addServer(
  mcp: McporterCommand,
  name: string,
  command: string,
  args: string[],
  env: Record<string, string>,
  description: string
): void {
  execFileSync(
    mcp.cmd,
    [
      ...mcp.prefix,
      'config',
      'add',
      name,
      '--command',
      command,
      ...args.flatMap((arg) => ['--arg', arg]),
      ...envArgs(env),
      '--scope',
      'home',
      '--description',
      description,
    ],
    { stdio: 'pipe' }
  );
}

/**
 * Resolve how to invoke mcporter. Prefers a global binary, falls back to npx.
 */
export function resolveMcporter(): McporterCommand {
  try {
    execFileSync('mcporter', ['--version'], { stdio: 'pipe' });
    return { cmd: 'mcporter', prefix: [] };
  } catch {
    try {
      execFileSync('npx', ['-y', 'mcporter', '--version'], { stdio: 'pipe' });
      return { cmd: 'npx', prefix: ['-y', 'mcporter'] };
    } catch {
      throw new Error('mcporter not found (tried global binary and npx)');
    }
  }
}

export async function registerRelaycastAgent(
  gatewayConfig: Pick<GatewayConfig, 'apiKey' | 'baseUrl' | 'clawName'>
): Promise<AgentRegistration> {
  const relaycast = createRelaycastClient(gatewayConfig);
  const registered = (await relaycast.agents.registerOrGet({
    name: gatewayConfig.clawName,
    type: 'agent',
  })) as Record<string, unknown>;
  const workspaceId =
    extractNestedString(registered, ['workspaceId']) ??
    extractNestedString(registered, ['workspace_id']) ??
    extractNestedString(registered, ['workspace', 'id']) ??
    extractNestedString(registered, ['data', 'workspaceId']) ??
    extractNestedString(registered, ['data', 'workspace_id']) ??
    extractNestedString(registered, ['data', 'workspace', 'id']) ??
    await resolveWorkspaceIdFromClient(relaycast);

  return {
    agentToken:
      extractNestedString(registered, ['token']) ??
      extractNestedString(registered, ['data', 'token']),
    workspaceId,
  };
}

export async function resolveRelaycastWorkspaceId(
  gatewayConfig: Pick<GatewayConfig, 'apiKey' | 'baseUrl' | 'clawName'>
): Promise<string | undefined> {
  const relaycast = createRelaycastClient(gatewayConfig);
  return resolveWorkspaceIdFromClient(relaycast);
}

export async function syncMcporterServers(
  options: SyncMcporterServersOptions
): Promise<SyncMcporterServersResult> {
  const existingRelaycastEnv = await loadMcporterServerEnv('relaycast');
  const existingApiKey = existingRelaycastEnv.RELAY_API_KEY?.trim();
  const existingAgentToken = existingRelaycastEnv.RELAY_AGENT_TOKEN?.trim();

  let agentToken = options.agentToken?.trim() || undefined;
  let tokenAction: SyncMcporterServersResult['tokenAction'] = 'none';

  if (agentToken) {
    tokenAction = 'provided';
  } else if (existingAgentToken && existingApiKey === options.gatewayConfig.apiKey) {
    agentToken = existingAgentToken;
    tokenAction = 'preserved';
  } else if (existingAgentToken) {
    tokenAction = 'cleared';
  }

  let mcp: McporterCommand;
  try {
    mcp = resolveMcporter();
  } catch {
    return { configured: false, tokenAction, agentToken };
  }

  const relaycastEnv = buildRelaycastEnv(options.gatewayConfig, options.workspacesConfig, agentToken);
  const spawnerEnv = buildRelaycastEnv(options.gatewayConfig, options.workspacesConfig);

  try {
    removeServer(mcp, 'relaycast');
    addServer(
      mcp,
      'relaycast',
      'npx',
      ['@relaycast/mcp'],
      relaycastEnv,
      'Relaycast messaging MCP server'
    );

    removeServer(mcp, 'openclaw-spawner');
    addServer(
      mcp,
      'openclaw-spawner',
      'npx',
      ['@agent-relay/openclaw', 'mcp-server'],
      spawnerEnv,
      'OpenClaw spawner MCP server'
    );
  } catch (err) {
    console.warn(
      `mcporter configuration failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return { configured: false, tokenAction, agentToken };
  }

  return { configured: true, tokenAction, agentToken };
}
