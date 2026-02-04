/**
 * Teams Configuration
 * Handles loading and parsing teams.json for auto-spawn and agent validation.
 *
 * teams.json can be placed in:
 * - Project root: ./teams.json
 * - Agent-relay dir: ./.agent-relay/teams.json
 */

import fs from 'node:fs';
import path from 'node:path';

/** Cache for teams config to avoid repeated file reads and log spam */
interface TeamsConfigCache {
  config: TeamsConfig | null;
  projectRoot: string;
  configPath: string | null;
  mtime: number;
}

let configCache: TeamsConfigCache | null = null;

/** Agent definition in teams.json */
export interface TeamAgentConfig {
  /** Agent name (used for spawn and validation) */
  name: string;
  /** CLI command to use (e.g., 'claude', 'claude:opus', 'codex') */
  cli: string;
  /** Agent role (e.g., 'coordinator', 'developer', 'reviewer') */
  role?: string;
  /** Initial task/prompt to inject when spawning */
  task?: string;
}

/** teams.json file structure */
export interface TeamsConfig {
  /** Team name (for identification) */
  team: string;
  /** Agents defined in this team */
  agents: TeamAgentConfig[];
  /** If true, agent-relay up will auto-spawn all agents */
  autoSpawn?: boolean;
}

/**
 * Possible locations for teams.json (in order of precedence)
 */
function getTeamsConfigPaths(projectRoot: string): string[] {
  return [
    path.join(projectRoot, '.agent-relay', 'teams.json'),
    path.join(projectRoot, 'teams.json'),
  ];
}

/**
 * Load teams.json from project root or .agent-relay directory
 * Returns null if no config found.
 * Results are cached and only reloaded when the file changes.
 */
export function loadTeamsConfig(projectRoot: string): TeamsConfig | null {
  const configPaths = getTeamsConfigPaths(projectRoot);

  // Find which config file exists
  let foundConfigPath: string | null = null;
  let foundMtime = 0;
  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const stat = fs.statSync(configPath);
        foundConfigPath = configPath;
        foundMtime = stat.mtimeMs;
        break;
      } catch {
        // Ignore stat errors, try next path
      }
    }
  }

  // Check cache validity
  if (configCache && configCache.projectRoot === projectRoot) {
    // If no config file found, return cached null result
    if (!foundConfigPath && !configCache.configPath) {
      return null;
    }
    // If same file and not modified, return cached config
    if (foundConfigPath === configCache.configPath && foundMtime === configCache.mtime) {
      return configCache.config;
    }
  }

  // No config file found
  if (!foundConfigPath) {
    configCache = {
      config: null,
      projectRoot,
      configPath: null,
      mtime: 0,
    };
    return null;
  }

  // Load and parse config
  try {
    const content = fs.readFileSync(foundConfigPath, 'utf-8');
    const config = JSON.parse(content) as TeamsConfig;

    // Validate required fields
    if (!config.team || typeof config.team !== 'string') {
      console.error(`[teams-config] Invalid teams.json at ${foundConfigPath}: missing or invalid 'team' field`);
      configCache = { config: null, projectRoot, configPath: foundConfigPath, mtime: foundMtime };
      return null;
    }

    if (!Array.isArray(config.agents)) {
      console.error(`[teams-config] Invalid teams.json at ${foundConfigPath}: 'agents' must be an array`);
      configCache = { config: null, projectRoot, configPath: foundConfigPath, mtime: foundMtime };
      return null;
    }

    // Validate agents
    const validAgents: TeamAgentConfig[] = [];
    for (const agent of config.agents) {
      if (!agent.name || typeof agent.name !== 'string') {
        console.warn(`[teams-config] Skipping agent with missing name in ${foundConfigPath}`);
        continue;
      }
      if (!agent.cli || typeof agent.cli !== 'string') {
        console.warn(`[teams-config] Agent '${agent.name}' missing 'cli' field, defaulting to 'claude'`);
        agent.cli = 'claude';
      }
      validAgents.push(agent);
    }

    console.log(`[teams-config] Loaded team '${config.team}' from ${foundConfigPath} (${validAgents.length} agents)`);

    const result: TeamsConfig = {
      team: config.team,
      agents: validAgents,
      autoSpawn: config.autoSpawn ?? false,
    };

    // Update cache
    configCache = {
      config: result,
      projectRoot,
      configPath: foundConfigPath,
      mtime: foundMtime,
    };

    return result;
  } catch (err) {
    console.error(`[teams-config] Failed to parse ${foundConfigPath}:`, err);
    configCache = { config: null, projectRoot, configPath: foundConfigPath, mtime: foundMtime };
    return null;
  }
}

/**
 * Clear the teams config cache.
 * Useful for testing or when you know the config has changed.
 */
export function clearTeamsConfigCache(): void {
  configCache = null;
}

/**
 * Check if an agent name is valid according to teams.json
 * Returns true if no teams.json exists (permissive mode)
 */
export function isValidAgentName(projectRoot: string, agentName: string): boolean {
  const config = loadTeamsConfig(projectRoot);

  // No config = permissive mode
  if (!config) {
    return true;
  }

  return config.agents.some(a => a.name === agentName);
}

/**
 * Get agent config by name from teams.json
 */
export function getAgentConfig(projectRoot: string, agentName: string): TeamAgentConfig | null {
  const config = loadTeamsConfig(projectRoot);
  if (!config) return null;

  return config.agents.find(a => a.name === agentName) ?? null;
}

/**
 * Get teams.json path that would be used (for error messages)
 */
export function getTeamsConfigPath(projectRoot: string): string | null {
  const configPaths = getTeamsConfigPaths(projectRoot);
  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      return configPath;
    }
  }
  return null;
}
