import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, open, readdir, rename, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import { basename, join, relative } from 'node:path';
import { requestJson } from './http.js';

const RELEASE = 'https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download';
const MINIMUM_PROBE_VERSION = '2026.10.4';
const RECOVERY_TIMEOUT_MS = 15_000;

export class InstallError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'InstallError';
    this.exitCode = exitCode;
  }
}

export class OutdatedProbeError extends InstallError {
  constructor(version) {
    super(
      `Agent Relay ${version || 'unknown'} is too old for Relay Connect (needs ${MINIMUM_PROBE_VERSION} or newer); update it and retry.`,
      9
    );
    this.name = 'OutdatedProbeError';
    this.code = 'probe_too_old';
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
  const pointerPath = join(home, '.agentworkforce/desktop/relay-socket');
  let pointerHandle;
  try {
    pointerHandle = await open(pointerPath, 'r');
    const pointerInfo = await pointerHandle.stat();
    const uid = process.getuid?.();
    if (uid !== undefined && pointerInfo.uid !== uid) {
      throw new InstallError('Refusing an Agent Relay socket pointer not owned by the current user.');
    }
    if ((pointerInfo.mode & 0o022) !== 0) {
      throw new InstallError('Refusing a group- or world-writable Agent Relay socket pointer.');
    }

    const value = await pointerHandle.readFile('utf8');
    const socketPath = value.split(/\r?\n/, 1)[0].trim();
    if (!socketPath) return '';
    try {
      const socketInfo = await stat(socketPath);
      if (uid !== undefined && socketInfo.uid !== uid) {
        throw new InstallError('Refusing an Agent Relay socket not owned by the current user.');
      }
    } catch (error) {
      if (error instanceof InstallError) throw error;
      if (error?.code !== 'ENOENT') {
        throw new InstallError(`Could not inspect the Agent Relay socket: ${error.message}`);
      }
    }
    return socketPath;
  } catch (error) {
    if (error instanceof InstallError) throw error;
    if (error?.code !== 'ENOENT') {
      throw new InstallError(`Could not inspect the Agent Relay socket pointer: ${error.message}`);
    }
    return '';
  } finally {
    await pointerHandle?.close().catch(() => {});
  }
}

export function probeVersionSupported(version, minimum = MINIMUM_PROBE_VERSION) {
  const parse = (value) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\D.*)?$/.exec(value || '');
    return match ? match.slice(1).map(Number) : null;
  };
  const actual = parse(version);
  const required = parse(minimum);
  if (!actual || !required) return false;
  for (let index = 0; index < required.length; index += 1) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return true;
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
    return response?.ok === true ? response : null;
  } catch (error) {
    if (error instanceof InstallError) throw error;
    return null;
  }
}

export async function findLiveSocket(home = os.homedir(), timeoutMs = 5_000) {
  const socketPath = await readPointer(home);
  const status = await liveStatus(socketPath, timeoutMs);
  if (!status) return null;
  const version = status?.data?.version;
  return {
    socketPath,
    status,
    version,
    supported: probeVersionSupported(version),
  };
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
    if (status && probeVersionSupported(status?.data?.version)) return { socketPath, status };
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

export async function startDetachedProbe(link, logFd, spawnProcess = spawn) {
  const child = spawnProcess(link, ['relay', 'serve', '--headless'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (error) => {
      reject(new InstallError(`Could not start agent-relay-probe: ${error.message}`));
    });
  });
  return child;
}

async function swapWithBackup(destination, staged, { move = rename, remove = rm } = {}) {
  const backup = `${destination}.old`;
  await remove(backup, { recursive: true, force: true });
  let backedUp = false;
  try {
    await move(destination, backup);
    backedUp = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new InstallError(`Could not preserve the existing installation: ${error.message}`);
    }
  }

  try {
    await move(staged, destination);
  } catch (error) {
    if (backedUp) {
      try {
        await move(backup, destination);
      } catch (restoreError) {
        throw new InstallError(
          `Could not install the replacement or restore the previous installation: ${restoreError.message}`
        );
      }
    }
    throw new InstallError(`Could not install the replacement: ${error.message}`);
  }
  return { backup, backedUp };
}

async function restoreBackup(destination, swap, { move = rename, remove = rm } = {}) {
  if (!swap?.backedUp) return;
  await remove(destination, { recursive: true, force: true });
  try {
    await move(swap.backup, destination);
  } catch (error) {
    throw new InstallError(`Could not restore the previous installation: ${error.message}`);
  }
}

