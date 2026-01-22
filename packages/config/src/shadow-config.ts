/**
 * Shadow Agent Configuration
 * Handles loading and parsing shadow agent configuration from .agent-relay.json.
 *
 * Configuration can be placed in:
 * - Project root: ./.agent-relay.json
 * - Agent-relay dir: ./.agent-relay/config.json
 *
 * Shadow configuration structure:
 * {
 *   "shadows": {
 *     "pairs": {
 *       "Lead": { "shadow": "Auditor", "shadowRole": "reviewer" }
 *     },
 *     "roles": {
 *       "reviewer": { "prompt": "Review code...", "speakOn": ["CODE_WRITTEN"] }
 *     }
 *   }
 * }
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SpeakOnTrigger } from '@agent-relay/protocol/types';

/** Shadow role definition */
export interface ShadowRoleConfig {
  /** System prompt for this shadow role */
  prompt?: string;
  /** Triggers for when the shadow should speak */
  speakOn: SpeakOnTrigger[];
}

/** Shadow pair definition */
export interface ShadowPairConfig {
  /** Name of the shadow agent */
  shadow: string;
  /** Role name (references roles config) or preset (reviewer, auditor, active) */
  shadowRole?: string;
  /** Override speakOn triggers (takes precedence over role) */
  speakOn?: SpeakOnTrigger[];
  /** CLI to use for shadow (defaults to same as primary) */
  cli?: string;
}

/** Shadow configuration section */
export interface ShadowConfig {
  /** Primary -> Shadow mappings */
  pairs: Record<string, ShadowPairConfig>;
  /** Role definitions */
  roles?: Record<string, ShadowRoleConfig>;
}

/** Full agent-relay configuration file structure */
export interface AgentRelayConfig {
  /** Shadow agent configuration */
  shadows?: ShadowConfig;
  /** Future config sections can be added here */
}

/** Resolved shadow config for a primary agent */
export interface ResolvedShadowConfig {
  /** Shadow agent name */
  shadowName: string;
  /** Role name (for logging/display) */
  roleName?: string;
  /** Resolved speakOn triggers */
  speakOn: SpeakOnTrigger[];
  /** System prompt for the shadow */
  prompt?: string;
  /** CLI to use for shadow */
  cli?: string;
}

/** Role presets matching CLI behavior */
const ROLE_PRESETS: Record<string, SpeakOnTrigger[]> = {
  reviewer: ['CODE_WRITTEN', 'REVIEW_REQUEST', 'EXPLICIT_ASK'],
  auditor: ['SESSION_END', 'EXPLICIT_ASK'],
  active: ['ALL_MESSAGES'],
};

/**
 * Possible locations for .agent-relay.json (in order of precedence)
 */
function getConfigPaths(projectRoot: string): string[] {
  return [
    path.join(projectRoot, '.agent-relay', 'config.json'),
    path.join(projectRoot, '.agent-relay.json'),
  ];
}

/**
 * Load agent-relay configuration from project root
 * Returns null if no config found
 */
export function loadAgentRelayConfig(projectRoot: string): AgentRelayConfig | null {
  const configPaths = getConfigPaths(projectRoot);

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(content) as AgentRelayConfig;

        console.log(`[shadow-config] Loaded config from ${configPath}`);
        return config;
      } catch (err) {
        console.error(`[shadow-config] Failed to parse ${configPath}:`, err);
      }
    }
  }

  return null;
}

/**
 * Get shadow configuration for a primary agent
 * Returns null if no shadow configured for this agent
 */
export function getShadowForAgent(
  projectRoot: string,
  primaryAgentName: string
): ResolvedShadowConfig | null {
  const config = loadAgentRelayConfig(projectRoot);
  if (!config?.shadows?.pairs) {
    return null;
  }

  const pairConfig = config.shadows.pairs[primaryAgentName];
  if (!pairConfig) {
    return null;
  }

  // Resolve speakOn triggers
  let speakOn: SpeakOnTrigger[] = ['EXPLICIT_ASK']; // Default
  let prompt: string | undefined;
  const roleName = pairConfig.shadowRole;

  // First, try to resolve from role preset
  if (roleName && ROLE_PRESETS[roleName.toLowerCase()]) {
    speakOn = ROLE_PRESETS[roleName.toLowerCase()];
  }

  // Then, try custom role from config
  if (roleName && config.shadows.roles?.[roleName]) {
    const roleConfig = config.shadows.roles[roleName];
    speakOn = roleConfig.speakOn;
    prompt = roleConfig.prompt;
  }

  // Finally, override with explicit speakOn if provided
  if (pairConfig.speakOn && pairConfig.speakOn.length > 0) {
    speakOn = pairConfig.speakOn;
  }

  return {
    shadowName: pairConfig.shadow,
    roleName,
    speakOn,
    prompt,
    cli: pairConfig.cli,
  };
}

/**
 * Get all configured shadow pairs
 */
export function getAllShadowPairs(projectRoot: string): Map<string, ResolvedShadowConfig> {
  const config = loadAgentRelayConfig(projectRoot);
  const result = new Map<string, ResolvedShadowConfig>();

  if (!config?.shadows?.pairs) {
    return result;
  }

  for (const primaryName of Object.keys(config.shadows.pairs)) {
    const resolved = getShadowForAgent(projectRoot, primaryName);
    if (resolved) {
      result.set(primaryName, resolved);
    }
  }

  return result;
}

/**
 * Check if shadow config exists
 */
export function hasShadowConfig(projectRoot: string): boolean {
  const config = loadAgentRelayConfig(projectRoot);
  return !!(config?.shadows?.pairs && Object.keys(config.shadows.pairs).length > 0);
}

/**
 * Get the config file path that would be used
 */
export function getConfigPath(projectRoot: string): string | null {
  const configPaths = getConfigPaths(projectRoot);
  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      return configPath;
    }
  }
  return null;
}
