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
 * Returns null if no config found
 */
export function loadTeamsConfig(projectRoot: string): TeamsConfig | null {
  const configPaths = getTeamsConfigPaths(projectRoot);

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(content) as TeamsConfig;

        // Validate required fields
        if (!config.team || typeof config.team !== 'string') {
          console.error(`[teams-config] Invalid teams.json at ${configPath}: missing or invalid 'team' field`);
          continue;
        }

        if (!Array.isArray(config.agents)) {
          console.error(`[teams-config] Invalid teams.json at ${configPath}: 'agents' must be an array`);
          continue;
        }

        // Validate agents
        const validAgents: TeamAgentConfig[] = [];
        for (const agent of config.agents) {
          if (!agent.name || typeof agent.name !== 'string') {
            console.warn(`[teams-config] Skipping agent with missing name in ${configPath}`);
            continue;
          }
          if (!agent.cli || typeof agent.cli !== 'string') {
            console.warn(`[teams-config] Agent '${agent.name}' missing 'cli' field, defaulting to 'claude'`);
            agent.cli = 'claude';
          }
          validAgents.push(agent);
        }

        console.log(`[teams-config] Loaded team '${config.team}' from ${configPath} (${validAgents.length} agents)`);

        return {
          team: config.team,
          agents: validAgents,
          autoSpawn: config.autoSpawn ?? false,
        };
      } catch (err) {
        console.error(`[teams-config] Failed to parse ${configPath}:`, err);
      }
    }
  }

  return null;
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
