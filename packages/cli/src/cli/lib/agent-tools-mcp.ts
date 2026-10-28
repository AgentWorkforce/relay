/**
 * Install the Relay MCP server (`agent-relay mcp`) into the agent tools Relay
 * supports, for `relay init`.
 *
 * Every entry is named `agent-relay`, the same name the broker uses when it
 * writes MCP configs for the agents it spawns (crates/broker/src/snippets.rs),
 * so a spawned agent's broker-provided entry replaces ours instead of running
 * a second Relay server beside it.
 *
 * Every entry we write carries `AGENT_RELAY_MANAGED_BY=relay-init` in its env.
 * That marker is how `relay init --uninstall` removes exactly what it added,
 * and how a re-run updates its own entry while leaving an `agent-relay` entry
 * the person wrote themselves alone. It works the same in every format (JSON
 * and TOML), including entries a tool's own `mcp add` command wrote for us.
 *
 * No credential is ever written into these files: `agent-relay mcp` resolves
 * the saved workspace and its bound server itself.
 *
 * This module has no TTY concerns; the guided flow lives in commands/init.ts.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isBundledBunEntrypointPath } from './agent-relay-mcp-command.js';

/** The agent tools `relay init` can connect. */
export const TOOL_IDS = ['claude', 'codex', 'opencode', 'grok', 'pi', 'devin'] as const;
export type ToolId = (typeof TOOL_IDS)[number];

/** Where an entry is installed: this project, or the user's global config. */
export type InstallScope = 'project' | 'global';

/** The MCP server name, shared with the broker. */
export const MCP_SERVER_NAME = 'agent-relay';
/** Env marker on every entry `relay init` writes. */
export const MANAGED_ENV_KEY = 'AGENT_RELAY_MANAGED_BY';
export const MANAGED_ENV_VALUE = 'relay-init';
/**
 * Env hint naming the tool the entry was installed for. `relay mcp` uses it to
 * name the session only when the client's own `clientInfo.name` is generic
 * (Devin reports the name of its MCP library, `rmcp`).
 */
export const CLIENT_ENV_KEY = 'AGENT_RELAY_CLIENT';

/** The command an agent tool runs to start the Relay MCP server. */
export interface McpLaunch {
  command: string;
  args: string[];
  /** Why this command was chosen, shown to the person. */
  reason: string;
  /** Set when the command may not outlive this run (an npx cache path). */
  warning?: string;
}

/** Paths and environment the installer resolves against; replaced in tests. */
export interface ToolContext {
  /** Project root for project scope. */
  projectRoot: string;
  home: string;
  env: NodeJS.ProcessEnv;
}

/** The real context for a project. */
export function defaultToolContext(projectRoot: string): ToolContext {
  return { projectRoot, home: os.homedir(), env: process.env };
}

type ConfigFormat = { kind: 'json'; container: 'mcpServers' | 'mcp' } | { kind: 'toml' };

/** How one agent tool takes an MCP server. */
export interface ToolTarget {
  id: ToolId;
  label: string;
  /** Executable name looked up on PATH. */
  binary: string;
  format: ConfigFormat;
  configPath(scope: InstallScope, ctx: ToolContext): string;
  /** Directories whose presence means the tool has been used on this machine. */
  detectPaths(ctx: ToolContext): string[];
  /** The tool's config entry for our server. */
  entry(launch: McpLaunch, env: Record<string, string>): Record<string, unknown>;
  /** Arguments for the tool's own `mcp add`, when it has one for this scope. */
  cliAdd?(scope: InstallScope, launch: McpLaunch, env: Record<string, string>): string[] | undefined;
  /** Something the person has to do before the tool loads the entry. */
  note?(scope: InstallScope, ctx: ToolContext): string | undefined;
}

function xdgConfigHome(ctx: ToolContext): string {
  const configured = ctx.env.XDG_CONFIG_HOME;
  return configured && path.isAbsolute(configured) ? configured : path.join(ctx.home, '.config');
}

function codexHome(ctx: ToolContext): string {
  const configured = ctx.env.CODEX_HOME;
  return configured && path.isAbsolute(configured) ? configured : path.join(ctx.home, '.codex');
}

function piAgentDir(ctx: ToolContext): string {
  const configured = ctx.env.PI_CODING_AGENT_DIR;
  return configured && path.isAbsolute(configured) ? configured : path.join(ctx.home, '.pi', 'agent');
}

function envFlags(flag: string, env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([key, value]) => [flag, `${key}=${value}`]);
}

const stdioEntry = (launch: McpLaunch, env: Record<string, string>) => ({
  command: launch.command,
  args: launch.args,
  env,
});

