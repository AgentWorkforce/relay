import os from 'node:os';
import path from 'node:path';

import type { CoreDependencies, CoreFileSystem } from '../commands/core.js';
import { track } from '../telemetry/index.js';
import { readBrokerConnection } from './broker-lifecycle.js';
import { errorClassName } from './telemetry-helpers.js';

const SNIPPET_MARKER_START_PREFIX = '<!-- prpm:snippet:start @agent-relay/agent-relay-snippet@';
const SNIPPET_MARKER_END_PREFIX = '<!-- prpm:snippet:end @agent-relay/agent-relay-snippet@';
const SNIPPET_TARGET_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
const MCP_CONFIG_FILE = '.mcp.json';
const MCP_SERVER_KEY = 'agent-relay';
const LEGACY_MCP_SERVER_KEYS = ['relaycast'] as const;
const ZED_SETTINGS_PATH = path.join('.config', 'zed', 'settings.json');
const DEFAULT_ZED_SERVER_NAME = 'Agent Relay';
const INSTALL_DIR_NAMES = ['.agentworkforce/relay', '.agent-relay'] as const;
const STANDALONE_INSTALL_SCRIPT =
  'curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash';
const CLI_VERSION_TIMEOUT_MS = 30_000;

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
 * Remove the Agent Relay entry (and any legacy `relaycast` entry) from
 * .mcp.json if present. Returns true if the file was modified.
 */
