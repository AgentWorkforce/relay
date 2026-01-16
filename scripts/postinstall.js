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
    success(`Installed relay-pty binary for ${os.platform()}-${os.arch()}`);
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

/**
 * Main postinstall routine
 */
async function main() {
  // Install relay-pty binary for current platform (primary mode)
  const hasRelayPty = installRelayPtyBinary();

  // Ensure trail CLI captures agent info on start
  patchAgentTrajectories();

  // Always install dashboard dependencies (needed for build)
  installDashboardDeps();

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