/** The supported tools, in the order they are offered. */
export const TOOL_TARGETS: readonly ToolTarget[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    binary: 'claude',
    format: { kind: 'json', container: 'mcpServers' },
    // `claude mcp add --scope project` writes .mcp.json; `--scope user` writes
    // the top-level mcpServers of ~/.claude.json.
    configPath: (scope, ctx) =>
      scope === 'project'
        ? path.join(ctx.projectRoot, '.mcp.json')
        : path.join(
            ctx.env.CLAUDE_CONFIG_DIR && path.isAbsolute(ctx.env.CLAUDE_CONFIG_DIR)
              ? ctx.env.CLAUDE_CONFIG_DIR
              : ctx.home,
            '.claude.json'
          ),
    detectPaths: (ctx) => [path.join(ctx.home, '.claude')],
    entry: (launch, env) => ({ type: 'stdio', ...stdioEntry(launch, env) }),
    // `-e` is variadic in claude's parser, so the name must come before it.
    cliAdd: (scope, launch, env) => [
      'mcp',
      'add',
      '--scope',
      scope === 'project' ? 'project' : 'user',
      MCP_SERVER_NAME,
      ...envFlags('-e', env),
      '--',
      launch.command,
      ...launch.args,
    ],
    note: (scope) =>
      scope === 'project'
        ? 'Claude Code asks you to approve the project .mcp.json server the first time it opens here.'
        : undefined,
  },
  {
    id: 'codex',
    label: 'Codex',
    binary: 'codex',
    format: { kind: 'toml' },
    // `codex mcp add` always writes $CODEX_HOME/config.toml. Codex also reads
    // .codex/config.toml in a project, but only once that exact project is
    // trusted in $CODEX_HOME/config.toml (see codexProjectTrust).
    configPath: (scope, ctx) =>
      scope === 'project'
        ? path.join(ctx.projectRoot, '.codex', 'config.toml')
        : path.join(codexHome(ctx), 'config.toml'),
    detectPaths: (ctx) => [codexHome(ctx)],
    entry: stdioEntry,
    cliAdd: (scope, launch, env) =>
      scope === 'global'
        ? ['mcp', 'add', ...envFlags('--env', env), MCP_SERVER_NAME, '--', launch.command, ...launch.args]
        : undefined,
    note: (scope, ctx) => (scope === 'project' ? codexTrustNote(ctx) : undefined),
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    binary: 'opencode',
    format: { kind: 'json', container: 'mcp' },
    // `opencode mcp add` is interactive only, so the config file is written.
    configPath: (scope, ctx) =>
      scope === 'project'
        ? path.join(ctx.projectRoot, 'opencode.json')
        : path.join(xdgConfigHome(ctx), 'opencode', 'opencode.json'),
    detectPaths: (ctx) => [path.join(xdgConfigHome(ctx), 'opencode')],
    entry: (launch, env) => ({
      type: 'local',
      command: [launch.command, ...launch.args],
      enabled: true,
      environment: env,
    }),
  },
  {
    id: 'grok',
    label: 'Grok CLI',
    binary: 'grok',
    format: { kind: 'toml' },
    configPath: (scope, ctx) =>
      scope === 'project'
        ? path.join(ctx.projectRoot, '.grok', 'config.toml')
        : path.join(ctx.home, '.grok', 'config.toml'),
    detectPaths: (ctx) => [path.join(ctx.home, '.grok')],
    entry: (launch, env) => ({ ...stdioEntry(launch, env), enabled: true }),
    // Grok takes the command positionally and its arguments after `--`.
    cliAdd: (scope, launch, env) => [
      'mcp',
      'add',
      MCP_SERVER_NAME,
      '--scope',
      scope === 'project' ? 'project' : 'user',
      ...envFlags('-e', env),
      launch.command,
      '--',
      ...launch.args,
    ],
  },
  {
    id: 'pi',
    label: 'Pi',
    binary: 'pi',
    format: { kind: 'json', container: 'mcpServers' },
    configPath: (scope, ctx) =>
      scope === 'project'
        ? path.join(ctx.projectRoot, '.pi', 'mcp.json')
        : path.join(piAgentDir(ctx), 'mcp.json'),
    detectPaths: (ctx) => [piAgentDir(ctx)],
    entry: stdioEntry,
    cliAdd: (scope, launch, env) => [
      'mcp',
      'add',
      MCP_SERVER_NAME,
      ...(scope === 'project' ? ['-l'] : []),
      ...envFlags('--env', env),
      '--',
      launch.command,
      ...launch.args,
    ],
    note: (scope) =>
      scope === 'project'
        ? 'Pi loads .pi/mcp.json only after you trust this project (it asks on first run).'
        : undefined,
  },
  {
    id: 'devin',
    label: 'Devin (local CLI)',
    binary: 'devin',
    format: { kind: 'json', container: 'mcpServers' },
    configPath: (scope, ctx) =>
      scope === 'project'
        ? path.join(ctx.projectRoot, '.devin', 'mcp_config.json')
        : path.join(xdgConfigHome(ctx), 'devin', 'mcp_config.json'),
    detectPaths: (ctx) => [path.join(xdgConfigHome(ctx), 'devin')],
    entry: (launch, env) => ({ ...stdioEntry(launch, env), transport: 'stdio' }),
    cliAdd: (scope, launch, env) => [
      'mcp',
      'add',
      MCP_SERVER_NAME,
      '--scope',
      scope === 'project' ? 'project' : 'user',
      ...envFlags('-e', env),
      '--',
      launch.command,
      ...launch.args,
    ],
  },
];

