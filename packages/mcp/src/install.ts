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

export interface EditorConfig {
  /** Display name for the editor */
  name: string;
  /** Path to the config file */
  configPath: string;
  /** Key in config object for MCP servers */
  configKey: string;
  /** Config file format */
  format: 'json' | 'jsonc';
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
      configPath: join(home, '.claude.json'),
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
 * Read and parse config file, handling both JSON and JSONC
 */
function readConfigFile(
  configPath: string,
  format: 'json' | 'jsonc'
): Record<string, unknown> {
  if (!existsSync(configPath)) {
    return {};
  }

  const content = readFileSync(configPath, 'utf-8');
  const jsonContent = format === 'jsonc' ? stripJsonComments(content) : content;

  try {
    // Handle empty or whitespace-only files
    const trimmed = jsonContent.trim();
    if (!trimmed) {
      return {};
    }
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Invalid JSON, start fresh
    return {};
  }
}

/**
 * Write config file with proper formatting
 */
function writeConfigFile(
  configPath: string,
  config: Record<string, unknown>
): void {
  const configDir = dirname(configPath);

  // Ensure directory exists
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
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

  if (!editor) {
    return {
      editor: editorKey,
      configPath: '',
      success: false,
      error: `Unknown editor: ${editorKey}`,
      created: false,
    };
  }

  // Determine config path (global vs local)
  let configPath = editor.configPath;
  if (!options.global && options.projectDir && editor.supportsLocal) {
    const localPath = getLocalConfigPath(editor, options.projectDir);
    if (localPath) {
      configPath = localPath;
    }
  }

  // Build server config
  const serverConfig: McpServerConfig = {
    command: options.command || 'npx',
    args: options.args || ['@agent-relay/mcp', 'serve'],
  };

  // Note: We don't set RELAY_PROJECT for local installs because the MCP server
  // will auto-discover the socket from the current working directory.
  // This makes the config portable across machines.

  if (options.dryRun) {
    return {
      editor: editor.name,
      configPath,
      success: true,
      created: !existsSync(configPath),
    };
  }

  try {
    // Read existing config
    const config = readConfigFile(configPath, editor.format);
    const created = !existsSync(configPath);

    // Initialize mcpServers if not present
    const configKeyValue = config[editor.configKey];
    if (!configKeyValue || typeof configKeyValue !== 'object') {
      (config as Record<string, unknown>)[editor.configKey] = {};
    }

    // Add agent-relay server config
    const mcpServers = config[editor.configKey] as Record<string, unknown>;
    mcpServers['agent-relay'] = serverConfig;

    // Write updated config
    writeConfigFile(configPath, config);

    return {
      editor: editor.name,
      configPath,
      success: true,
      created,
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
      writeConfigFile(configPath, config);
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
