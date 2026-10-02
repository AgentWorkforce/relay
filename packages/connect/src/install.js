import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import { basename, join } from 'node:path';
import { requestJson } from './http.js';

const RELEASE = 'https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download';

export class InstallError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'InstallError';
    this.exitCode = exitCode;
  }
}

export function getPlatformAsset(platform = process.platform, arch = process.arch) {
  if (platform === 'linux') {
    if (arch === 'x64') return 'AgentRelay-Linux-x64.tar.gz';
    if (arch === 'arm64') return 'AgentRelay-Linux-arm64.tar.gz';
    throw new InstallError(`Unsupported Linux architecture: ${arch}`, 2);
  }
  if (platform === 'darwin') {
    if (arch === 'x64') return 'AgentRelay-macOS-x64.dmg';
    if (arch === 'arm64') return 'AgentRelay-macOS-arm64.dmg';
    throw new InstallError(`Unsupported macOS architecture: ${arch}`, 2);
  }
  throw new InstallError(`Unsupported platform: ${platform}`, 2);
}

export function downloadCommands(platform, tmpDir, asset) {
  const destination = join(tmpDir, asset);
  const checksum = `${destination}.sha256`;
  const commands = [
    ['curl', ['-fsSL', '--retry', '3', '-o', destination, `${RELEASE}/${asset}`]],
    ['curl', ['-fsSL', '--retry', '3', '-o', checksum, `${RELEASE}/${asset}.sha256`]],
  ];
  if (platform === 'linux') {
    commands.push(['sha256sum', ['--check', basename(checksum)]]);
  } else {
    commands.push(['shasum', ['-a', '256', '--check', basename(checksum)]]);
  }
  return commands;
}

export function macStageCommands({ volume, staged, app }) {
  return [
    ['ditto', [`${volume}/Agent Relay.app`, staged]],
    ['codesign', ['--verify', '--deep', '--strict', staged]],
    ['mv', [staged, app]],
    ['open', [app]],
  ];
}

export async function runCommand(file, args, { cwd, capture = false, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => reject(new InstallError(`Could not run ${file}: ${error.message}`)));
    child.on('close', (code) => {
      const result = {
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (result.code === 0 || allowFailure) resolve(result);
      else reject(new InstallError(`${file} failed with exit code ${result.code}.`));
    });
  });
}

export async function verifyChecksum(platform, tmpDir, asset, run = runCommand) {
  const command = downloadCommands(platform, tmpDir, asset)[2];
  try {
    await run(command[0], command[1], { cwd: tmpDir });
  } catch {
    throw new InstallError('Agent Relay checksum verification failed; refusing installation.');
  }
}

