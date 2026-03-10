import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';

import type { GatewayConfig, WorkspaceEntry, WorkspacesConfig } from './types.js';

function envValue(vars: Record<string, string>, key: string): string | undefined {
  const processValue = process.env[key]?.trim();
  if (processValue) return processValue;
  const fileValue = vars[key]?.trim();
  return fileValue ? fileValue : undefined;
}

function parseBooleanEnv(vars: Record<string, string>, key: string): boolean | undefined {
  const value = envValue(vars, key);
  if (!value) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false;
  return undefined;
}

function parseNumberEnv(vars: Record<string, string>, key: string): number | undefined {
  const value = envValue(vars, key);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface OpenClawDetection {
  /** Whether OpenClaw is installed. */
  installed: boolean;
  /** Path to ~/.openclaw/ (or ~/.clawdbot/ for Clawdbot variant) */
  homeDir: string;
  /** Path to ~/.openclaw/workspace/ */
  workspaceDir: string;
  /** Path to openclaw.json config (if found). */
  configFile: string | null;
  /** Parsed openclaw.json (if exists). */
  config: Record<string, unknown> | null;
  /** Detected variant: 'clawdbot' or 'openclaw'. */
  variant: 'clawdbot' | 'openclaw';
  /** Config filename (e.g. 'clawdbot.json' or 'openclaw.json'). */
  configFilename: string;
}

/**
 * Determine whether a directory has a valid, parseable config file.
 * Uses sync I/O — only called during startup, not on hot path.
 */
function hasValidConfig(dir: string, filename: string): boolean {
  const configPath = join(dir, filename);
  if (!existsSync(configPath)) return false;
  try {
    const raw = readFileSync(configPath, 'utf-8');
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

/** Default OpenClaw config directory. Checks env vars and probes for Clawdbot variant. */
export function openclawHome(): string {
  if (process.env.OPENCLAW_CONFIG_PATH) {
    // Direct config file path — return its parent directory
    return dirname(process.env.OPENCLAW_CONFIG_PATH);
  }
  if (process.env.OPENCLAW_HOME) {
    return process.env.OPENCLAW_HOME;
  }
  // Probe by valid config file presence (not just directory existence).
  // When both dirs exist, prefer the one with a valid config file.
  const clawdbotHome = join(homedir(), '.clawdbot');
  const openclawHomePath = join(homedir(), '.openclaw');
  const clawdbotValid = hasValidConfig(clawdbotHome, 'clawdbot.json');
  const openclawValid = hasValidConfig(openclawHomePath, 'openclaw.json');

  if (clawdbotValid && !openclawValid) return clawdbotHome;
  if (openclawValid && !clawdbotValid) return openclawHomePath;
  // Both valid or neither valid — prefer clawdbot if its dir exists (marketplace image)
  if (existsSync(clawdbotHome)) return clawdbotHome;
  return openclawHomePath;
}

/** Return the config filename for the resolved OpenClaw home (clawdbot.json or openclaw.json). */
export function openclawConfigFilename(home?: string): string {
  const dir = home ?? openclawHome();
  if (hasValidConfig(dir, 'clawdbot.json')) return 'clawdbot.json';
  if (hasValidConfig(dir, 'openclaw.json')) return 'openclaw.json';
  // No existing config — infer from directory name
  return dir.endsWith('.clawdbot') ? 'clawdbot.json' : 'openclaw.json';
}

/**
 * Detect whether OpenClaw is installed and return paths/config.
 */
export async function detectOpenClaw(): Promise<OpenClawDetection> {
  // Determine variant and config filename
  let homeDir: string;
  let variant: 'clawdbot' | 'openclaw';
  let configFilename: string;

  if (process.env.OPENCLAW_CONFIG_PATH) {
    // Direct config file path provided
    homeDir = dirname(process.env.OPENCLAW_CONFIG_PATH);
    const base = basename(process.env.OPENCLAW_CONFIG_PATH);
    configFilename = base;
    variant = base === 'clawdbot.json' ? 'clawdbot' : 'openclaw';
  } else if (process.env.OPENCLAW_HOME) {
    homeDir = process.env.OPENCLAW_HOME;
    // Check if the home dir looks like a Clawdbot installation
    const clawdbotConfig = join(homeDir, 'clawdbot.json');
    if (existsSync(clawdbotConfig)) {
      variant = 'clawdbot';
      configFilename = 'clawdbot.json';
    } else {
      variant = 'openclaw';
      configFilename = 'openclaw.json';
    }
  } else {
    // Probe by valid config file, not just directory existence.
    const clawdbotHome = join(homedir(), '.clawdbot');
    const openclawHomePath = join(homedir(), '.openclaw');
    const clawdbotValid = hasValidConfig(clawdbotHome, 'clawdbot.json');
    const openclawValid = hasValidConfig(openclawHomePath, 'openclaw.json');

    if (clawdbotValid && !openclawValid) {
      homeDir = clawdbotHome;
      variant = 'clawdbot';
      configFilename = 'clawdbot.json';
    } else if (openclawValid && !clawdbotValid) {
      homeDir = openclawHomePath;
      variant = 'openclaw';
      configFilename = 'openclaw.json';
    } else if (existsSync(clawdbotHome)) {
      // Both valid or neither — prefer clawdbot if present (marketplace image)
      homeDir = clawdbotHome;
      variant = 'clawdbot';
      configFilename = 'clawdbot.json';
    } else {
      homeDir = openclawHomePath;
      variant = 'openclaw';
      configFilename = 'openclaw.json';
    }
  }

  const configPath = join(homeDir, configFilename);
  const workspaceDir = join(homeDir, 'workspace');

  const installed = existsSync(homeDir);
  let config: Record<string, unknown> | null = null;
  let configFile: string | null = null;

  if (existsSync(configPath)) {
    configFile = configPath;
    try {
      const raw = await readFile(configPath, 'utf-8');
      config = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Config exists but isn't valid JSON — that's fine
    }
  }

  return { installed, homeDir, workspaceDir, configFile, config, variant, configFilename };
}

/**
 * Load the gateway config from ~/.openclaw/workspace/relaycast/.env.
 * Returns null if the file doesn't exist or can't be parsed.
 */
// eslint-disable-next-line complexity
export async function loadGatewayConfig(): Promise<GatewayConfig | null> {
  const detection = await detectOpenClaw();
  const envPath = join(detection.workspaceDir, 'relaycast', '.env');

  if (!existsSync(envPath)) {
    return null;
  }

  try {
    const raw = await readFile(envPath, 'utf-8');
    const vars: Record<string, string> = {};

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      let value = trimmed.slice(eqIdx + 1);
      // Strip surrounding quotes (single or double) that are common in .env files
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      vars[trimmed.slice(0, eqIdx)] = value;
    }

    const apiKey = envValue(vars, 'RELAY_API_KEY');
    const clawName = envValue(vars, 'RELAY_CLAW_NAME');
    const relayChannels = envValue(vars, 'RELAY_CHANNELS');

    if (!apiKey || !clawName) {
      return null;
    }

    const port = parseNumberEnv(vars, 'OPENCLAW_GATEWAY_PORT');
    const pollFallbackEnabled = parseBooleanEnv(vars, 'RELAY_TRANSPORT_POLL_FALLBACK_ENABLED');
    const pollFallbackProbeWsEnabled = parseBooleanEnv(
      vars,
      'RELAY_TRANSPORT_POLL_FALLBACK_PROBE_WS_ENABLED'
    );
    const pollFallbackWsFailureThreshold = parseNumberEnv(
      vars,
      'RELAY_TRANSPORT_POLL_FALLBACK_WS_FAILURE_THRESHOLD'
    );
    const pollFallbackTimeoutSeconds = parseNumberEnv(vars, 'RELAY_TRANSPORT_POLL_FALLBACK_TIMEOUT_SECONDS');
    const pollFallbackLimit = parseNumberEnv(vars, 'RELAY_TRANSPORT_POLL_FALLBACK_LIMIT');
    const pollFallbackProbeWsIntervalMs = parseNumberEnv(
      vars,
      'RELAY_TRANSPORT_POLL_FALLBACK_PROBE_WS_INTERVAL_MS'
    );
    const pollFallbackProbeWsStableGraceMs = parseNumberEnv(
      vars,
      'RELAY_TRANSPORT_POLL_FALLBACK_PROBE_WS_STABLE_GRACE_MS'
    );
    const pollFallbackInitialCursor = envValue(vars, 'RELAY_TRANSPORT_POLL_FALLBACK_INITIAL_CURSOR');

    const transport =
      pollFallbackEnabled !== undefined ||
      pollFallbackProbeWsEnabled !== undefined ||
      pollFallbackWsFailureThreshold !== undefined ||
      pollFallbackTimeoutSeconds !== undefined ||
      pollFallbackLimit !== undefined ||
      pollFallbackProbeWsIntervalMs !== undefined ||
      pollFallbackProbeWsStableGraceMs !== undefined ||
      pollFallbackInitialCursor !== undefined
        ? {
            pollFallback: {
              enabled: pollFallbackEnabled,
              wsFailureThreshold: pollFallbackWsFailureThreshold,
              timeoutSeconds: pollFallbackTimeoutSeconds,
              limit: pollFallbackLimit,
              initialCursor: pollFallbackInitialCursor,
              probeWs: {
                enabled: pollFallbackProbeWsEnabled,
                intervalMs: pollFallbackProbeWsIntervalMs,
                stableGraceMs: pollFallbackProbeWsStableGraceMs,
              },
            },
          }
        : undefined;

    return {
      apiKey,
      clawName,
      baseUrl: envValue(vars, 'RELAY_BASE_URL') || 'https://api.relaycast.dev',
      channels: relayChannels ? relayChannels.split(',').map((c) => c.trim()) : ['general'],
      openclawGatewayToken: envValue(vars, 'OPENCLAW_GATEWAY_TOKEN'),
      openclawGatewayPort: Number.isFinite(port) ? port : undefined,
      transport,
    };
  } catch {
    return null;
  }
}

/**
 * Save gateway config to ~/.openclaw/workspace/relaycast/.env.
 */
export async function saveGatewayConfig(config: GatewayConfig): Promise<void> {
  const detection = await detectOpenClaw();
  const relaycastDir = join(detection.workspaceDir, 'relaycast');

  await mkdir(relaycastDir, { recursive: true });

  const lines = [
    '# Relaycast configuration for this OpenClaw skill',
    `RELAY_API_KEY=${config.apiKey}`,
    `RELAY_CLAW_NAME=${config.clawName}`,
    `RELAY_BASE_URL=${config.baseUrl}`,
    `RELAY_CHANNELS=${config.channels.join(',')}`,
  ];

  if (config.openclawGatewayToken) {
    lines.push(`OPENCLAW_GATEWAY_TOKEN=${config.openclawGatewayToken}`);
    const masked =
      config.openclawGatewayToken.length > 12 ? config.openclawGatewayToken.slice(0, 8) + '...' : '***';
    console.log(`[config] Persisting OPENCLAW_GATEWAY_TOKEN (${masked})`);
  }
  if (config.openclawGatewayPort) {
    lines.push(`OPENCLAW_GATEWAY_PORT=${config.openclawGatewayPort}`);
  }
  if (config.transport?.pollFallback?.enabled !== undefined) {
    lines.push(`RELAY_TRANSPORT_POLL_FALLBACK_ENABLED=${config.transport.pollFallback.enabled}`);
  }
  if (config.transport?.pollFallback?.wsFailureThreshold !== undefined) {
    lines.push(
      `RELAY_TRANSPORT_POLL_FALLBACK_WS_FAILURE_THRESHOLD=${config.transport.pollFallback.wsFailureThreshold}`
    );
  }
  if (config.transport?.pollFallback?.timeoutSeconds !== undefined) {
    lines.push(
      `RELAY_TRANSPORT_POLL_FALLBACK_TIMEOUT_SECONDS=${config.transport.pollFallback.timeoutSeconds}`
    );
  }
  if (config.transport?.pollFallback?.limit !== undefined) {
    lines.push(`RELAY_TRANSPORT_POLL_FALLBACK_LIMIT=${config.transport.pollFallback.limit}`);
  }
  if (config.transport?.pollFallback?.initialCursor) {
    lines.push(`RELAY_TRANSPORT_POLL_FALLBACK_INITIAL_CURSOR=${config.transport.pollFallback.initialCursor}`);
  }
  if (config.transport?.pollFallback?.probeWs?.enabled !== undefined) {
    lines.push(
      `RELAY_TRANSPORT_POLL_FALLBACK_PROBE_WS_ENABLED=${config.transport.pollFallback.probeWs.enabled}`
    );
  }
  if (config.transport?.pollFallback?.probeWs?.intervalMs !== undefined) {
    lines.push(
      `RELAY_TRANSPORT_POLL_FALLBACK_PROBE_WS_INTERVAL_MS=${config.transport.pollFallback.probeWs.intervalMs}`
    );
  }
  if (config.transport?.pollFallback?.probeWs?.stableGraceMs !== undefined) {
    lines.push(
      `RELAY_TRANSPORT_POLL_FALLBACK_PROBE_WS_STABLE_GRACE_MS=${config.transport.pollFallback.probeWs.stableGraceMs}`
    );
  }

  lines.push('');
  const env = lines.join('\n');

  await writeFile(join(relaycastDir, '.env'), env, 'utf-8');
}

// ---------------------------------------------------------------------------
// Multi-workspace config: ~/.openclaw/workspace/relaycast/workspaces.json
// ---------------------------------------------------------------------------

/**
 * Path to the workspaces.json file.
 */
async function workspacesConfigPath(): Promise<string> {
  const detection = await detectOpenClaw();
  return join(detection.workspaceDir, 'relaycast', 'workspaces.json');
}

/**
 * Load multi-workspace config. Returns null if the file doesn't exist.
 */
export async function loadWorkspacesConfig(): Promise<WorkspacesConfig | null> {
  const configPath = await workspacesConfigPath();
  if (!existsSync(configPath)) return null;

  try {
    const raw = await readFile(configPath, 'utf-8');
    return JSON.parse(raw) as WorkspacesConfig;
  } catch {
    return null;
  }
}

/**
 * Save multi-workspace config to disk.
 */
export async function saveWorkspacesConfig(config: WorkspacesConfig): Promise<void> {
  const configPath = await workspacesConfigPath();
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Add a workspace entry. If an entry with the same api_key already exists,
 * it is updated in place. The first workspace added becomes the default.
 */
export async function addWorkspace(entry: WorkspaceEntry): Promise<WorkspacesConfig> {
  let config = await loadWorkspacesConfig();

  if (!config) {
    // Bootstrap from existing single-workspace .env if available
    const gateway = await loadGatewayConfig();
    if (gateway) {
      config = {
        workspaces: [{
          api_key: gateway.apiKey,
          workspace_alias: gateway.clawName,
          is_default: true,
        }],
        default_workspace: gateway.clawName,
      };
    } else {
      config = { workspaces: [], default_workspace: undefined };
    }
  }

  // Check for existing entry with same api_key
  const existingIdx = config.workspaces.findIndex((w) => w.api_key === entry.api_key);
  if (existingIdx >= 0) {
    config.workspaces[existingIdx] = { ...config.workspaces[existingIdx], ...entry };
  } else {
    config.workspaces.push(entry);
  }

  // If this is the first workspace or explicitly default, set it as default
  if (entry.is_default || config.workspaces.length === 1) {
    config.default_workspace = entry.workspace_alias ?? entry.workspace_id;
    for (const w of config.workspaces) {
      w.is_default = w.api_key === entry.api_key;
    }
  }

  await saveWorkspacesConfig(config);
  return config;
}

/**
 * List all configured workspaces.
 */
export async function listWorkspaces(): Promise<WorkspaceEntry[]> {
  const config = await loadWorkspacesConfig();
  return config?.workspaces ?? [];
}

/**
 * Switch the default workspace by alias or workspace_id.
 * Returns the updated config, or null if the identifier was not found.
 */
export async function switchWorkspace(identifier: string): Promise<WorkspacesConfig | null> {
  const config = await loadWorkspacesConfig();
  if (!config) return null;

  const target = config.workspaces.find(
    (w) => w.workspace_alias === identifier || w.workspace_id === identifier
  );
  if (!target) return null;

  config.default_workspace = target.workspace_alias ?? target.workspace_id;
  for (const w of config.workspaces) {
    w.is_default = w.api_key === target.api_key;
  }

  // Also update the single-workspace .env to match the new default
  const gateway = await loadGatewayConfig();
  if (gateway) {
    gateway.apiKey = target.api_key;
    await saveGatewayConfig(gateway);
  }

  await saveWorkspacesConfig(config);
  return config;
}

/**
 * Build RELAY_WORKSPACES_JSON value for the broker from stored workspaces.
 * Returns null if there are fewer than 2 workspaces (single-workspace mode).
 */
export function buildWorkspacesJson(config: WorkspacesConfig): string | null {
  if (config.workspaces.length < 2) return null;

  const memberships = config.workspaces.map((w) => ({
    api_key: w.api_key,
    ...(w.workspace_id ? { workspace_id: w.workspace_id } : {}),
    ...(w.workspace_alias ? { workspace_alias: w.workspace_alias } : {}),
  }));

  const payload: Record<string, unknown> = { memberships };
  if (config.default_workspace) {
    payload.default_workspace_id = config.default_workspace;
  }

  return JSON.stringify(payload);
}
