import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

import type { GatewayConfig } from './types.js';

export interface OpenClawDetection {
  /** Whether OpenClaw is installed. */
  installed: boolean;
  /** Path to ~/.openclaw/ */
  homeDir: string;
  /** Path to ~/.openclaw/workspace/ */
  workspaceDir: string;
  /** Path to openclaw.json config (if found). */
  configFile: string | null;
  /** Parsed openclaw.json (if exists). */
  config: Record<string, unknown> | null;
}

/** Default OpenClaw config directory. */
function openclawHome(): string {
  return join(homedir(), '.openclaw');
}

/**
 * Detect whether OpenClaw is installed and return paths/config.
 */
export async function detectOpenClaw(): Promise<OpenClawDetection> {
  const homeDir = openclawHome();
  const configPath = join(homeDir, 'openclaw.json');
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

  return { installed, homeDir, workspaceDir, configFile, config };
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
      vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }

    const apiKey = vars['RELAY_API_KEY'];
    const clawName = vars['RELAY_CLAW_NAME'];

    if (!apiKey || !clawName) {
      return null;
    }

    return {
      apiKey,
      clawName,
      baseUrl: vars['RELAY_BASE_URL'] || 'https://api.relaycast.dev',
      channels: vars['RELAY_CHANNELS']
        ? vars['RELAY_CHANNELS'].split(',').map((c) => c.trim())
        : ['general'],
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

  const env = [
    '# Relaycast configuration for this OpenClaw skill',
    `RELAY_API_KEY=${config.apiKey}`,
    `RELAY_CLAW_NAME=${config.clawName}`,
    `RELAY_BASE_URL=${config.baseUrl}`,
    `RELAY_CHANNELS=${config.channels.join(',')}`,
    '',
  ].join('\n');

  await writeFile(join(relaycastDir, '.env'), env, 'utf-8');
}
