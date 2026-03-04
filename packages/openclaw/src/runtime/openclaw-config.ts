import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface OpenClawConfigOptions {
  /** Fully-qualified model ref, e.g. "openai-codex/gpt-5.3-codex". */
  modelRef: string;
  /** Path to ~/.openclaw/ (default: $HOME/.openclaw). */
  openclawHome?: string;
  /** Default workspace path (default: ~/.openclaw/workspace). */
  workspacePath?: string;
  /** MCP servers to include. Keys are server names, values are MCP server configs. */
  mcpServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
}

/**
 * Write (or update) ~/.openclaw/openclaw.json with model, workspace, skipBootstrap,
 * and MCP server configuration.
 */
export async function writeOpenClawConfig(options: OpenClawConfigOptions): Promise<void> {
  const home = options.openclawHome ?? join(process.env.HOME ?? '/home/node', '.openclaw');
  await mkdir(home, { recursive: true });

  const configPath = join(home, 'openclaw.json');
  let config: Record<string, unknown> = {};

  try {
    const raw = await readFile(configPath, 'utf8');
    config = JSON.parse(raw);
  } catch {
    // File doesn't exist or isn't valid JSON — start fresh
    config = {};
  }
  if (!config || typeof config !== 'object') config = {};

  // agents.defaults
  if (!config.agents || typeof config.agents !== 'object') config.agents = {};
  const agents = config.agents as Record<string, unknown>;
  if (!agents.defaults || typeof agents.defaults !== 'object') agents.defaults = {};
  const defaults = agents.defaults as Record<string, unknown>;

  if (!defaults.workspace || typeof defaults.workspace !== 'string') {
    defaults.workspace = options.workspacePath ?? '~/.openclaw/workspace';
  }

  // Model shape: { primary: "provider/model" }
  if (typeof defaults.model === 'string') {
    defaults.model = { primary: defaults.model };
  } else if (!defaults.model || typeof defaults.model !== 'object') {
    defaults.model = {};
  }
  (defaults.model as Record<string, string>).primary = options.modelRef;

  defaults.skipBootstrap = true;

  // MCP servers
  if (options.mcpServers) {
    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      config.mcpServers = {};
    }
    Object.assign(config.mcpServers as Record<string, unknown>, options.mcpServers);
  }

  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}
