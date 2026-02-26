import os from 'node:os';
import path from 'node:path';

import type { CoreDependencies, CoreFileSystem } from '../commands/core.js';

const SNIPPET_MARKER_START_PREFIX = '<!-- prpm:snippet:start @agent-relay/agent-relay-snippet@';
const SNIPPET_MARKER_END_PREFIX = '<!-- prpm:snippet:end @agent-relay/agent-relay-snippet@';
const SNIPPET_TARGET_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
const MCP_CONFIG_FILE = '.mcp.json';
const RELAYCAST_SERVER_KEY = 'relaycast';
const ZED_SETTINGS_PATH = path.join('.config', 'zed', 'settings.json');
const DEFAULT_ZED_SERVER_NAME = 'Agent Relay';

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Remove agent-relay snippet blocks from a markdown file's content.
 * Returns the cleaned content, or null if no snippets were found.
 */
function removeSnippetBlocks(content: string): string | null {
  const lines = content.split('\n');
  const result: string[] = [];
  let inBlock = false;
  let found = false;

  for (const line of lines) {
    if (line.includes(SNIPPET_MARKER_START_PREFIX)) {
      inBlock = true;
      found = true;
      continue;
    }
    if (inBlock && line.includes(SNIPPET_MARKER_END_PREFIX)) {
      inBlock = false;
      continue;
    }
    if (!inBlock) {
      result.push(line);
    }
  }

  if (!found) {
    return null;
  }

  // Trim trailing blank lines left behind by the removed block.
  let cleaned = result.join('\n');
  while (cleaned.endsWith('\n\n')) {
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned;
}

/**
 * Remove the relaycast entry from .mcp.json if present.
 * Returns true if the file was modified.
 */
function removeRelaycastFromMcpConfig(
  projectRoot: string,
  fileSystem: CoreFileSystem,
  dryRun: boolean,
  log: (...args: unknown[]) => void
): boolean {
  const mcpPath = path.join(projectRoot, MCP_CONFIG_FILE);
  if (!fileSystem.existsSync(mcpPath)) {
    return false;
  }

  try {
    const raw = fileSystem.readFileSync(mcpPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const servers = parsed.mcpServers as Record<string, unknown> | undefined;
    if (!servers || !(RELAYCAST_SERVER_KEY in servers)) {
      return false;
    }

    if (dryRun) {
      log(`[dry-run] Would remove '${RELAYCAST_SERVER_KEY}' from ${mcpPath}`);
      return true;
    }

    delete servers[RELAYCAST_SERVER_KEY];

    // If mcpServers is now empty, remove the whole file.
    if (Object.keys(servers).length === 0 && Object.keys(parsed).length === 1) {
      fileSystem.unlinkSync(mcpPath);
      log(`Removed ${mcpPath} (no remaining servers)`);
    } else {
      fileSystem.writeFileSync(mcpPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
      log(`Removed '${RELAYCAST_SERVER_KEY}' from ${mcpPath}`);
    }
    return true;
  } catch {
    // Best-effort: don't fail uninstall over MCP config parsing issues.
    return false;
  }
}

/**
 * Remove the Agent Relay entry from Zed's settings.json.
 * Returns true if the file was modified.
 */
function removeZedConfig(
  serverName: string,
  fileSystem: CoreFileSystem,
  dryRun: boolean,
  log: (...args: unknown[]) => void
): boolean {
  const homeDir = os.homedir();
  const zedPath = path.join(homeDir, ZED_SETTINGS_PATH);
  if (!fileSystem.existsSync(zedPath)) {
    return false;
  }

  try {
    const raw = fileSystem.readFileSync(zedPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const agentServers = parsed.agent_servers as Record<string, unknown> | undefined;
    if (!agentServers || !(serverName in agentServers)) {
      return false;
    }

    if (dryRun) {
      log(`[dry-run] Would remove '${serverName}' from ${zedPath}`);
      return true;
    }

    delete agentServers[serverName];

    // If agent_servers is now empty, remove the key entirely.
    if (Object.keys(agentServers).length === 0) {
      delete parsed.agent_servers;
    }

    fileSystem.writeFileSync(zedPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
    log(`Removed '${serverName}' from ${zedPath}`);
    return true;
  } catch {
    // Best-effort: don't fail uninstall over Zed config issues.
    return false;
  }
}

export async function runUpdateCommand(options: { check?: boolean }, deps: CoreDependencies): Promise<void> {
  const currentVersion = deps.getVersion();
  deps.log(`Current version: ${currentVersion}`);
  deps.log('Checking for updates...');

  const info = await deps.checkForUpdates(currentVersion);
  if (info.error) {
    deps.error(`Failed to check for updates: ${info.error}`);
    deps.exit(1);
    return;
  }

  if (!info.updateAvailable) {
    deps.log('You are running the latest version.');
    return;
  }

  deps.log(`New version available: ${info.latestVersion ?? 'latest'}`);

  if (options.check) {
    deps.log('Run `agent-relay update` to install.');
    return;
  }

  deps.log('Installing update...');
  try {
    const { stdout, stderr } = await deps.execCommand('npm install -g agent-relay@latest');
    if (stdout.trim().length > 0) {
      deps.log(stdout.trimEnd());
    }
    if (stderr.trim().length > 0) {
      deps.error(stderr.trimEnd());
    }
    deps.log(`Successfully updated to ${info.latestVersion ?? 'latest'}`);
  } catch (err: unknown) {
    deps.error(`Failed to install update: ${toErrorMessage(err)}`);
    deps.log('Try running manually: npm install -g agent-relay@latest');
    deps.exit(1);
  }
}

export async function runUninstallCommand(
  options: {
    keepData?: boolean;
    zed?: boolean;
    zedName?: string;
    snippets?: boolean;
    force?: boolean;
    dryRun?: boolean;
  },
  deps: CoreDependencies
): Promise<void> {
  const paths = deps.getProjectPaths();
  const brokerPidPath = path.join(paths.dataDir, 'broker.pid');
  const runtimePath = path.join(paths.dataDir, 'runtime.json');

  if (deps.fs.existsSync(brokerPidPath)) {
    const pidRaw = deps.fs.readFileSync(brokerPidPath, 'utf-8').trim();
    const pid = Number.parseInt(pidRaw, 10);
    if (!Number.isNaN(pid) && pid > 0) {
      try {
        deps.killProcess(pid, 'SIGTERM');
      } catch {
        // Ignore dead processes.
      }
    }
  }

  const isDryRun = options.dryRun === true;

  // --- Data directory cleanup ---
  if (isDryRun) {
    if (options.keepData) {
      deps.log(`[dry-run] Would remove: ${brokerPidPath}`);
      deps.log(`[dry-run] Would remove: ${runtimePath}`);
    } else {
      deps.log(`[dry-run] Would remove directory: ${paths.dataDir}`);
    }
  } else if (options.keepData) {
    for (const filePath of [brokerPidPath, runtimePath]) {
      if (!deps.fs.existsSync(filePath)) {
        continue;
      }
      try {
        deps.fs.unlinkSync(filePath);
      } catch {
        // Best-effort cleanup.
      }
    }

    try {
      for (const file of deps.fs.readdirSync(paths.dataDir)) {
        if (file.startsWith('mcp-identity-')) {
          deps.fs.unlinkSync(path.join(paths.dataDir, file));
        }
      }
    } catch {
      // Ignore read failures.
    }

    deps.log('Removed runtime files (kept data).');
  } else if (deps.fs.existsSync(paths.dataDir)) {
    deps.fs.rmSync(paths.dataDir, { recursive: true, force: true });
    deps.log(`Removed ${paths.dataDir}`);
  }

  // --- MCP config cleanup (.mcp.json relaycast entry) ---
  removeRelaycastFromMcpConfig(paths.projectRoot, deps.fs, isDryRun, deps.log);

  // --- Zed editor config cleanup ---
  if (options.zed) {
    const serverName = options.zedName || DEFAULT_ZED_SERVER_NAME;
    removeZedConfig(serverName, deps.fs, isDryRun, deps.log);
  }

  // --- Snippet cleanup (CLAUDE.md, GEMINI.md, AGENTS.md) ---
  if (options.snippets) {
    for (const fileName of SNIPPET_TARGET_FILES) {
      const filePath = path.join(paths.projectRoot, fileName);
      if (!deps.fs.existsSync(filePath)) {
        continue;
      }

      try {
        const content = deps.fs.readFileSync(filePath, 'utf-8');
        const cleaned = removeSnippetBlocks(content);
        if (cleaned === null) {
          continue;
        }

        if (isDryRun) {
          deps.log(`[dry-run] Would remove agent-relay snippets from ${filePath}`);
          continue;
        }

        // If the file is now empty (or just whitespace), remove it entirely.
        if (cleaned.trim().length === 0) {
          deps.fs.unlinkSync(filePath);
          deps.log(`Removed ${filePath} (was only agent-relay snippets)`);
        } else {
          deps.fs.writeFileSync(filePath, cleaned, 'utf-8');
          deps.log(`Removed agent-relay snippets from ${filePath}`);
        }
      } catch {
        // Best-effort: don't fail uninstall over snippet removal issues.
      }
    }
  }

  deps.log('Uninstall complete.');
}
