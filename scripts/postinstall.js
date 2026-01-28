#!/usr/bin/env node
/**
 * Postinstall Script for agent-relay
 *
 * This script runs after npm install to:
 * 1. Install relay-pty binary for current platform
 * 2. Install dashboard dependencies
 * 3. Patch agent-trajectories CLI
 * 4. Check for tmux availability (fallback)
 */

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Get package root directory (parent of scripts/) */
function getPackageRoot() {
  return path.resolve(__dirname, '..');
}

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

function info(msg) {
  console.log(`${colors.blue}[info]${colors.reset} ${msg}`);
}

function success(msg) {
  console.log(`${colors.green}[success]${colors.reset} ${msg}`);
}

function warn(msg) {
  console.log(`${colors.yellow}[warn]${colors.reset} ${msg}`);
}

const nodeRequire = createRequire(import.meta.url);

function formatExecError(err) {
  if (!err) return 'Unknown error';

  const stderr = err.stderr ? String(err.stderr).trim() : '';
  const stdout = err.stdout ? String(err.stdout).trim() : '';
  if (stderr) return stderr.split('\n').slice(-8).join('\n');
  if (stdout) return stdout.split('\n').slice(-8).join('\n');
  if (err.message) return err.message;
  return String(err);
}

function writeStorageStatus(lines) {
  const statusDir = path.join(getPackageRoot(), '.agent-relay');
  const statusPath = path.join(statusDir, 'storage-status.txt');

  try {
    fs.mkdirSync(statusDir, { recursive: true });
    fs.writeFileSync(statusPath, `${lines.join('\n')}\n`, 'utf-8');
    return statusPath;
  } catch (err) {
    warn(
      `Failed to write storage status file: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}

function hasBuiltInNodeSqlite() {
  try {
    nodeRequire('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

function rebuildBetterSqlite3() {
  info('Rebuilding better-sqlite3 (SQLite driver)...');
  try {
    execSync('npm rebuild better-sqlite3', {
      cwd: getPackageRoot(),
      stdio: 'inherit',
    });
    success('better-sqlite3 rebuilt successfully');
    return { ok: true };
  } catch (err) {
    const message = formatExecError(err);
    warn(`better-sqlite3 rebuild failed: ${message}`);
    return { ok: false, message };
  }
}

function ensureSqliteDriver() {
  const rebuildResult = rebuildBetterSqlite3();
  const builtInAvailable = hasBuiltInNodeSqlite();
  const timestamp = new Date().toISOString();
  const baseStatus = [
    `node: ${process.version}`,
    `platform: ${os.platform()}-${os.arch()}`,
    `timestamp: ${timestamp}`,
  ];

  if (rebuildResult.ok) {
    const statusPath = writeStorageStatus([
      'status: ok',
      'driver: better-sqlite3',
      'detail: better-sqlite3 rebuilt successfully',
      ...baseStatus,
    ]);
    return { ok: true, driver: 'better-sqlite3', statusPath };
  }

  if (builtInAvailable) {
    const statusPath = writeStorageStatus([
      'status: degraded',
      'driver: node:sqlite',
      `detail: better-sqlite3 rebuild failed (${rebuildResult.message ?? 'unknown error'}), using built-in node:sqlite`,
      ...baseStatus,
    ]);
    return {
      ok: true,
      driver: 'node:sqlite',
      statusPath,
      error: rebuildResult.message,
    };
  }

  const detail = rebuildResult.message ?? 'unknown error';
  const statusPath = writeStorageStatus([
    'status: failed',
    'driver: none',
    `detail: better-sqlite3 rebuild failed (${detail}); no built-in node:sqlite available`,
    'fallback: in-memory storage',
    ...baseStatus,
  ]);

  return { ok: false, driver: 'none', statusPath, error: detail };
}

/**
 * Get the platform-specific binary name for relay-pty
 * Returns null if platform is not supported
 */
function getRelayPtyBinaryName() {
  const platform = os.platform();
  const arch = os.arch();

  // Map Node.js arch to Rust target arch
  const archMap = {
    'arm64': 'arm64',
    'x64': 'x64',
  };

  // Map Node.js platform to Rust target platform
  const platformMap = {
    'darwin': 'darwin',
    'linux': 'linux',
  };

  const targetPlatform = platformMap[platform];
  const targetArch = archMap[arch];

  if (!targetPlatform || !targetArch) {
    return null;
  }

  return `relay-pty-${targetPlatform}-${targetArch}`;
}

/**
 * Re-sign a binary with ad-hoc signature on macOS.
 * This is required because macOS code signature validation can fail
 * when binaries are copied/downloaded, causing SIGKILL on execution.
 *
 * The codesign tool is always available on macOS (part of the system).
 * This is a common solution for npm packages distributing native binaries.
 * Similar approach is used by esbuild, swc, and other Rust/Go tools.
 *
 * @param {string} binaryPath - Path to the binary to sign
 * @returns {boolean} - Whether signing succeeded
 */
function resignBinaryForMacOS(binaryPath) {
  if (os.platform() !== 'darwin') {
    return true; // Only needed on macOS
  }

  try {
    // codesign is always available on macOS as a system utility
    execSync(`codesign --force --sign - "${binaryPath}"`, { stdio: 'pipe' });
    return true;
  } catch (err) {
    // This shouldn't happen on a normal macOS system, but handle gracefully
    warn(`Failed to re-sign binary: ${err.message}`);
    warn('The binary may fail to execute due to code signature issues.');
    warn('You can manually fix this by running: codesign --force --sign - ' + binaryPath);
    return false;
  }
}

/**
 * Install the relay-pty binary for the current platform
 */
function installRelayPtyBinary() {
  const pkgRoot = getPackageRoot();
  const binaryName = getRelayPtyBinaryName();

  if (!binaryName) {
    warn(`Unsupported platform: ${os.platform()}-${os.arch()}`);
    warn('relay-pty binary not available, will fall back to tmux mode');
    return false;
  }

  const sourcePath = path.join(pkgRoot, 'bin', binaryName);
  const targetPath = path.join(pkgRoot, 'bin', 'relay-pty');

  // Check if platform-specific binary exists
  if (!fs.existsSync(sourcePath)) {
    warn(`relay-pty binary not found for ${os.platform()}-${os.arch()}`);
    warn('Will fall back to tmux mode');
    return false;
  }

  // Check if already installed (and is a symlink or copy of correct binary)
  if (fs.existsSync(targetPath)) {
    try {
      // Check if it's already the right binary by comparing size
      const sourceStats = fs.statSync(sourcePath);
      const targetStats = fs.statSync(targetPath);
      if (sourceStats.size === targetStats.size) {
        // Re-sign even if already installed to ensure signature is valid
        // This fixes issues where previous installs have invalid signatures
        resignBinaryForMacOS(targetPath);
        info('relay-pty binary already installed');
        return true;
      }
    } catch {
      // Continue to reinstall
    }
  }

  // Copy the binary (symlinks don't work well across npm install)
  try {
    fs.copyFileSync(sourcePath, targetPath);
    fs.chmodSync(targetPath, 0o755);

    // Re-sign the binary on macOS to prevent code signature validation failures
    // Without this, macOS may SIGKILL the process immediately on execution
    if (resignBinaryForMacOS(targetPath)) {
      success(`Installed relay-pty binary for ${os.platform()}-${os.arch()}`);
    } else {
      warn(`Installed relay-pty binary but signing failed - may not work on macOS`);
    }
    return true;
  } catch (err) {
    warn(`Failed to install relay-pty binary: ${err.message}`);
    return false;
  }
}

/**
 * Check if tmux is available on the system
 */
function hasSystemTmux() {
  try {
    execSync('which tmux', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Setup workspace package symlinks for global/bundled installs.
 *
 * When agent-relay is installed globally (npm install -g), the workspace packages
 * are included in the tarball at packages/* but Node.js module resolution expects
 * them at node_modules/@agent-relay/*. This function creates symlinks to bridge
 * the gap.
 *
 * This is needed because npm's bundledDependencies doesn't properly handle
 * workspace packages (which are symlinks during development).
 */
function setupWorkspacePackageLinks() {
  const pkgRoot = getPackageRoot();
  const packagesDir = path.join(pkgRoot, 'packages');
  const nodeModulesDir = path.join(pkgRoot, 'node_modules');
  const scopeDir = path.join(nodeModulesDir, '@agent-relay');

  // Check if packages/ exists (we're in a bundled/global install)
  if (!fs.existsSync(packagesDir)) {
    // Not a bundled install, workspace packages should be in node_modules already
    return { needed: false };
  }

  // Check if node_modules/@agent-relay/daemon exists
  const testPackage = path.join(scopeDir, 'daemon');
  if (fs.existsSync(testPackage)) {
    // Already set up (either normal npm install or previously linked)
    info('Workspace packages already available in node_modules');
    return { needed: false, alreadySetup: true };
  }

  // We need to create symlinks
  info('Setting up workspace package links for global install...');

  // Create node_modules/@agent-relay/ directory
  try {
    fs.mkdirSync(scopeDir, { recursive: true });
  } catch (err) {
    warn(`Failed to create @agent-relay scope directory: ${err.message}`);
    return { needed: true, success: false, error: err.message };
  }

  // Map from package directory name to npm package name
  const packageDirs = fs.readdirSync(packagesDir).filter(dir => {
    const pkgJsonPath = path.join(packagesDir, dir, 'package.json');
    return fs.existsSync(pkgJsonPath);
  });

  let linked = 0;
  let failed = 0;
  const errors = [];

  for (const dir of packageDirs) {
    const sourcePath = path.join(packagesDir, dir);
    const targetPath = path.join(scopeDir, dir);

    // Skip if already exists
    if (fs.existsSync(targetPath)) {
      continue;
    }

    try {
      // Use relative symlink for portability
      const relativeSource = path.relative(scopeDir, sourcePath);
      fs.symlinkSync(relativeSource, targetPath, 'dir');
      linked++;
    } catch (err) {
      // If symlink fails (e.g., on Windows without admin), try copying
      try {
        // Copy the package directory
        copyDirSync(sourcePath, targetPath);
        linked++;
      } catch (copyErr) {
        failed++;
        errors.push(`${dir}: ${copyErr.message}`);
      }
    }
  }

  if (linked > 0) {
    success(`Linked ${linked} workspace packages to node_modules/@agent-relay/`);
  }

  if (failed > 0) {
    warn(`Failed to link ${failed} packages: ${errors.join(', ')}`);
    return { needed: true, success: false, linked, failed, errors };
  }

  return { needed: true, success: true, linked };
}

/**
 * Recursively copy a directory
 */
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip node_modules in package copies
    if (entry.name === 'node_modules') {
      continue;
    }

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      // Resolve symlink and copy the target
      const linkTarget = fs.readlinkSync(srcPath);
      const resolvedTarget = path.resolve(path.dirname(srcPath), linkTarget);
      if (fs.existsSync(resolvedTarget)) {
        if (fs.statSync(resolvedTarget).isDirectory()) {
          copyDirSync(resolvedTarget, destPath);
        } else {
          fs.copyFileSync(resolvedTarget, destPath);
        }
      }
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Install dashboard dependencies
 */
function installDashboardDeps() {
  const dashboardDir = path.join(getPackageRoot(), 'src', 'dashboard');

  if (!fs.existsSync(dashboardDir)) {
    info('Dashboard directory not found, skipping');
    return;
  }

  const dashboardNodeModules = path.join(dashboardDir, 'node_modules');
  if (fs.existsSync(dashboardNodeModules)) {
    info('Dashboard dependencies already installed');
    return;
  }

  info('Installing dashboard dependencies...');
  try {
    execSync('npm install', { cwd: dashboardDir, stdio: 'inherit' });
    success('Dashboard dependencies installed');
  } catch (err) {
    warn(`Failed to install dashboard dependencies: ${err.message}`);
  }
}

/**
 * Patch agent-trajectories CLI to record agent info on start
 */
function patchAgentTrajectories() {
  const pkgRoot = getPackageRoot();
  const cliPath = path.join(pkgRoot, 'node_modules', 'agent-trajectories', 'dist', 'cli', 'index.js');

  if (!fs.existsSync(cliPath)) {
    info('agent-trajectories not installed, skipping patch');
    return;
  }

  const content = fs.readFileSync(cliPath, 'utf-8');

  // If already patched, exit early
  if (content.includes('--agent <name>') && content.includes('trajectory.agents.push')) {
    info('agent-trajectories already patched');
    return;
  }

  const optionNeedle = '.option("-t, --task <id>", "External task ID").option("-s, --source <system>", "Task system (github, linear, jira, beads)").option("--url <url>", "URL to external task")';
  const optionReplacement = `${optionNeedle}.option("-a, --agent <name>", "Agent name starting the trajectory").option("-r, --role <role>", "Agent role (lead, contributor, reviewer)")`;

  const createNeedle = `    const trajectory = createTrajectory({
      title,
      source
    });
    await storage.save(trajectory);`;

  const createReplacement = `    const agentName = options.agent || process.env.AGENT_NAME || process.env.AGENT_RELAY_NAME || process.env.USER || process.env.USERNAME;
    const agentRole = options.role || "lead";
    const trajectory = createTrajectory({
      title,
      source
    });
    if (agentName) {
      trajectory.agents.push({
        name: agentName,
        role: ["lead", "contributor", "reviewer"].includes(agentRole) ? agentRole : "lead",
        joinedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
    await storage.save(trajectory);`;

  if (!content.includes(optionNeedle) || !content.includes(createNeedle)) {
    warn('agent-trajectories CLI format changed, skipping patch');
    return;
  }

  const updated = content
    .replace(optionNeedle, optionReplacement)
    .replace(createNeedle, createReplacement);

  fs.writeFileSync(cliPath, updated, 'utf-8');
  success('Patched agent-trajectories to record agent on trail start');
}

function logPostinstallDiagnostics(hasRelayPty, sqliteStatus, linkResult) {
  // Workspace packages status (for global installs)
  if (linkResult && linkResult.needed) {
    if (linkResult.success) {
      console.log(`✓ Workspace packages linked (${linkResult.linked} packages)`);
    } else {
      console.log('⚠ Workspace package linking failed - CLI may not work');
    }
  }

  if (hasRelayPty) {
    console.log('✓ relay-pty binary installed');
  } else {
    console.log('⚠ relay-pty binary not installed - falling back to tmux mode if available');
  }

  if (sqliteStatus.ok && sqliteStatus.driver === 'better-sqlite3') {
    console.log('✓ SQLite ready (better-sqlite3)');
  } else if (sqliteStatus.ok && sqliteStatus.driver === 'node:sqlite') {
    console.log('⚠ better-sqlite3 rebuild failed - using built-in node:sqlite');
    console.log('  To fix: npm rebuild better-sqlite3 or upgrade to Node 22+');
  } else {
    console.log('⚠ SQLite installation failed - using fallback storage');
    console.log('  To fix: npm rebuild better-sqlite3 or upgrade to Node 22+');
  }

  if (sqliteStatus.statusPath) {
    info(`SQLite status written to ${sqliteStatus.statusPath}`);
  }
}

/**
 * Main postinstall routine
 */
async function main() {
  // Setup workspace package links for global installs
  // This MUST run first so that other postinstall steps can find the packages
  const linkResult = setupWorkspacePackageLinks();
  if (linkResult.needed && !linkResult.success) {
    warn('Workspace package linking failed - CLI may not work correctly');
    if (linkResult.errors) {
      linkResult.errors.forEach(e => warn(`  ${e}`));
    }
  }

  // Install relay-pty binary for current platform (primary mode)
  const hasRelayPty = installRelayPtyBinary();

  // Ensure SQLite driver is available (better-sqlite3 or node:sqlite)
  const sqliteStatus = ensureSqliteDriver();

  // Ensure trail CLI captures agent info on start
  patchAgentTrajectories();

  // Always install dashboard dependencies (needed for build)
  installDashboardDeps();

  // Always print diagnostics (even in CI)
  logPostinstallDiagnostics(hasRelayPty, sqliteStatus, linkResult);

  // Skip tmux check in CI environments
  if (process.env.CI === 'true') {
    return;
  }

  // If relay-pty is installed, we're good
  if (hasRelayPty) {
    info('Using relay-pty for agent communication (fast mode)');
    return;
  }

  // Fall back to tmux check
  if (hasSystemTmux()) {
    info('System tmux found (fallback mode)');
    return;
  }

  // Neither relay-pty nor tmux available
  warn('Neither relay-pty nor tmux available');
  info('Agent spawning will not work without one of:');
  info('  1. relay-pty binary (included for darwin-arm64, darwin-x64, linux-x64)');
  info('  2. tmux: brew install tmux (macOS) or apt install tmux (Linux)');
}

main().catch((err) => {
  warn(`Postinstall warning: ${err.message}`);
});