function removeAgentRelayFromMcpConfig(
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
    if (!servers) {
      return false;
    }

    const keysToRemove = [MCP_SERVER_KEY, ...LEGACY_MCP_SERVER_KEYS].filter((key) => key in servers);
    if (keysToRemove.length === 0) {
      return false;
    }

    if (dryRun) {
      log(`[dry-run] Would remove ${keysToRemove.map((k) => `'${k}'`).join(', ')} from ${mcpPath}`);
      return true;
    }

    for (const key of keysToRemove) {
      delete servers[key];
    }

    // If mcpServers is now empty, remove the whole file.
    if (Object.keys(servers).length === 0 && Object.keys(parsed).length === 1) {
      fileSystem.unlinkSync(mcpPath);
      log(`Removed ${mcpPath} (no remaining servers)`);
    } else {
      fileSystem.writeFileSync(mcpPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
      log(`Removed ${keysToRemove.map((k) => `'${k}'`).join(', ')} from ${mcpPath}`);
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

/** Single-quote a value for safe interpolation into a POSIX shell command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safeRealpath(filePath: string, fileSystem: CoreFileSystem): string {
  try {
    return path.resolve(fileSystem.realpathSync(filePath));
  } catch {
    return path.resolve(filePath);
  }
}

/**
 * Resolve the active Bun standalone executable, including installs reached
 * through the ~/.local/bin launcher. npm installs execute node/bun with a real
 * JS cliScript, while compiled Bun binaries expose the embedded /$bunfs path.
 */
function resolveActiveStandaloneBinary(deps: CoreDependencies): string | null {
  const homeDir = os.homedir();
  const knownPaths = [
    ...INSTALL_DIR_NAMES.map((installDir) => path.join(homeDir, installDir, 'bin', 'agent-relay')),
    path.join(homeDir, '.local', 'bin', 'agent-relay'),
  ];
  const resolvedExecPath = safeRealpath(deps.execPath, deps.fs);
  const hasBunMarker = deps.cliScript.includes('/$bunfs/') || deps.cliScript.includes('\\$bunfs\\');
  const execName = path.basename(resolvedExecPath);
  const looksLikeStandaloneExecutable =
    hasBunMarker || execName === 'agent-relay' || execName.startsWith('agent-relay-');

  if (!looksLikeStandaloneExecutable) {
    return null;
  }

  for (const candidate of knownPaths) {
    if (deps.fs.existsSync(candidate) && safeRealpath(candidate, deps.fs) === resolvedExecPath) {
      return resolvedExecPath;
    }
  }

  // Support directly-invoked standalone binaries outside the installer paths.
  return hasBunMarker && deps.fs.existsSync(deps.execPath) ? resolvedExecPath : null;
}

function normalizeVersion(value: string): string {
  return value
    .trim()
    .replace(/^openclaw-v/, '')
    .replace(/^v/, '');
}

function parseCliVersion(output: string): string | null {
  const match = output.match(/(?:^|[^0-9])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/m);
  return match?.[1] ?? null;
}

async function readCliVersion(file: string, args: string[], deps: CoreDependencies): Promise<string> {
  const { stdout, stderr } = await deps.execFileCommand(file, args, {
    timeout: CLI_VERSION_TIMEOUT_MS,
  });
  const version = parseCliVersion(`${stdout}\n${stderr}`);
  if (!version) {
    throw new Error('The updated CLI did not report a valid version.');
  }
  return version;
}

function assertUpdatedVersion(
  installedVersion: string,
  requestedVersion: string,
  currentVersion: string
): void {
  const expectedVersion = requestedVersion === 'latest' ? null : normalizeVersion(requestedVersion);
  if (expectedVersion && installedVersion !== expectedVersion) {
    throw new Error(`The updated CLI reported ${installedVersion}, expected ${expectedVersion}.`);
  }
  if (installedVersion === normalizeVersion(currentVersion)) {
    throw new Error(`The active CLI still reports ${installedVersion} after the update.`);
  }
}

function standaloneAssetName(): string {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error(`Standalone updates are not supported on ${process.platform}.`);
  }
  if (process.arch !== 'x64' && process.arch !== 'arm64') {
    throw new Error(`Standalone updates are not supported on ${process.arch}.`);
  }
  return `agent-relay-${process.platform}-${process.arch}`;
}

function standaloneDownloadUrl(requestedVersion: string): string {
  const releasePath =
    requestedVersion === 'latest'
      ? 'latest/download'
      : `download/v${encodeURIComponent(normalizeVersion(requestedVersion))}`;
  return `https://github.com/AgentWorkforce/relay/releases/${releasePath}/${standaloneAssetName()}`;
}

async function updateStandaloneBinary(
  targetPath: string,
  requestedVersion: string,
  currentVersion: string,
  deps: CoreDependencies
): Promise<string> {
  // Keep the temporary download beside the target so mv(1) uses an atomic
  // same-filesystem rename. The launcher/symlink remains pointed at this path.
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.update-${deps.pid}`
  );
  try {
    if (deps.fs.existsSync(temporaryPath)) {
      deps.fs.unlinkSync(temporaryPath);
    }
    const downloadUrl = standaloneDownloadUrl(requestedVersion);
    await deps.execCommand(
      `curl -fsSL --retry 3 --retry-delay 1 ${shellQuote(downloadUrl)} -o ${shellQuote(temporaryPath)}`
    );
    await deps.execCommand(`chmod +x ${shellQuote(temporaryPath)}`);

    const downloadedVersion = await readCliVersion(temporaryPath, ['--version'], deps);
    assertUpdatedVersion(downloadedVersion, requestedVersion, currentVersion);

    await deps.execCommand(`mv -f ${shellQuote(temporaryPath)} ${shellQuote(targetPath)}`);
    const installedVersion = await readCliVersion(targetPath, ['--version'], deps);
    assertUpdatedVersion(installedVersion, requestedVersion, currentVersion);
    return installedVersion;
  } finally {
    if (deps.fs.existsSync(temporaryPath)) {
      try {
        deps.fs.unlinkSync(temporaryPath);
      } catch {
        // Best-effort cleanup; never mask the install or verification result.
      }
    }
  }
}

async function updateNpmInstall(
  requestedVersion: string,
  currentVersion: string,
  deps: CoreDependencies
): Promise<string> {
  // Installer output may contain registry credentials or private paths. Keep
  // it captured and only report the credential-safe remediation below.
  await deps.execCommand('npm install -g agent-relay@latest');

  const installedVersion = await readCliVersion(deps.execPath, [deps.cliScript, '--version'], deps);
  assertUpdatedVersion(installedVersion, requestedVersion, currentVersion);
  return installedVersion;
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
  const requestedVersion = info.latestVersion ?? 'latest';
  const standaloneTarget = resolveActiveStandaloneBinary(deps);
  try {
    const installedVersion = standaloneTarget
      ? await updateStandaloneBinary(standaloneTarget, requestedVersion, currentVersion, deps)
      : await updateNpmInstall(requestedVersion, currentVersion, deps);
    deps.log(`Successfully updated to ${installedVersion}`);
    track('cli_update', {
      from_version: currentVersion,
      to_version: installedVersion,
      success: true,
    });
  } catch (err: unknown) {
    const errorClass = errorClassName(err);
    track('cli_update', {
      from_version: currentVersion,
      to_version: requestedVersion,
      success: false,
      ...(errorClass ? { error_class: errorClass } : {}),
    });
    // Command errors can include environment-specific registry details. Keep
    // output actionable without reflecting raw command output or credentials.
    deps.warn('The update could not be installed and verified.');
    deps.log(
      standaloneTarget
        ? `Reinstall the standalone CLI manually: ${STANDALONE_INSTALL_SCRIPT}`
        : 'Try running manually: npm install -g agent-relay@latest'
    );
    deps.log('Then confirm with: agent-relay --version');
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
  const connectionPath = path.join(paths.dataDir, 'connection.json');

  // Kill the broker if running
  const conn = readBrokerConnection(paths.dataDir);
  if (conn && conn.pid > 0) {
    try {
      deps.killProcess(conn.pid, 'SIGTERM');
    } catch {
      // Ignore dead processes.
    }
  }

  const isDryRun = options.dryRun === true;

  // --- Data directory cleanup ---
  if (isDryRun) {
    if (options.keepData) {
      deps.log(`[dry-run] Would remove: ${connectionPath}`);
    } else {
      deps.log(`[dry-run] Would remove directory: ${paths.dataDir}`);
    }
  } else if (options.keepData) {
    for (const filePath of [connectionPath]) {
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

  // --- MCP config cleanup (.mcp.json agent-relay entry, plus legacy relaycast) ---
  removeAgentRelayFromMcpConfig(paths.projectRoot, deps.fs, isDryRun, deps.log);

  // --- Zed editor config cleanup ---
  if (options.zed) {
    const serverName = options.zedName || DEFAULT_ZED_SERVER_NAME;
    removeZedConfig(serverName, deps.fs, isDryRun, deps.log);
  }

  // --- Binary removal (standalone binaries + npm packages) ---
  const homeDir = os.homedir();
  const standaloneBinDir = path.join(homeDir, '.local', 'bin');
  const installBinDirs = INSTALL_DIR_NAMES.map((installDir) => path.join(homeDir, installDir, 'bin'));

  // Remove standalone binaries from ~/.local/bin
  for (const binaryName of ['agent-relay', 'relay-acp']) {
    const binPath = path.join(standaloneBinDir, binaryName);
    if (deps.fs.existsSync(binPath)) {
      if (isDryRun) {
        deps.log(`[dry-run] Would remove binary: ${binPath}`);
      } else {
        try {
          deps.fs.unlinkSync(binPath);
          deps.log(`Removed ${binPath}`);
        } catch {
          // Best-effort.
        }
      }
    }
  }

  // Remove installer bin dirs without deleting the parent data directories.
  for (const installBinDir of installBinDirs) {
    if (!deps.fs.existsSync(installBinDir)) {
      continue;
    }
    if (isDryRun) {
      deps.log(`[dry-run] Would remove directory: ${installBinDir}`);
    } else {
      try {
        deps.fs.rmSync(installBinDir, { recursive: true, force: true });
        deps.log(`Removed ${installBinDir}`);
      } catch {
        // Best-effort.
      }
    }
  }

  // Remove npm-installed packages
  if (!isDryRun) {
    for (const pkg of ['agent-relay']) {
      try {
        await deps.execCommand(`npm uninstall -g ${pkg}`);
        deps.log(`Uninstalled npm package: ${pkg}`);
      } catch {
        // Package may not be installed via npm — that's fine.
      }
    }
  } else {
    deps.log('[dry-run] Would run: npm uninstall -g agent-relay');
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