// ---------------------------------------------------------------------------
// Codex project trust
//
// Codex 0.154 reads <project>/.codex/config.toml (MCP servers included) only
// when that project has its own `[projects."<root>"] trust_level = "trusted"`
// table in $CODEX_HOME/config.toml. The root is the nearest directory with a
// `.git` (Codex's default project_root_markers), else the working directory.
// A trusted parent directory does not count, `-c projects...` overrides do not
// count, and `codex exec` never asks: only an interactive `codex` offers to
// trust the folder on first run.

/**
 * The directory Codex treats as this project's root, which is what it trusts.
 *
 * @param ctx - Project root, home and environment to resolve against.
 * @returns The real path of the nearest directory with a `.git`, else the project root.
 */
export function codexProjectRoot(ctx: ToolContext): string {
  const start = realpath(ctx.projectRoot) ?? path.resolve(ctx.projectRoot);
  let current = start;
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

/**
 * Codex's user config, where project trust is recorded.
 *
 * @param ctx - Home and environment (`CODEX_HOME`) to resolve against.
 * @returns `$CODEX_HOME/config.toml`, by default `~/.codex/config.toml`.
 */
export function codexUserConfigPath(ctx: ToolContext): string {
  return path.join(codexHome(ctx), 'config.toml');
}

/**
 * Split a TOML key (`projects."/repo"`, `"projects".'/repo'`) into its
 * decoded parts, or undefined when it is not a key this parser understands.
 */
function tomlKeyParts(raw: string): string[] | undefined {
  const parts: string[] = [];
  const segment = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;
  let index = 0;
  while (index < raw.length) {
    segment.lastIndex = index;
    const match = segment.exec(raw);
    if (!match) return undefined;
    if (match[1] !== undefined) {
      try {
        parts.push(JSON.parse(`"${match[1]}"`) as string);
      } catch {
        return undefined;
      }
    } else {
      parts.push(match[2] ?? match[3]);
    }
    index = segment.lastIndex;
    if (match[4] === '' && index < raw.length) return undefined;
    if (match[4] === '.' && index >= raw.length) return undefined;
  }
  return parts.length > 0 ? parts : undefined;
}

/** The key of a `[table]` header line, or undefined for any other line. */
function tomlTableKey(line: string): string[] | undefined {
  const match = TOML_HEADER.exec(line);
  return match && !line.trim().startsWith('[[') ? tomlKeyParts(match[1]) : undefined;
}

/** Whether a header line opens `[projects."<root>"]`, however the key is quoted. */
function isProjectTable(line: string, root: string): boolean {
  const key = tomlTableKey(line);
  return Boolean(key && key.length === 2 && key[0] === 'projects' && key[1] === root);
}

/** Codex's recorded trust for this project. */
export type CodexTrust = 'trusted' | 'untrusted' | 'unset';

/**
 * Whether Codex will read this project's `.codex/config.toml`.
 *
 * @param ctx - Project root, home and environment to resolve against.
 * @returns The trust level recorded for exactly this project's root.
 */
export function codexProjectTrust(ctx: ToolContext): CodexTrust {
  const root = codexProjectRoot(ctx);
  const text = readText(codexUserConfigPath(ctx));
  if (text === undefined) return 'unset';
  let inRoot = false;
  let trust: CodexTrust = 'unset';
  for (const line of text.split('\n')) {
    if (TOML_HEADER.test(line)) {
      inRoot = isProjectTable(line, root);
      continue;
    }
    if (!inRoot) continue;
    const value = /^\s*trust_level\s*=\s*["']([^"']*)["']/.exec(line)?.[1];
    if (value) trust = value === 'trusted' ? 'trusted' : 'untrusted';
  }
  return trust;
}

/**
 * Whether `projects` is declared anywhere other than `[projects.<path>]`
 * tables: a `[projects]` table, an inline table, dotted keys, or a header
 * this parser cannot read. Appending a table then could duplicate a key.
 */
function hasUneditableProjects(lines: string[]): boolean {
  let table: string[] | undefined = [];
  for (const line of lines) {
    if (TOML_HEADER.test(line)) {
      table = tomlTableKey(line);
      if (table === undefined && /projects/.test(line)) return true;
      if (table?.[0] === 'projects' && table.length !== 2) return true;
      continue;
    }
    const assignment = /^\s*([^=#]+?)\s*=/.exec(line);
    if (!assignment || table === undefined) continue;
    const key = [...table, ...(tomlKeyParts(assignment[1]) ?? [assignment[1]])];
    if (key[0] === 'projects' && table[0] !== 'projects') return true;
  }
  return false;
}

/**
 * Record this project as trusted in Codex's user config, as Codex's own
 * first-run prompt does. Trust also relaxes Codex's approval defaults in the
 * project, so callers ask first.
 *
 * @param ctx - Project root, home and environment to resolve against.
 * @throws When the config declares projects in a form this would have to
 *   restructure, rather than risk a config Codex cannot parse.
 */
export function trustCodexProject(ctx: ToolContext): void {
  const root = codexProjectRoot(ctx);
  const file = codexUserConfigPath(ctx);
  const text = readText(file) ?? '';
  const lines = text.split('\n');
  if (hasUneditableProjects(lines)) {
    throw new Error(
      `${file} declares projects in a form relay init does not edit; trust ${root} in Codex instead.`
    );
  }
  const header = `[projects.${JSON.stringify(root)}]`;
  const index = lines.findIndex((line) => isProjectTable(line, root));
  let next: string;
  if (index === -1) {
    const base = text.replace(/\n*$/, '');
    next = `${base}${base ? '\n\n' : ''}${header}\ntrust_level = "trusted"\n`;
  } else {
    let end = index + 1;
    while (end < lines.length && !TOML_HEADER.test(lines[end])) end += 1;
    const body = lines.slice(index + 1, end).filter((line) => !/^\s*trust_level\s*=/.test(line));
    next = [...lines.slice(0, index + 1), 'trust_level = "trusted"', ...body, ...lines.slice(end)].join('\n');
  }
  writeKeepingMode(file, next, 0o600);
}

/**
 * The step left before Codex loads the project entry, if any.
 *
 * @param ctx - Project root, home and environment to resolve against.
 * @returns A note for the person, or undefined when Codex already trusts the project.
 */
export function codexTrustNote(ctx: ToolContext): string | undefined {
  const trust = codexProjectTrust(ctx);
  if (trust === 'trusted') return undefined;
  const root = codexProjectRoot(ctx);
  if (trust === 'untrusted') {
    return (
      `Codex ignores .codex/config.toml here: ${root} is marked untrusted in ${codexUserConfigPath(ctx)}. ` +
      'Mark it trusted there, or run relay init --scope global for Codex.'
    );
  }
  return (
    `Codex reads .codex/config.toml only in projects it trusts, and ${root} is not trusted yet ` +
    '(a trusted parent folder does not count, and codex exec never asks). Open codex here once and trust ' +
    `the folder, or add these two lines to ${codexUserConfigPath(ctx)}:\n` +
    `    [projects.${JSON.stringify(root)}]\n    trust_level = "trusted"`
  );
}

/** Look up a supported tool. */
export function findToolTarget(id: string): ToolTarget | undefined {
  return TOOL_TARGETS.find((target) => target.id === id);
}

/**
 * Parse `--tools`: a comma list of tool ids, `all`, or `none`.
 *
 * @throws When an id is not a supported tool.
 */
export function parseToolsFlag(raw: string): ToolId[] {
  const values = [
    ...new Set(
      raw
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
  if (values.length === 0) throw new Error('--tools needs a value: a list of tools, all, or none.');
  if (values.includes('all') || values.includes('none')) {
    if (values.length > 1)
      throw new Error('--tools all and --tools none cannot be combined with tool names.');
    return values[0] === 'all' ? [...TOOL_IDS] : [];
  }
  const unknown = values.filter((value) => !findToolTarget(value));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown tool${unknown.length > 1 ? 's' : ''} for --tools: ${unknown.join(', ')}. ` +
        `Choose from ${TOOL_IDS.join(', ')}, all, or none.`
    );
  }
  return values as ToolId[];
}

/** Absolute path of an executable on PATH, without resolving symlinks. */
export function findOnPath(binary: string, env: NodeJS.ProcessEnv): string | undefined {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names =
    process.platform === 'win32'
      ? [binary, ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((ext) => binary + ext.toLowerCase())]
      : [binary];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function isExecutable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A tool and how it was found on this machine. */
export interface DetectedTool {
  id: ToolId;
  /** The executable on PATH, when there is one. */
  binaryPath?: string;
  /** The config directory that shows it was used, when there is one. */
  configDir?: string;
}

/**
 * Find which supported tools are installed: the executable is on PATH, or its
 * config directory exists.
 */
export function detectTools(ctx: ToolContext): DetectedTool[] {
  const found: DetectedTool[] = [];
  for (const target of TOOL_TARGETS) {
    const binaryPath = findOnPath(target.binary, ctx.env);
    const configDir = target.detectPaths(ctx).find((dir) => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
    if (binaryPath || configDir) found.push({ id: target.id, binaryPath, configDir });
  }
  return found;
}

/** Inputs to {@link resolveMcpLaunch}; `process` values by default. */
export interface LaunchInputs {
  ctx: ToolContext;
  /**
   * Where the entry goes. Project files are shared with everyone who clones
   * the project, so they get a command without machine-specific paths.
   * Defaults to `global`.
   */
  scope?: InstallScope;
  /** This CLI's version, pinned in an `npx` command. Defaults to AGENT_RELAY_CLI_VERSION. */
  version?: string;
  execPath?: string;
  /** The running CLI script (process.argv[1]). */
  script?: string;
  isBun?: boolean;
}

/** The npm package that provides `agent-relay mcp`. */
const NPM_PACKAGE = 'agent-relay';

function realpath(file: string): string | undefined {
  try {
    return fs.realpathSync(file);
  } catch {
    return undefined;
  }
}

/**
 * Whether a path is one npm or Bun may delete at any time: an npx/bunx cache copy.
 *
 * @param file - Path to check.
 * @returns True for paths under `_npx`, npm's `_cacache`, or a `bunx-` directory.
 */
export function isEphemeralPath(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  return (
    normalized.includes('/_npx/') || normalized.includes('/.npm/_cacache/') || normalized.includes('/bunx-')
  );
}

/** `agent-relay` on PATH, skipping the temporary bin directory npx puts first on PATH. */
function stableOnPath(env: NodeJS.ProcessEnv): string | undefined {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter((dir) => dir && !isEphemeralPath(`${dir}/`));
  return findOnPath('agent-relay', { ...env, PATH: dirs.join(path.delimiter) });
}

/** A usable npm version string, or undefined for unknown/dev builds. */
function publishedVersion(version: string | undefined): string | undefined {
  const trimmed = version?.trim();
  return trimmed && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(trimmed) && trimmed !== '0.0.0'
    ? trimmed
    : undefined;
}

/** `npx -y agent-relay@<version> mcp`: works on any machine with Node, and never goes stale. */
function npxLaunch(version: string | undefined, reason: string): McpLaunch {
  const pinned = publishedVersion(version);
  return {
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['-y', pinned ? `${NPM_PACKAGE}@${pinned}` : NPM_PACKAGE, 'mcp'],
    reason,
  };
}

/**
 * Choose the command agent tools run for `relay mcp`.
 *
 * `AGENT_RELAY_MCP_COMMAND`, the override the broker honours, always wins.
 * Otherwise a copy of the CLI that npx unpacked into its cache is never
 * written: npm deletes that cache at will, and its path is specific to this
 * machine (npx also puts its cache `bin` first on PATH, so a PATH lookup alone
 * would find it).
 *
 * Project scope writes files teammates share (.mcp.json and friends), so it
 * gets a portable command with no home-directory path:
 *
 * 1. `agent-relay mcp` when a lasting `agent-relay` is on PATH and this run is
 *    that install or a temporary npx copy.
 * 2. `npx -y agent-relay@<this version> mcp` when Relay is not installed.
 * 3. The running CLI by absolute path, for a source checkout.
 *
 * Global scope writes this machine's own config, so absolute paths are fine:
 *
 * 1. The running CLI's launcher (install.sh's bin directory) or the
 *    `agent-relay` on PATH that leads to it. Both survive upgrades.
 * 2. For a temporary npx copy: a lasting `agent-relay` on PATH, else
 *    `npx -y agent-relay@<this version> mcp`.
 * 3. The running CLI by absolute path.
 *
 * @param inputs - Tool context, scope, version, and (in tests) the running process.
 * @returns The command and arguments to write, why, and any warning to show.
 */
export function resolveMcpLaunch(inputs: LaunchInputs): McpLaunch {
  const { ctx } = inputs;
  const scope = inputs.scope ?? 'global';
  const execPath = inputs.execPath ?? process.execPath;
  const script = inputs.script ?? process.argv[1] ?? '';
  const isBun = inputs.isBun ?? Boolean(process.versions.bun);
  const version = inputs.version ?? ctx.env.AGENT_RELAY_CLI_VERSION;

  const override = ctx.env.AGENT_RELAY_MCP_COMMAND?.trim();
  if (override) {
    const [command, ...args] = override.split(/\s+/);
    return { command, args, reason: 'set by AGENT_RELAY_MCP_COMMAND' };
  }

  const binary = process.platform === 'win32' ? 'agent-relay.exe' : 'agent-relay';
  const launcherDirs = [
    ...(ctx.env.AGENT_RELAY_INSTALL_DIR ? [path.join(ctx.env.AGENT_RELAY_INSTALL_DIR, 'bin')] : []),
    path.join(ctx.home, '.agentworkforce', 'relay', 'bin'),
  ];
  const launcher = launcherDirs.map((dir) => path.join(dir, binary)).find(isExecutable);
  const onPath = stableOnPath(ctx.env);

  const standalone = isBun && isBundledBunEntrypointPath(script);
  const running = standalone ? execPath : script;
  const runningReal = running ? realpath(running) : undefined;
  const ephemeral = Boolean(
    running && (isEphemeralPath(running) || (runningReal && isEphemeralPath(runningReal)))
  );
  const isRunning = (file: string | undefined) =>
    Boolean(file && runningReal && realpath(file) === runningReal);

  if (scope === 'project') {
    if (onPath && (ephemeral || isRunning(onPath) || isRunning(launcher))) {
      return {
        command: 'agent-relay',
        args: ['mcp'],
        reason:
          'the agent-relay on PATH, by name, so the project file works on any machine with Relay installed',
      };
    }
    if (ephemeral || isRunning(launcher)) {
      return npxLaunch(
        version,
        'npx, because agent-relay is not on your PATH; the project file then works on any machine with Node.js'
      );
    }
  } else {
    if (launcher && isRunning(launcher)) {
      return { command: launcher, args: ['mcp'], reason: 'the Relay launcher install.sh keeps up to date' };
    }
    if (onPath && isRunning(onPath)) {
      return {
        command: onPath,
        args: ['mcp'],
        reason: 'the agent-relay on your PATH, so upgrading Relay updates it too',
      };
    }
    if (ephemeral) {
      if (onPath) {
        return {
          command: onPath,
          args: ['mcp'],
          reason: 'the agent-relay on your PATH (npx copies are temporary)',
        };
      }
      return npxLaunch(version, 'npx, because npx copies are temporary and agent-relay is not on your PATH');
    }
  }
  return {
    command: execPath,
    args: standalone ? ['mcp'] : [script, 'mcp'],
    reason: 'this copy of the Relay CLI, by absolute path',
    warning:
      scope === 'project'
        ? "The project files name this machine's copy of the Relay CLI by absolute path. Set " +
          'AGENT_RELAY_MCP_COMMAND, or install Relay so agent-relay is on your PATH, and run relay init again ' +
          'before sharing them.'
        : undefined,
  };
}

/** What happened for one tool. */
export interface ToolResult {
  id: ToolId;
  label: string;
  scope: InstallScope;
  path: string;
  status: 'installed' | 'updated' | 'unchanged' | 'removed' | 'absent' | 'kept' | 'failed';
  method?: 'cli' | 'file';
  message?: string;
}

/** A tool's own `mcp add`, run without a shell. Replaced in tests. */
export type RunTool = (
  binary: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => { status: number | null; output: string };

/** Run a tool's CLI with a time limit. */
export const defaultRunTool: RunTool = (binary, args, options) => {
  const result = spawnSync(binary, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? String(result.error.message) : ''}`;
  return { status: result.status, output: output.trim() };
};

// ---------------------------------------------------------------------------
// Reading and writing entries

/** Our entry as found in a config file. */
interface ExistingEntry {
  managed: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) if (typeof item === 'string') out[key] = item;
  return out;
}

function parseJsonObject(file: string, text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${file} is not plain JSON (${(error as Error).message}); it was left unchanged. ` +
        'Add the agent-relay server by hand, or fix the file and run relay init again.',
      { cause: error }
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain a JSON object; it was left unchanged.`);
  }
  return parsed as Record<string, unknown>;
}

function jsonServers(
  file: string,
  doc: Record<string, unknown>,
  container: string,
  create: boolean
): Record<string, unknown> | undefined {
  const servers = doc[container];
  if (servers === undefined) {
    if (!create) return undefined;
    const fresh: Record<string, unknown> = {};
    doc[container] = fresh;
    return fresh;
  }
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error(`${file}: "${container}" is not an object; it was left unchanged.`);
  }
  return servers as Record<string, unknown>;
}

function jsonEntry(target: ToolTarget, raw: unknown): ExistingEntry | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { managed: false };
  const record = raw as Record<string, unknown>;
  const env = stringRecord(target.id === 'opencode' ? record.environment : record.env);
  let command: string | undefined;
  let args: string[] | undefined;
  if (target.id === 'opencode') {
    if (Array.isArray(record.command) && record.command.every((part) => typeof part === 'string')) {
      [command, ...args] = record.command as string[];
    }
  } else {
    command = typeof record.command === 'string' ? record.command : undefined;
    args = Array.isArray(record.args)
      ? record.args.filter((arg): arg is string => typeof arg === 'string')
      : [];
  }
  return { managed: env?.[MANAGED_ENV_KEY] === MANAGED_ENV_VALUE, command, args, env };
}

