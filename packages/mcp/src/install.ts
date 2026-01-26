/**
 * MCP Installation System
 *
 * Auto-configures MCP server for different AI editors:
 * - Claude Desktop / Claude Code
 * - Cursor
 * - VS Code (with MCP extension)
 * - Windsurf
 * - Zed
 * - Gemini CLI
 * - OpenCode
 * - Droid (Factory)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';
import * as TOML from 'smol-toml';

export interface EditorConfig {
  /** Display name for the editor */
  name: string;
  /** Path to the config file */
  configPath: string;
  /** Key in config object for MCP servers */
  configKey: string;
  /** Config file format */
  format: 'json' | 'jsonc' | 'toml';
  /** Whether this editor supports project-local MCP configs */
  supportsLocal?: boolean;
}

export interface InstallOptions {
  /** Specific editor to install for (auto-detect if not specified) */
  editor?: string;
  /** Install globally vs project-local */
  global?: boolean;
  /** Project directory for local install */
  projectDir?: string;
  /** Dry run - print what would be done without making changes */
  dryRun?: boolean;
  /** Custom server command (defaults to npx) */
  command?: string;
  /** Custom server args */
  args?: string[];
  /** Custom config path - overrides auto-detected path */
  configPath?: string;
  /** Config format when using custom configPath (default: json) */
  configFormat?: 'json' | 'jsonc' | 'toml';
  /** Config key for MCP servers when using custom configPath (default: mcpServers) */
  configKey?: string;
  /** Environment variables to set when launching the MCP server */
  env?: Record<string, string>;
}

export interface InstallResult {
  editor: string;
  configPath: string;
  success: boolean;
  error?: string;
  /** Whether config was created vs updated */
  created: boolean;
}

/**
 * MCP server configuration that gets added to editor configs
 */
export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Get platform-specific config paths
 */
function getConfigPaths(): Record<string, EditorConfig> {
  const home = homedir();
  const plat = platform();

  // Platform-specific base paths
  const appSupport =
    plat === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : plat === 'win32'
        ? process.env.APPDATA || join(home, 'AppData', 'Roaming')
        : join(home, '.config');

  return {
    claude: {
      name: 'Claude Desktop',
      configPath:
        plat === 'darwin'
          ? join(appSupport, 'Claude', 'claude_desktop_config.json')
          : plat === 'win32'
            ? join(appSupport, 'Claude', 'claude_desktop_config.json')
            : join(home, '.config', 'claude', 'claude_desktop_config.json'),
      configKey: 'mcpServers',
      format: 'json',
    },
    'claude-code': {
      name: 'Claude Code',
      configPath: join(home, '.claude', 'settings.json'),
      configKey: 'mcpServers',
      format: 'json',
      supportsLocal: true,
    },
    cursor: {
      name: 'Cursor',
      configPath: join(home, '.cursor', 'mcp.json'),
      configKey: 'mcpServers',
      format: 'json',
      supportsLocal: true,
    },
    vscode: {
      name: 'VS Code',
      configPath: join(home, '.vscode', 'mcp.json'),
      configKey: 'mcpServers',
      format: 'jsonc',
      supportsLocal: true,
    },
    windsurf: {
      name: 'Windsurf',
      configPath: join(home, '.windsurf', 'mcp.json'),
      configKey: 'mcpServers',
      format: 'json',
      supportsLocal: true,
    },
    zed: {
      name: 'Zed',
      configPath: join(home, '.config', 'zed', 'settings.json'),
      configKey: 'context_servers',
      format: 'jsonc',
    },
    gemini: {
      name: 'Gemini CLI',
      configPath: join(home, '.gemini', 'settings.json'),
      configKey: 'mcpServers',
      format: 'json',
      supportsLocal: true,
    },
    opencode: {
      name: 'OpenCode',
      configPath: join(home, '.config', 'opencode', 'opencode.json'),
      configKey: 'mcp', // OpenCode uses "mcp" not "mcpServers"
      format: 'json',
      supportsLocal: true,
    },
    droid: {
      name: 'Droid',
      configPath: join(home, '.factory', 'mcp.json'),
      configKey: 'mcpServers',
      format: 'json',
      supportsLocal: true,
    },
    codex: {
      name: 'Codex',
      configPath: join(home, '.codex', 'config.toml'),
      configKey: 'mcp_servers', // TOML uses [mcp_servers.agent-relay] tables
      format: 'toml',
      supportsLocal: true,
    },
  };
}

/**
 * Default MCP server configuration
 */
export function getDefaultServerConfig(): McpServerConfig {
  return {
    command: 'npx',
    args: ['@agent-relay/mcp', 'serve'],
  };
}

/**
 * Check if node is installed via nvm (Node Version Manager).
 * GUI apps (Claude, Cursor, VS Code) can't use nvm's shell function,
 * so we need to use absolute paths for nvm installations.
 */
