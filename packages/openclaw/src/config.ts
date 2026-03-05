import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';

import type { GatewayConfig } from './types.js';

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

    const apiKey = vars['RELAY_API_KEY'];
    const clawName = vars['RELAY_CLAW_NAME'];

    if (!apiKey || !clawName) {
      return null;
    }

    const portStr = vars['OPENCLAW_GATEWAY_PORT'];
    const port = portStr ? Number(portStr) : undefined;

    return {
      apiKey,
      clawName,
      baseUrl: vars['RELAY_BASE_URL'] || 'https://api.relaycast.dev',
      channels: vars['RELAY_CHANNELS']
        ? vars['RELAY_CHANNELS'].split(',').map((c) => c.trim())
        : ['general'],
      openclawGatewayToken: vars['OPENCLAW_GATEWAY_TOKEN'] || process.env.OPENCLAW_GATEWAY_TOKEN,
      openclawGatewayPort: Number.isFinite(port) ? port : undefined,
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
    const masked = config.openclawGatewayToken.length > 12
      ? config.openclawGatewayToken.slice(0, 8) + '...'
      : '***';
    console.log(`[config] Persisting OPENCLAW_GATEWAY_TOKEN (${masked})`);
  }
  if (config.openclawGatewayPort) {
    lines.push(`OPENCLAW_GATEWAY_PORT=${config.openclawGatewayPort}`);
  }

  lines.push('');
  const env = lines.join('\n');

  await writeFile(join(relaycastDir, '.env'), env, 'utf-8');
}
