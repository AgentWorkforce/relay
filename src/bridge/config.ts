/**
 * Bridge Configuration
 * Handles loading and resolving bridge configuration from files and CLI args.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getProjectPaths } from '../utils/project-namespace.js';
import type { ProjectConfig, BridgeConfig } from './types.js';

const CONFIG_PATHS = [
  path.join(os.homedir(), '.agent-relay', 'bridge.json'),
  path.join(os.homedir(), '.config', 'agent-relay', 'bridge.json'),
];

interface BridgeConfigFile {
  projects?: Record<string, {
    lead?: string;
    cli?: string;
  }>;
  defaultCli?: string;
}

/**
 * Load bridge config from file
 */
export function loadBridgeConfig(): BridgeConfigFile | null {
  for (const configPath of CONFIG_PATHS) {
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        return JSON.parse(content);
      } catch (err) {
        console.error(`[bridge] Failed to parse ${configPath}:`, err);
      }
    }
  }
  return null;
}

/**
 * Resolve project path (expand ~ and make absolute)
 */
export function resolvePath(p: string): string {
  if (p.startsWith('~')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

/**
 * Get default lead name from directory name
 */
export function getDefaultLeadName(projectPath: string): string {
  const dirname = path.basename(projectPath);
  // Capitalize first letter
  return dirname.charAt(0).toUpperCase() + dirname.slice(1);
}

/**
 * Resolve projects from CLI args and/or config file
 */
export function resolveProjects(
  cliPaths: string[],
  cliOverride?: string
): ProjectConfig[] {
  const config = loadBridgeConfig();
  const projects: ProjectConfig[] = [];

  // If CLI paths provided, use those
  if (cliPaths.length > 0) {
    for (const p of cliPaths) {
      const projectPath = resolvePath(p);

      if (!fs.existsSync(projectPath)) {
        console.error(`[bridge] Project path does not exist: ${projectPath}`);
        continue;
      }

      const paths = getProjectPaths(projectPath);

      // Check for project-specific config
      const projectConfig = config?.projects?.[p] || config?.projects?.[projectPath];

      projects.push({
        path: projectPath,
        id: paths.projectId,
        socketPath: paths.socketPath,
        leadName: projectConfig?.lead || getDefaultLeadName(projectPath),
        cli: cliOverride || projectConfig?.cli || config?.defaultCli || 'claude',
      });
    }
  }
  // Otherwise use config file
  else if (config?.projects) {
    for (const [p, projectConfig] of Object.entries(config.projects)) {
      const projectPath = resolvePath(p);

      if (!fs.existsSync(projectPath)) {
        console.error(`[bridge] Project path does not exist: ${projectPath}`);
        continue;
      }

      const paths = getProjectPaths(projectPath);

      projects.push({
        path: projectPath,
        id: paths.projectId,
        socketPath: paths.socketPath,
        leadName: projectConfig.lead || getDefaultLeadName(projectPath),
        cli: cliOverride || projectConfig.cli || config.defaultCli || 'claude',
      });
    }
  }

  return projects;
}

/**
 * Validate that daemons are running for all projects
 */
export function validateDaemons(projects: ProjectConfig[]): {
  valid: ProjectConfig[];
  missing: ProjectConfig[];
} {
  const valid: ProjectConfig[] = [];
  const missing: ProjectConfig[] = [];

  for (const project of projects) {
    if (fs.existsSync(project.socketPath)) {
      valid.push(project);
    } else {
      missing.push(project);
    }
  }

  return { valid, missing };
}

/**
 * Start daemons for missing projects
 */
export async function startMissingDaemons(
  projects: ProjectConfig[]
): Promise<void> {
  const { execAsync } = await import('./utils.js');

  for (const project of projects) {
    console.log(`[bridge] Starting daemon for ${project.id}...`);
    try {
      // Start daemon in background
      await execAsync(`cd "${project.path}" && agent-relay up &`, {
        timeout: 5000,
      });
      // Wait for socket to appear
      await waitForSocket(project.socketPath, 10000);
      console.log(`[bridge] Daemon started for ${project.id}`);
    } catch (err) {
      console.error(`[bridge] Failed to start daemon for ${project.id}:`, err);
    }
  }
}

/**
 * Wait for socket file to exist
 */
async function waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (fs.existsSync(socketPath)) {
      return;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Timeout waiting for socket: ${socketPath}`);
}