function isUsingNvm(): boolean {
  try {
    const nodePath = execSync('which node', { encoding: 'utf-8' }).trim();
    return nodePath.includes('.nvm');
  } catch {
    return false;
  }
}

/**
 * Get absolute path to node binary
 */
function getNodePath(): string | null {
  try {
    return execSync('which node', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

/**
 * Get path to globally installed @agent-relay/mcp bin.js
 * Returns null if not installed globally.
 */
function getGlobalMcpBinPath(): string | null {
  try {
    // Get npm global prefix
    const npmPrefix = execSync('npm prefix -g', { encoding: 'utf-8' }).trim();
    const binPath = join(npmPrefix, 'lib', 'node_modules', '@agent-relay', 'mcp', 'dist', 'bin.js');
    if (existsSync(binPath)) {
      return binPath;
    }
  } catch {
    // npm not available or failed
  }
  return null;
}

/**
 * Build MCP server configuration with proper paths.
 *
 * For nvm users: Uses absolute paths (recommended by MCP community)
 * For others: Uses npx (works when node is in standard PATH)
 *
 * See: https://github.com/modelcontextprotocol/servers/issues/64
 */
function buildServerConfig(): McpServerConfig {
  // If using nvm, we need absolute paths because GUI apps can't access nvm's shell function
  if (isUsingNvm()) {
    const nodePath = getNodePath();
    const mcpBinPath = getGlobalMcpBinPath();

    if (nodePath && mcpBinPath) {
      // Best option: globally installed package with absolute paths
      return {
        command: nodePath,
        args: [mcpBinPath, 'serve'],
      };
    }

    // Package not installed globally - still try with absolute node path + npx
    if (nodePath) {
      const npxPath = join(dirname(nodePath), 'npx');
      if (existsSync(npxPath)) {
        return {
          command: npxPath,
          args: ['@agent-relay/mcp', 'serve'],
        };
      }
    }
  }

  // Standard case: npx should work
  return {
    command: 'npx',
    args: ['@agent-relay/mcp', 'serve'],
  };
}

/**
 * Detect which editors are installed by checking for their config directories
 */
export function detectInstalledEditors(): string[] {
  const editors = getConfigPaths();
  const detected: string[] = [];

  for (const [key, config] of Object.entries(editors)) {
    const configDir = dirname(config.configPath);
    if (existsSync(configDir)) {
      detected.push(key);
    }
  }

  return detected;
}

/**
 * Get editor configuration by key
 */
export function getEditorConfig(editorKey: string): EditorConfig | undefined {
  const editors = getConfigPaths();
  return editors[editorKey];
}

/**
 * List all supported editors
 */
export function listSupportedEditors(): Array<{ key: string; name: string }> {
  const editors = getConfigPaths();
  return Object.entries(editors).map(([key, config]) => ({
    key,
    name: config.name,
  }));
}

/**
 * Strip JSON comments (for JSONC format)
 */
function stripJsonComments(content: string): string {
  // Remove single-line comments
  let result = content.replace(/\/\/.*$/gm, '');
  // Remove multi-line comments
  result = result.replace(/\/\*[\s\S]*?\*\//g, '');
  return result;
}

/**
 * Read and parse config file, handling JSON, JSONC, and TOML
 */
function readConfigFile(
  configPath: string,
  format: 'json' | 'jsonc' | 'toml'
): Record<string, unknown> {
  if (!existsSync(configPath)) {
    return {};
  }

  const content = readFileSync(configPath, 'utf-8');

  try {
    // Handle empty or whitespace-only files
    const trimmed = content.trim();
    if (!trimmed) {
      return {};
    }

    if (format === 'toml') {
      return TOML.parse(trimmed) as Record<string, unknown>;
    }

    const jsonContent = format === 'jsonc' ? stripJsonComments(content) : content;
    return JSON.parse(jsonContent.trim()) as Record<string, unknown>;
  } catch {
    // Invalid config, start fresh
    return {};
  }
}

/**
 * Write config file with proper formatting
 */
function writeConfigFile(
  configPath: string,
  config: Record<string, unknown>,
  format: 'json' | 'jsonc' | 'toml' = 'json'
): void {
  const configDir = dirname(configPath);

  // Ensure directory exists
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  if (format === 'toml') {
    writeFileSync(configPath, TOML.stringify(config) + '\n');
  } else {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  }
}

/**
 * Get the config path for local (project-specific) installation
 */
function getLocalConfigPath(
  editor: EditorConfig,
  projectDir: string
): string | null {
  if (!editor.supportsLocal) {
    return null;
  }

  // Most editors use .vscode/mcp.json or similar in project root
  switch (editor.name) {
    case 'Claude Code':
      return join(projectDir, '.mcp.json');
    case 'Cursor':
      return join(projectDir, '.cursor', 'mcp.json');
    case 'VS Code':
      return join(projectDir, '.vscode', 'mcp.json');
    case 'Windsurf':
      return join(projectDir, '.windsurf', 'mcp.json');
    case 'Gemini CLI':
      return join(projectDir, '.gemini', 'settings.json');
    case 'OpenCode':
      return join(projectDir, 'opencode.json');
    case 'Droid':
      return join(projectDir, '.factory', 'mcp.json');
    case 'Codex':
      return join(projectDir, 'codex.toml');
    default:
      return null;
  }
}

/**
 * Install MCP server configuration for a specific editor
 */
export function installForEditor(
  editorKey: string,
  options: InstallOptions = {}
): InstallResult {
  const editor = getEditorConfig(editorKey);

  // Allow custom configPath even without known editor
  if (!editor && !options.configPath) {
    return {
      editor: editorKey,
      configPath: '',
      success: false,
      error: `Unknown editor: ${editorKey}`,
      created: false,
    };
  }

  // Determine config path, format, and key
  // Custom configPath overrides everything (for programmatic installation)
  let configPath: string;
  let configFormat: 'json' | 'jsonc' | 'toml';
  let configKey: string;

  if (options.configPath) {
    // Use custom path - for programmatic/auto installation
    configPath = options.configPath;
    configFormat = options.configFormat || 'json';
    configKey = options.configKey || 'mcpServers';
  } else if (editor) {
    // Use editor's config
    configPath = editor.configPath;
    configFormat = editor.format;
    configKey = editor.configKey;

    // Check for local path override
    if (!options.global && options.projectDir && editor.supportsLocal) {
      const localPath = getLocalConfigPath(editor, options.projectDir);
      if (localPath) {
        configPath = localPath;
      }
    }
  } else {
    // Should not reach here due to early return above
    return {
      editor: editorKey,
      configPath: '',
      success: false,
      error: `Unknown editor: ${editorKey}`,
      created: false,
    };
  }

  // Build server config - handles nvm users with absolute paths
  const defaultConfig = buildServerConfig();
  const serverConfig: McpServerConfig = {
    command: options.command || defaultConfig.command,
    args: options.args || defaultConfig.args,
  };

  // Set environment variables if provided (e.g., RELAY_SOCKET for project-local installs)
  if (options.env) {
    serverConfig.env = { ...options.env };
  }

  // For project-local installs with projectDir, also set RELAY_SOCKET if not already set
  const isProjectLocal = !options.global && options.projectDir;
  if (isProjectLocal && !serverConfig.env?.RELAY_SOCKET) {
    const socketPath = join(options.projectDir!, '.agent-relay', 'relay.sock');
    serverConfig.env = {
      ...serverConfig.env,
      RELAY_SOCKET: socketPath,
    };
  }

  if (options.dryRun) {
    const editorName = editor?.name || editorKey || 'custom';
    return {
      editor: editorName,
      configPath,
      success: true,
      created: !existsSync(configPath),
    };
  }

  try {
    // Read existing config
    const config = readConfigFile(configPath, configFormat);
    const created = !existsSync(configPath);

    // Initialize mcpServers if not present
    const configKeyValue = config[configKey];
    if (!configKeyValue || typeof configKeyValue !== 'object') {
      (config as Record<string, unknown>)[configKey] = {};
    }

    // Add agent-relay server config
    const mcpServers = config[configKey] as Record<string, unknown>;

    // OpenCode uses a different format: { type: "local", command: [...], environment: {...} }
    if (editor?.name === 'OpenCode') {
      const openCodeConfig: Record<string, unknown> = {
        type: 'local',
        command: [serverConfig.command, ...serverConfig.args],
      };
      if (serverConfig.env) {
        openCodeConfig.environment = serverConfig.env;
      }
      mcpServers['agent-relay'] = openCodeConfig;
    } else {
      mcpServers['agent-relay'] = serverConfig;
    }

    // For Claude Code, also add permissions to auto-approve agent-relay tools
    // Permissions go in settings.json, not .mcp.json
    if (editor?.name === 'Claude Code') {
      // Determine settings path based on where MCP config is being written
      const projectDir = configPath.endsWith('.mcp.json')
        ? dirname(configPath) // project-local: same dir as .mcp.json
        : dirname(configPath); // global: ~/.claude/

      const settingsPath = configPath.endsWith('.mcp.json')
        ? join(projectDir, '.claude', 'settings.json') // project-local
        : configPath; // global uses same file (settings.json)

      // Read existing settings
      const settings = configPath.endsWith('.mcp.json')
        ? readConfigFile(settingsPath, 'json') // separate file for project-local
        : config; // same config object for global

      const permissions = (settings.permissions as Record<string, unknown>) || {};
      const allowList = (permissions.allow as string[]) || [];

      // Add agent-relay permission if not already present
      if (!allowList.includes('mcp__agent-relay__*')) {
        allowList.push('mcp__agent-relay__*');
      }

      permissions.allow = allowList;
      settings.permissions = permissions;

      // Write settings (separate file for project-local)
      if (configPath.endsWith('.mcp.json')) {
        writeConfigFile(settingsPath, settings, 'json');
      }
      // For global, permissions are added to same config object
    }

    // Write updated config
    writeConfigFile(configPath, config, configFormat);

    const editorName = editor?.name || editorKey || 'custom';
    return {
      editor: editorName,
      configPath,
      success: true,
      created,
    };
  } catch (err) {
    const editorName = editor?.name || editorKey || 'custom';
    return {
      editor: editorName,
      configPath,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      created: false,
    };
  }
}

/**
 * Uninstall MCP server configuration from an editor
 */
export function uninstallFromEditor(
  editorKey: string,
  options: { global?: boolean; projectDir?: string } = {}
): InstallResult {
  const editor = getEditorConfig(editorKey);

  if (!editor) {
    return {
      editor: editorKey,
      configPath: '',
      success: false,
      error: `Unknown editor: ${editorKey}`,
      created: false,
    };
  }

  // Determine config path
  let configPath = editor.configPath;
  if (!options.global && options.projectDir && editor.supportsLocal) {
    const localPath = getLocalConfigPath(editor, options.projectDir);
    if (localPath) {
      configPath = localPath;
    }
  }

  if (!existsSync(configPath)) {
    return {
      editor: editor.name,
      configPath,
      success: true,
      created: false,
    };
  }

  try {
    const config = readConfigFile(configPath, editor.format);

    const mcpServers = config[editor.configKey] as
      | Record<string, unknown>
      | undefined;
    if (mcpServers && 'agent-relay' in mcpServers) {
      delete mcpServers['agent-relay'];
      writeConfigFile(configPath, config, editor.format);
    }

    return {
      editor: editor.name,
      configPath,
      success: true,
      created: false,
    };
  } catch (err) {
    return {
      editor: editor.name,
      configPath,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      created: false,
    };
  }
}

/**
 * Check if agent-relay MCP server is installed for an editor
 */
export function isInstalledFor(
  editorKey: string,
  options: { global?: boolean; projectDir?: string } = {}
): boolean {
  const editor = getEditorConfig(editorKey);
  if (!editor) {
    return false;
  }

  let configPath = editor.configPath;
  if (!options.global && options.projectDir && editor.supportsLocal) {
    const localPath = getLocalConfigPath(editor, options.projectDir);
    if (localPath) {
      configPath = localPath;
    }
  }

  if (!existsSync(configPath)) {
    return false;
  }

  try {
    const config = readConfigFile(configPath, editor.format);
    const mcpServers = config[editor.configKey] as
      | Record<string, unknown>
      | undefined;
    return mcpServers !== undefined && 'agent-relay' in mcpServers;
  } catch {
    return false;
  }
}

/**
 * Install MCP server for all detected editors (or specified editors)
 */
export function install(options: InstallOptions = {}): InstallResult[] {
  const results: InstallResult[] = [];

  // Determine which editors to install for
  const editors = options.editor
    ? [options.editor]
    : detectInstalledEditors();

  if (editors.length === 0) {
    return [
      {
        editor: 'none',
        configPath: '',
        success: false,
        error: 'No supported editors detected',
        created: false,
      },
    ];
  }

  for (const editorKey of editors) {
    results.push(installForEditor(editorKey, options));
  }

  return results;
}

/**
 * Install MCP server configuration to a specific config file path.
 * This is a simpler API for programmatic/automated installation.
 *
 * @param configPath - Absolute path to config file
 * @param options - Optional settings for format, key, etc.
 */
export function installMcpConfig(
  configPath: string,
  options: {
    format?: 'json' | 'jsonc' | 'toml';
    configKey?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  } = {}
): InstallResult {
  return installForEditor('custom', {
    configPath,
    configFormat: options.format || 'json',
    configKey: options.configKey || 'mcpServers',
    command: options.command,
    args: options.args,
    env: options.env,
  });
}

/**
 * Uninstall MCP server from all detected editors (or specified editors)
 */
export function uninstall(options: InstallOptions = {}): InstallResult[] {
  const results: InstallResult[] = [];

  const editors = options.editor
    ? [options.editor]
    : detectInstalledEditors();

  for (const editorKey of editors) {
    results.push(
      uninstallFromEditor(editorKey, {
        global: options.global,
        projectDir: options.projectDir,
      })
    );
  }

  return results;
}
