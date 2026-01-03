#!/usr/bin/env node
/**
 * Postinstall Script for agent-relay
 *
 * This script runs after npm install to:
 * 1. Rebuild native modules (better-sqlite3)
 * 2. Install tmux binary if not available on the system
 *
 * The tmux binary is installed within the package itself (bin/tmux),
 * making it portable and not requiring global installation.
 */

import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Get package root directory (parent of scripts/) */
function getPackageRoot() {
  return path.resolve(__dirname, '..');
}

/** Installation directory (within the package) */
function getInstallDir() {
  return path.join(getPackageRoot(), 'bin');
}

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
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

function error(msg) {
  console.log(`${colors.red}[error]${colors.reset} ${msg}`);
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
 * Get platform identifier for tmux-builds
 */
function getPlatformId() {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === 'darwin') {
    return arch === 'arm64' ? 'macos-arm64' : 'macos-x86_64';
  } else if (platform === 'linux') {
    return arch === 'arm64' ? 'linux-arm64' : 'linux-x86_64';
  }

  return null;
}

/**
 * Download file with redirect support
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);

    const request = (currentUrl, redirectCount = 0) => {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }

      const urlObj = new URL(currentUrl);
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        headers: {
          'User-Agent': 'agent-relay-installer',
        },
      };

      https
        .get(options, (response) => {
          if (response.statusCode === 302 || response.statusCode === 301) {
            const location = response.headers.location;
            if (location) {
              request(location, redirectCount + 1);
              return;
            }
          }

          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }

          response.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve();
          });
        })
        .on('error', reject);
    };

    request(url);
  });
}

/**
 * Install tmux binary
 */
async function installTmux() {
  const TMUX_VERSION = '3.6a';
  const INSTALL_DIR = getInstallDir();
  const tmuxPath = path.join(INSTALL_DIR, 'tmux');

  // Check if already installed
  if (fs.existsSync(tmuxPath)) {
    info('Bundled tmux already installed');
    return true;
  }

  const platformId = getPlatformId();
  if (!platformId) {
    const platform = os.platform();
    warn(`Unsupported platform: ${platform} ${os.arch()}`);
    if (platform === 'win32') {
      warn('tmux requires WSL (Windows Subsystem for Linux)');
      warn('Install WSL first, then run: sudo apt install tmux');
    } else {
      warn('Please install tmux manually: https://github.com/tmux/tmux/wiki/Installing');
    }
    return false;
  }

  info(`Installing tmux ${TMUX_VERSION} for ${platformId}...`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-tmux-'));
  const archiveName = `tmux-${TMUX_VERSION}-${platformId}.tar.gz`;
  const archivePath = path.join(tmpDir, archiveName);
  const downloadUrl = `https://github.com/tmux/tmux-builds/releases/download/v${TMUX_VERSION}/${archiveName}`;

  try {
    info('Downloading tmux binary...');
    await downloadFile(downloadUrl, archivePath);

    info('Extracting...');
    execSync(`tar -xzf "${archivePath}" -C "${tmpDir}"`, { stdio: 'pipe' });

    const extractedTmux = path.join(tmpDir, 'tmux');
    if (!fs.existsSync(extractedTmux)) {
      throw new Error('tmux binary not found in archive');
    }

    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    fs.copyFileSync(extractedTmux, tmuxPath);
    fs.chmodSync(tmuxPath, 0o755);

    success(`Installed tmux to ${tmuxPath}`);
    return true;
  } catch (err) {
    error(`Failed to install tmux: ${err.message}`);
    warn('Please install tmux manually, then reinstall: npm install agent-relay');
    return false;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
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
    error(`Failed to install dashboard dependencies: ${err.message}`);
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

  // Skip tmux install in CI environments where tmux isn't needed
  if (process.env.CI === 'true') {
    info('Skipping tmux install in CI environment');
    return;
  }

  // Check if system tmux is available
  if (hasSystemTmux()) {
    info('System tmux found');
    return;
  }

  // Try to install bundled tmux
  await installTmux();
}

main().catch((err) => {
  // Don't fail the install if tmux installation fails
  // User can still install tmux manually
  warn(`Postinstall warning: ${err.message}`);
});
