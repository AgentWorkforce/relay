/**
 * Agent Config Detection
 *
 * Detects agent configuration from .claude/agents/ or .openagents/ directories.
 * Parses frontmatter to extract model, description, and other settings.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface AgentConfig {
  /** Agent name (from filename or frontmatter) */
  name: string;
  /** Path to the config file */
  configPath: string;
  /** Model to use (e.g., 'haiku', 'sonnet', 'opus') */
  model?: string;
  /** Agent description */
  description?: string;
  /** Allowed tools */
  allowedTools?: string[];
  /** Agent type */
  agentType?: string;
}

/**
 * Parse YAML-style frontmatter from markdown content.
 * Handles basic key: value pairs.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  // Check for frontmatter delimiters
  if (!content.startsWith('---')) {
    return result;
  }

  const endIndex = content.indexOf('---', 3);
  if (endIndex === -1) {
    return result;
  }

  const frontmatter = content.slice(3, endIndex).trim();
  const lines = frontmatter.split('\n');

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (key && value) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Find and parse agent config for a given agent name.
 * Searches in order:
 *   1. .claude/agents/<name>.md (case-insensitive)
 *   2. .openagents/<name>.md (case-insensitive)
 *
 * @param agentName The agent name to look up
 * @param projectRoot The project root directory (defaults to cwd)
 * @returns AgentConfig if found, null otherwise
 */
export function findAgentConfig(agentName: string, projectRoot?: string): AgentConfig | null {
  const root = projectRoot ?? process.cwd();
  const lowerName = agentName.toLowerCase();

  // Directories to search
  const searchDirs = [
    path.join(root, '.claude', 'agents'),
    path.join(root, '.openagents'),
  ];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) {
      continue;
    }

    try {
      const files = fs.readdirSync(dir);

      // Find matching file (case-insensitive)
      for (const file of files) {
        if (!file.endsWith('.md')) continue;

        const baseName = file.slice(0, -3); // Remove .md
        if (baseName.toLowerCase() === lowerName) {
          const configPath = path.join(dir, file);
          const content = fs.readFileSync(configPath, 'utf-8');
          const frontmatter = parseFrontmatter(content);

          return {
            name: frontmatter.name || baseName,
            configPath,
            model: frontmatter.model,
            description: frontmatter.description,
            allowedTools: frontmatter['allowed-tools']?.split(',').map(t => t.trim()),
            agentType: frontmatter.agentType,
          };
        }
      }
    } catch {
      // Directory read failed, continue to next
    }
  }

  return null;
}

/**
 * Check if a command is a Claude CLI command.
 */
export function isClaudeCli(command: string): boolean {
  const cmd = command.toLowerCase();
  return cmd === 'claude' || cmd.startsWith('claude ') || cmd.includes('/claude');
}

/**
 * Build Claude CLI arguments with auto-detected agent config.
 *
 * @param agentName Agent name
 * @param existingArgs Existing command arguments
 * @param projectRoot Project root directory
 * @returns Modified args array with --model and --agent if applicable
 */
export function buildClaudeArgs(
  agentName: string,
  existingArgs: string[] = [],
  projectRoot?: string
): string[] {
  const config = findAgentConfig(agentName, projectRoot);

  if (!config) {
    return existingArgs;
  }

  const newArgs = [...existingArgs];

  // Add --model if specified in config and not already in args
  if (config.model && !existingArgs.includes('--model')) {
    newArgs.push('--model', config.model);
  }

  // Add --agent to load the agent's system prompt (if not already specified)
  if (!existingArgs.includes('--agent')) {
    newArgs.push('--agent', config.name);
  }

  return newArgs;
}