/** Detect the indentation a JSON file uses, so a rewrite keeps its look. */
function jsonIndent(text: string): string | number {
  const match = /^[{[]\s*\n([ \t]+)\S/.exec(text);
  return match ? match[1] : 2;
}

// --- TOML (Codex, Grok) ----------------------------------------------------
//
// Only the `[mcp_servers.agent-relay]` table and its sub-tables are touched;
// every other line, comment included, is kept byte for byte.

// Quote-aware: a quoted key may contain `]`, as in [projects."/work/client[old]"].
const TOML_HEADER = /^\s*\[\[?\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\]"'])+?)\s*\]\]?\s*(?:#.*)?$/;
const TOML_TABLE = `mcp_servers.${MCP_SERVER_NAME}`;

function tomlKey(raw: string): string {
  return raw
    .split('.')
    .map((part) =>
      part
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .replace(/^'(.*)'$/, '$1')
    )
    .join('.');
}

interface TomlSection {
  key: string | null;
  start: number;
  end: number; // exclusive
}

function tomlSections(lines: string[]): TomlSection[] {
  const sections: TomlSection[] = [{ key: null, start: 0, end: lines.length }];
  lines.forEach((line, index) => {
    const match = TOML_HEADER.exec(line);
    if (!match) return;
    sections[sections.length - 1].end = index;
    sections.push({ key: tomlKey(match[1]), start: index, end: lines.length });
  });
  return sections;
}

function isOurTable(key: string | null): boolean {
  return key === TOML_TABLE || Boolean(key?.startsWith(`${TOML_TABLE}.`));
}

/** An `agent-relay` server declared inline or with dotted keys, which we never rewrite. */
function tomlHasForeignDefinition(lines: string[], sections: TomlSection[]): boolean {
  const name = `(?:${MCP_SERVER_NAME}|"${MCP_SERVER_NAME}"|'${MCP_SERVER_NAME}')`;
  const inMcp = new RegExp(`^\\s*${name}\\s*[.=]`);
  const dotted = new RegExp(`^\\s*mcp_servers\\s*\\.\\s*${name}\\s*[.=]`);
  return sections.some((section) => {
    const body = lines.slice(section.key === null ? section.start : section.start + 1, section.end);
    if (section.key === 'mcp_servers') return body.some((line) => inMcp.test(line));
    if (section.key === null) return body.some((line) => dotted.test(line));
    return false;
  });
}

function tomlValue(text: string): unknown {
  try {
    // A TOML basic string or array of them is valid JSON for the values we write.
    return JSON.parse(text.trim().replace(/,\s*]$/, ']'));
  } catch {
    return undefined;
  }
}

function tomlEntry(text: string): ExistingEntry | undefined {
  const lines = text.split('\n');
  const sections = tomlSections(lines);
  const ours = sections.filter((section) => isOurTable(section.key));
  if (ours.length === 0) {
    return tomlHasForeignDefinition(lines, sections) ? { managed: false } : undefined;
  }
  const entry: ExistingEntry = { managed: false, env: {} };
  for (const section of ours) {
    for (const line of lines.slice(section.start + 1, section.end)) {
      const match = /^\s*("?[A-Za-z0-9_.-]+"?)\s*=\s*(.+?)\s*$/.exec(line);
      if (!match) continue;
      const key = match[1].replace(/"/g, '');
      const value = tomlValue(match[2]);
      if (section.key === TOML_TABLE) {
        if (key === 'command' && typeof value === 'string') entry.command = value;
        if (key === 'args' && Array.isArray(value)) entry.args = value.map(String);
        if (key === 'env' && match[2].includes(MANAGED_ENV_KEY)) {
          entry.managed = new RegExp(`${MANAGED_ENV_KEY}\\s*=\\s*"${MANAGED_ENV_VALUE}"`).test(match[2]);
        }
      } else if (section.key === `${TOML_TABLE}.env` && typeof value === 'string') {
        entry.env![key] = value;
      }
    }
  }
  if (entry.env?.[MANAGED_ENV_KEY] === MANAGED_ENV_VALUE) entry.managed = true;
  return entry;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function renderToml(entry: Record<string, unknown>): string {
  const lines = [`[${TOML_TABLE}]`];
  const env = (entry.env ?? {}) as Record<string, string>;
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'env') continue;
    if (typeof value === 'string') lines.push(`${key} = ${tomlString(value)}`);
    else if (typeof value === 'boolean') lines.push(`${key} = ${value}`);
    else if (Array.isArray(value))
      lines.push(`${key} = [${value.map((v) => tomlString(String(v))).join(', ')}]`);
  }
  lines.push('', `[${TOML_TABLE}.env]`);
  for (const [key, value] of Object.entries(env)) lines.push(`${key} = ${tomlString(value)}`);
  return `${lines.join('\n')}\n`;
}

/** Remove our tables, keeping comments that introduce the next table. */
function tomlWithout(text: string): string {
  const lines = text.split('\n');
  const sections = tomlSections(lines);
  const drop = new Set<number>();
  for (const section of sections) {
    if (!isOurTable(section.key)) continue;
    let end = section.end;
    if (end < lines.length) {
      while (end - 1 > section.start && /^\s*(#.*)?$/.test(lines[end - 1])) end -= 1;
    }
    for (let index = section.start; index < end; index += 1) drop.add(index);
  }
  const kept = lines.filter((_, index) => !drop.has(index));
  const result = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
  return result ? `${result}\n` : '';
}

// --- Shared ------------------------------------------------------------------

function readEntry(target: ToolTarget, file: string): ExistingEntry | undefined {
  const text = readText(file);
  if (text === undefined) return undefined;
  if (target.format.kind === 'toml') return tomlEntry(text);
  const doc = parseJsonObject(file, text);
  const servers = jsonServers(file, doc, target.format.container, false);
  return jsonEntry(target, servers?.[MCP_SERVER_NAME]);
}

function sameEntry(existing: ExistingEntry, launch: McpLaunch, env: Record<string, string>): boolean {
  return (
    existing.managed &&
    existing.command === launch.command &&
    JSON.stringify(existing.args ?? []) === JSON.stringify(launch.args) &&
    Object.entries(env).every(([key, value]) => existing.env?.[key] === value)
  );
}

/**
 * Replace `file` atomically, keeping its permission bits (a new file gets
 * `fallbackMode`). The temporary file is in the same directory so the rename
 * never crosses a filesystem.
 */
export function writeKeepingMode(file: string, contents: string, fallbackMode = 0o644): void {
  let mode = fallbackMode;
  try {
    mode = fs.statSync(file).mode & 0o7777;
  } catch {
    // New file.
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, contents, { mode, flag: 'wx' });
  try {
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/** Mode for a new file: private for user-level tool state, readable otherwise. */
function newFileMode(target: ToolTarget, scope: InstallScope): number {
  return scope === 'global' && (target.id === 'claude' || target.id === 'devin') ? 0o600 : 0o644;
}

function writeEntryFile(
  target: ToolTarget,
  scope: InstallScope,
  file: string,
  launch: McpLaunch,
  env: Record<string, string>
): void {
  const text = readText(file);
  const entry = target.entry(launch, env);
  if (target.format.kind === 'toml') {
    const base = text === undefined ? '' : tomlWithout(text);
    const separator = base === '' ? '' : base.endsWith('\n\n') ? '' : base.endsWith('\n') ? '\n' : '\n\n';
    writeKeepingMode(file, `${base}${separator}${renderToml(entry)}`, newFileMode(target, scope));
    return;
  }
  const doc = text === undefined ? {} : parseJsonObject(file, text);
  if (text === undefined && target.id === 'opencode') doc.$schema = 'https://opencode.ai/config.json';
  const servers = jsonServers(file, doc, target.format.container, true)!;
  servers[MCP_SERVER_NAME] = entry;
  const indent = text === undefined ? 2 : jsonIndent(text);
  writeKeepingMode(file, `${JSON.stringify(doc, null, indent)}\n`, newFileMode(target, scope));
}

/**
 * Remove our entry. A file left holding nothing but an empty server list (one
 * relay init created) is deleted, as is its now-empty project directory.
 */
function removeEntryFile(target: ToolTarget, file: string, tidy = false): void {
  const text = readText(file);
  if (text === undefined) return;
  let next: string;
  let empty: boolean;
  if (target.format.kind === 'toml') {
    next = tomlWithout(text);
    empty = next.trim() === '';
  } else {
    const doc = parseJsonObject(file, text);
    const servers = jsonServers(file, doc, target.format.container, false);
    if (!servers) return;
    delete servers[MCP_SERVER_NAME];
    next = `${JSON.stringify(doc, null, jsonIndent(text))}\n`;
    const keys = Object.keys(doc).filter((key) => key !== '$schema');
    empty = Object.keys(servers).length === 0 && keys.length === 1 && keys[0] === target.format.container;
  }
  if (tidy && empty) {
    fs.rmSync(file, { force: true });
    try {
      fs.rmdirSync(path.dirname(file));
    } catch {
      // Not empty, or not ours to remove.
    }
    return;
  }
  writeKeepingMode(file, next);
}

/** Options shared by install and uninstall. */
export interface ToolOperation {
  ctx: ToolContext;
  scope: InstallScope;
  /** Use each tool's own CLI when it is on PATH. Defaults to true. */
  useToolCli?: boolean;
  runTool?: RunTool;
}

/** The env every entry carries. */
export function entryEnv(target: ToolTarget): Record<string, string> {
  return { [MANAGED_ENV_KEY]: MANAGED_ENV_VALUE, [CLIENT_ENV_KEY]: target.id };
}

/**
 * Install (or update) the Relay MCP server in one tool. Never throws: a
 * failure is reported in the result so the other tools still get set up.
 */
export function installTool(target: ToolTarget, launch: McpLaunch, op: ToolOperation): ToolResult {
  const file = target.configPath(op.scope, op.ctx);
  const base = { id: target.id, label: target.label, scope: op.scope, path: file };
  const env = entryEnv(target);
  try {
    const existing = readEntry(target, file);
    if (existing && !existing.managed) {
      return {
        ...base,
        status: 'kept',
        message: `${file} already has an "${MCP_SERVER_NAME}" server that relay init did not add; it was left as is.`,
      };
    }
    if (existing && sameEntry(existing, launch, env)) return { ...base, status: 'unchanged' };
    const status = existing ? 'updated' : 'installed';

    const binary = op.useToolCli === false ? undefined : findOnPath(target.binary, op.ctx.env);
    const cliArgs = binary ? target.cliAdd?.(op.scope, launch, env) : undefined;
    if (binary && cliArgs) {
      // `claude mcp add` refuses a name that exists, so drop our old entry first.
      if (existing) removeEntryFile(target, file);
      const run = (op.runTool ?? defaultRunTool)(binary, cliArgs, {
        cwd: op.ctx.projectRoot,
        env: { ...op.ctx.env, HOME: op.ctx.home },
      });
      const written = run.status === 0 ? readEntry(target, file) : undefined;
      if (written && sameEntry(written, launch, env)) return { ...base, status, method: 'cli' };
      // The CLI failed, or wrote somewhere else: fall back to the file itself.
    }
    writeEntryFile(target, op.scope, file, launch, env);
    return { ...base, status, method: 'file' };
  } catch (error) {
    return { ...base, status: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

/** Remove the entry `relay init` added to one tool, and nothing else. */
export function uninstallTool(target: ToolTarget, op: ToolOperation): ToolResult {
  const file = target.configPath(op.scope, op.ctx);
  const base = { id: target.id, label: target.label, scope: op.scope, path: file };
  try {
    const existing = readEntry(target, file);
    if (!existing) return { ...base, status: 'absent' };
    if (!existing.managed) {
      return {
        ...base,
        status: 'kept',
        message: `The "${MCP_SERVER_NAME}" server in ${file} was not added by relay init; it was left as is.`,
      };
    }
    removeEntryFile(target, file, true);
    return { ...base, status: 'removed', method: 'file' };
  } catch (error) {
    return { ...base, status: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}
