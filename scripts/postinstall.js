#!/usr/bin/env node
/**
 * Postinstall Script for agent-relay
 *
 * This script runs after npm install to:
 * 1. Install dashboard dependencies
 * 2. Patch agent-trajectories CLI
 * 3. Check for tmux availability
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
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
  // Ensure trail CLI captures agent info on start
  patchAgentTrajectories();

  // Always install dashboard dependencies (needed for build)
  installDashboardDeps();

  // Skip tmux check in CI environments
  if (process.env.CI === 'true') {
    return;
  }

  // Check if system tmux is available
  if (hasSystemTmux()) {
    info('System tmux found');
    return;
  }

  // Recommend user installs tmux manually
  warn('tmux not found on system');
  info('To use tmux mode, install tmux:');
  info('  macOS:  brew install tmux');
  info('  Ubuntu: sudo apt install tmux');
  info('  Or use PTY mode via the dashboard (no tmux required)');
}

main().catch((err) => {
  warn(`Postinstall warning: ${err.message}`);
});