export async function installLinux({
  home,
  arch,
  run,
  start = startDetachedProbe,
  wait = waitForLiveSocket,
}) {
  await requireCommands(['curl', 'sha256sum', 'tar']);
  const asset = getPlatformAsset('linux', arch);
  const tmpDir = await mkdtemp(join(os.tmpdir(), 'agent-relay-connect-'));
  let child;
  let ready = false;
  let swap;
  const installRoot = join(home, '.local/lib/agent-relay');
  const installDir = join(installRoot, 'current');
  const stagedDir = join(installRoot, 'current.new');
  try {
    await downloadAndVerify('linux', tmpDir, asset, run);
    await mkdir(installRoot, { recursive: true });
    await rm(stagedDir, { recursive: true, force: true });
    await mkdir(stagedDir, { recursive: true });
    await run('tar', ['-xzf', join(tmpDir, asset), '-C', stagedDir]);

    const stagedProbe = await findProbe(stagedDir);
    if (!stagedProbe) throw new InstallError(`agent-relay-probe not found or not executable in ${asset}.`);
    const probeRelativePath = relative(stagedDir, stagedProbe);
    swap = await swapWithBackup(installDir, stagedDir);
    const probe = join(installDir, probeRelativePath);

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
      child = await start(link, logHandle.fd);
      child.unref();
    } finally {
      await logHandle.close();
    }

    const result = await wait({ home });
    ready = true;
    if (swap.backedUp) await rm(swap.backup, { recursive: true, force: true });
    return result;
  } finally {
    if (!ready && child?.pid) {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {
        // The failed probe may already have exited.
      }
    }
    if (!ready) await rm(join(home, '.agentworkforce/desktop/relay-socket'), { force: true });
    let restoreError;
    if (!ready) {
      try {
        await restoreBackup(installDir, swap);
      } catch (error) {
        restoreError = error;
      }
    }
    await rm(stagedDir, { recursive: true, force: true });
    await rm(tmpDir, { recursive: true, force: true });
    if (restoreError) throw restoreError;
  }
}

async function processRunning(run) {
  const result = await run('pgrep', ['-x', 'RelayDesktop'], { allowFailure: true });
  return result.code === 0;
}

async function relayProcessRunning(run = runCommand) {
  const checks = [
    ['-x', 'RelayDesktop'],
    ['-f', 'agent-relay-probe.*relay[[:space:]]+serve'],
  ];
  for (const args of checks) {
    try {
      const result = await run('pgrep', args, { allowFailure: true });
      if (result.code === 0) return true;
    } catch {
      // A live pointer is sufficient when pgrep is unavailable.
    }
  }
  return false;
}

async function pointerNamesSocket(home) {
  const socketPath = await readPointer(home);
  if (!socketPath) return false;
  try {
    return (await stat(socketPath)).isSocket();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw new InstallError(`Could not inspect the Agent Relay socket: ${error.message}`);
  }
}

export async function findRecoveringProbe({
  home = os.homedir(),
  find = findLiveSocket,
  run = runCommand,
  active,
  now = Date.now,
  sleep = delay,
  timeoutMs = RECOVERY_TIMEOUT_MS,
} = {}) {
  const deadline = now() + timeoutMs;
  let existing = await find(home, Math.min(1_000, timeoutMs));
  if (existing) return existing;

  const mayRecover = active
    ? await active(home)
    : (await pointerNamesSocket(home)) || (await relayProcessRunning(run));
  if (!mayRecover) return null;

  while (now() < deadline) {
    const sleepFor = Math.min(250, Math.max(0, deadline - now()));
    if (sleepFor > 0) await sleep(sleepFor);
    const remaining = Math.max(1, deadline - now());
    existing = await find(home, Math.min(1_000, remaining));
    if (existing) return existing;
  }
  return null;
}

function requireSupportedProbe(existing) {
  if (existing && existing.supported === false) throw new OutdatedProbeError(existing.version);
  return existing;
}

export async function swapMacApp(app, staged, { move = rename, remove = rm } = {}) {
  const swap = await swapWithBackup(app, staged, { move, remove });
  if (swap.backedUp) await remove(swap.backup, { recursive: true, force: true });
}

async function installMac({ home, arch, run, warn }) {
  await requireCommands(['codesign', 'curl', 'ditto', 'hdiutil', 'open', 'osascript', 'pgrep', 'shasum']);
  const asset = getPlatformAsset('darwin', arch);
  const tmpDir = await mkdtemp(join(os.tmpdir(), 'agent-relay-connect-'));
  let volume = '';
  let staged = '';
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

    staged = `${app}.new`;
    await rm(staged, { recursive: true, force: true });
    const stage = macStageCommands({ volume, staged, app });
    await run(stage[0][0], stage[0][1]);
    await run('hdiutil', ['detach', volume]);
    volume = '';
    await run(stage[1][0], stage[1][1]);
    await swapMacApp(app, staged);

    // Do not delete the existing pointer on macOS: RelayDesktop may reuse it.
    await run(stage[2][0], stage[2][1]);
    return await waitForLiveSocket({ home });
  } finally {
    if (volume) {
      await run('hdiutil', ['detach', volume], { allowFailure: true }).catch(() => {});
    }
    if (staged) await rm(staged, { recursive: true, force: true });
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export async function ensureProbe({
  home = os.homedir(),
  platform = process.platform,
  arch = process.arch,
  run = runCommand,
  warn = (message) => process.stderr.write(`${message}\n`),
  find = findLiveSocket,
  active,
  now = Date.now,
  sleep = delay,
  start = startDetachedProbe,
  wait = waitForLiveSocket,
  installLinuxFn = installLinux,
  installMacFn = installMac,
} = {}) {
  const existing = await findRecoveringProbe({ home, find, run, active, now, sleep });
  if (existing?.supported !== false) {
    if (existing) return { ...existing, installed: false };
  } else if (platform === 'linux') {
    requireSupportedProbe(existing);
  }

  const result =
    platform === 'linux'
      ? await installLinuxFn({ home, arch, run, start, wait })
      : platform === 'darwin'
        ? await installMacFn({ home, arch, run, warn })
        : (() => {
            throw new InstallError(`Unsupported platform: ${platform}`, 2);
          })();
  return { ...result, installed: true };
}

export async function requireExistingProbe(options = {}) {
  return requireSupportedProbe(await findRecoveringProbe(options));
}