async function executableOnPath(command, envPath = process.env.PATH || '') {
  for (const directory of envPath.split(':').filter(Boolean)) {
    try {
      await access(join(directory, command), constants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

async function requireCommands(commands) {
  for (const command of commands) {
    if (!(await executableOnPath(command))) {
      throw new InstallError(`Missing prerequisite: ${command}`, 2);
    }
  }
}

async function readPointer(home) {
  try {
    const value = await readFile(join(home, '.agentworkforce/desktop/relay-socket'), 'utf8');
    return value.split(/\r?\n/, 1)[0].trim();
  } catch {
    return '';
  }
}

async function liveStatus(socketPath, timeoutMs = 5_000) {
  if (!socketPath) return null;
  try {
    const info = await stat(socketPath);
    if (!info.isSocket()) return null;
    const response = await requestJson(socketPath, {
      path: '/setup/status',
      timeoutMs,
    });
    if (response?.ok !== true || typeof response?.data?.version !== 'string' || !response.data.version) {
      return null;
    }
    return response;
  } catch {
    return null;
  }
}

export async function findLiveSocket(home = os.homedir(), timeoutMs = 5_000) {
  const socketPath = await readPointer(home);
  const status = await liveStatus(socketPath, timeoutMs);
  return status ? { socketPath, status } : null;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function waitForLiveSocket({
  home = os.homedir(),
  timeoutMs = 60_000,
  perRequestTimeoutMs = 5_000,
  now = Date.now,
  sleep = delay,
  pointer = readPointer,
  check = liveStatus,
} = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const socketPath = await pointer(home);
    const remaining = Math.max(1, deadline - now());
    const status = await check(socketPath, Math.min(perRequestTimeoutMs, remaining));
    if (status) return { socketPath, status };
    const sleepFor = Math.min(1_000, Math.max(0, deadline - now()));
    if (sleepFor > 0) await sleep(sleepFor);
  }
  throw new InstallError('Timed out waiting for the Agent Relay probe after 60 seconds.');
}

async function findProbe(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findProbe(path);
      if (nested) return nested;
    } else if (
      entry.isFile() &&
      entry.name === 'agent-relay-probe' &&
      path.includes(`${join('agent_relay', 'helpers')}`)
    ) {
      await access(path, constants.X_OK);
      return path;
    }
  }
  return null;
}

async function downloadAndVerify(platform, tmpDir, asset, run) {
  const commands = downloadCommands(platform, tmpDir, asset);
  await run(commands[0][0], commands[0][1]);
  await run(commands[1][0], commands[1][1]);
  await verifyChecksum(platform, tmpDir, asset, run);
}

async function installLinux({ home, arch, run }) {
  await requireCommands(['curl', 'sha256sum', 'tar']);
  const asset = getPlatformAsset('linux', arch);
  const tmpDir = await mkdtemp(join(os.tmpdir(), 'agent-relay-connect-'));
  let child;
  let ready = false;
  try {
    await downloadAndVerify('linux', tmpDir, asset, run);
    const installDir = join(home, '.local/lib/agent-relay/current');
    await mkdir(installDir, { recursive: true });
    await run('tar', ['-xzf', join(tmpDir, asset), '-C', installDir]);

    const probe = await findProbe(installDir);
    if (!probe) throw new InstallError(`agent-relay-probe not found or not executable in ${asset}.`);

    const binDir = join(home, '.local/bin');
    const desktopDir = join(home, '.agentworkforce/desktop');
    const link = join(binDir, 'agent-relay-probe');
    const pointer = join(desktopDir, 'relay-socket');
    await mkdir(binDir, { recursive: true });
    await mkdir(desktopDir, { recursive: true });
    await rm(link, { force: true });
    await symlink(probe, link);
    await rm(pointer, { force: true });

    const logHandle = await open(join(desktopDir, 'headless.log'), 'a', 0o600);
    try {
      child = spawn(link, ['relay', 'serve', '--headless'], {
        detached: true,
        stdio: ['ignore', logHandle.fd, logHandle.fd],
      });
      child.unref();
    } finally {
      await logHandle.close();
    }

    const result = await waitForLiveSocket({ home });
    ready = true;
    return result;
  } finally {
    if (!ready && child?.pid) {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {
        // The failed probe may already have exited.
      }
    }
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function processRunning(run) {
  const result = await run('pgrep', ['-x', 'RelayDesktop'], { allowFailure: true });
  return result.code === 0;
}

async function installMac({ home, arch, run, warn }) {
  await requireCommands([
    'codesign',
    'curl',
    'ditto',
    'hdiutil',
    'mv',
    'open',
    'osascript',
    'pgrep',
    'shasum',
  ]);
  const asset = getPlatformAsset('darwin', arch);
  const tmpDir = await mkdtemp(join(os.tmpdir(), 'agent-relay-connect-'));
  let volume = '';
  try {
    await downloadAndVerify('darwin', tmpDir, asset, run);
    const attached = await run('hdiutil', ['attach', '-nobrowse', '-readonly', join(tmpDir, asset)], {
      capture: true,
    });
    const volumeLine = attached.stdout.split(/\r?\n/).find((line) => line.includes('/Volumes/')) || '';
    const volumeIndex = volumeLine.indexOf('/Volumes/');
    volume = volumeIndex >= 0 ? volumeLine.slice(volumeIndex).trim() : '';
    if (!volume) throw new InstallError('Could not identify the mounted Agent Relay disk image.');

    if (await processRunning(run)) {
      try {
        await run('osascript', ['-e', 'tell application "Agent Relay" to quit']);
      } catch {
        throw new InstallError('Close any open Agent Relay sheet or dialog, quit the app, and retry.', 3);
      }
      const deadline = Date.now() + 30_000;
      while ((await processRunning(run)) && Date.now() < deadline) await delay(1_000);
      if (await processRunning(run)) {
        throw new InstallError('Agent Relay is still running; quit it and retry.', 3);
      }
    }

    let app = '/Applications/Agent Relay.app';
    try {
      await access('/Applications', constants.W_OK);
    } catch {
      const applications = join(home, 'Applications');
      await mkdir(applications, { recursive: true });
      app = join(applications, 'Agent Relay.app');
      warn(`Using the untested per-user Applications fallback: ${app}`);
    }

    const staged = `${app}.new`;
    await rm(staged, { recursive: true, force: true });
    const stage = macStageCommands({ volume, staged, app });
    await run(stage[0][0], stage[0][1]);
    await run('hdiutil', ['detach', volume]);
    volume = '';
    await run(stage[1][0], stage[1][1]);
    await rm(app, { recursive: true, force: true });
    await rename(staged, app);

    // Do not delete the existing pointer on macOS: RelayDesktop may reuse it.
    await run(stage[3][0], stage[3][1]);
    return await waitForLiveSocket({ home });
  } finally {
    if (volume) {
      await run('hdiutil', ['detach', volume], { allowFailure: true }).catch(() => {});
    }
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export async function ensureProbe({
  home = os.homedir(),
  platform = process.platform,
  arch = process.arch,
  run = runCommand,
  warn = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  const existing = await findLiveSocket(home);
  if (existing) return { ...existing, installed: false };

  const result =
    platform === 'linux'
      ? await installLinux({ home, arch, run })
      : platform === 'darwin'
        ? await installMac({ home, arch, run, warn })
        : (() => {
            throw new InstallError(`Unsupported platform: ${platform}`, 2);
          })();
  return { ...result, installed: true };
}
