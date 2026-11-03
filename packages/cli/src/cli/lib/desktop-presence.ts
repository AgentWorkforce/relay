import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  connectCore,
  coreSocketPath,
  readCoreState,
  type CoreClient,
  type CoreStatus,
} from './probe-core.js';
import { originBindingsPath } from './relaycast-origin-binding.js';
import { isUsableBinary } from '@agent-relay/harness-driver/install-paths';

function subdirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/**
 * The binaries of a per-user Linux install: a headless core under `current`,
 * or the updater's `<version>/<tree>` copies of the app. The folder alone is
 * no sign of one, since `@agent-relay/connect` leaves it behind on removal.
 */
function linuxTreeMarkers(root: string): string[] {
  const app = path.join('usr', 'bin', 'agent-relay-desktop');
  const trees = subdirectories(root).flatMap((version) => subdirectories(version));
  return [path.join(root, 'current', 'agent-relay-probe'), ...trees.map((tree) => path.join(tree, app))];
}

/** What the desktop app or its headless service leaves on a machine, per platform. */
function desktopInstallMarkers(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  switch (platform) {
    case 'darwin':
      return ['/Applications/Agent Relay.app', path.join(home, 'Applications', 'Agent Relay.app')];
    case 'linux':
      return [
        '/usr/share/applications/agent-relay.desktop',
        '/usr/lib/systemd/user/agent-relay.service',
        ...linuxTreeMarkers(
          env.AGENT_RELAY_PREFIX?.trim() || path.join(home, '.local', 'lib', 'agent-relay')
        ),
        path.join(
          env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config'),
          'systemd',
          'user',
          'agent-relay.service'
        ),
      ];
    case 'win32': {
      const local = env.LOCALAPPDATA?.trim();
      return local ? [path.join(local, 'Programs', 'AgentRelay')] : [];
    }
    default:
      return [];
  }
}

/**
 * Whether the Agent Relay desktop app is installed, running or not. Its data
 * directories are no sign of it: a core `relay init` started creates them too.
 *
 * @param platform - The platform to check for.
 * @param home - The person's home directory.
 * @param env - The environment, for install locations it can move.
 * @param exists - How to test a path; replaced in tests.
 * @returns True when an install marker exists.
 */
export function desktopAppInstalled(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = fs.existsSync
): boolean {
  return desktopInstallMarkers(platform, home, env).some((marker) => exists(marker));
}

/** The macOS app's bundle id (`macos/Info.plist.template` in relay-desktop). */
export const DESKTOP_BUNDLE_ID = 'com.agentrelay.desktop';
/** The Linux systemd user unit that runs the desktop's headless core. */
export const DESKTOP_LINUX_UNIT = 'agent-relay.service';
const LINUX_LAUNCHER = 'agent-relay-desktop';

/** How {@link startDesktopCore} runs commands; replaced in tests. */
export interface DesktopStartEffects {
  /** Run a command to completion; its exit status, or null when it timed out or could not start. */
  run: (command: string, args: string[]) => number | null;
  /** Start a command detached, without waiting for it. */
  launch: (command: string, args: string[]) => void;
  /** Whether a file is there and can be run. */
  executable: (file: string) => boolean;
}

const defaultDesktopStartEffects: DesktopStartEffects = {
  run: (command, args) => spawnSync(command, args, { stdio: 'ignore', timeout: 15_000 }).status,
  launch: (command, args) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', env: process.env });
    child.on('error', () => undefined);
    child.unref();
  },
  executable: isUsableBinary,
};

/** The Linux app launchers on this machine: the package's, then per-user trees, newest first. */
function linuxLaunchers(home: string, env: NodeJS.ProcessEnv): string[] {
  const root = env.AGENT_RELAY_PREFIX?.trim() || path.join(home, '.local', 'lib', 'agent-relay');
  const trees = linuxTreeMarkers(root)
    .filter((file) => path.basename(file) === LINUX_LAUNCHER)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return [path.join('/usr', 'bin', LINUX_LAUNCHER), ...trees];
}

function shown(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

/**
 * The enabled systemd user unit, else the app's launcher in the tray when
 * there is a display. Never the launcher's `--headless`: a headless start
 * removes the person's GUI autostart entry, so one run over SSH into a Linux
 * desktop would cost them the tray app at login.
 */
function startLinuxDesktopCore(home: string, env: NodeJS.ProcessEnv, effects: DesktopStartEffects): string {
  if (effects.run('systemctl', ['--user', 'is-enabled', '--quiet', DESKTOP_LINUX_UNIT]) === 0) {
    const args = ['--user', 'start', DESKTOP_LINUX_UNIT];
    const status = effects.run('systemctl', args);
    if (status !== 0) throw new Error(`${shown('systemctl', args)} exited with ${status ?? 'no status'}`);
    return shown('systemctl', args);
  }
  if (!env.DISPLAY?.trim() && !env.WAYLAND_DISPLAY?.trim()) {
    throw new Error(
      `the desktop app's core needs ${DESKTOP_LINUX_UNIT} enabled, or a desktop session (DISPLAY or WAYLAND_DISPLAY)`
    );
  }
  // Only a launcher that can run: one that cannot is passed over, not started and waited on.
  const launcher = linuxLaunchers(home, env).find((file) => effects.executable(file));
  if (!launcher) {
    throw new Error(`${DESKTOP_LINUX_UNIT} is not enabled and no runnable ${LINUX_LAUNCHER} was found`);
  }
  const args = ['--background'];
  effects.launch(launcher, args);
  return shown(launcher, args);
}

/**
 * Ask the desktop app to start its own core, without waiting for it to answer.
 * On macOS the app opens in the background and hidden (`open -g -j -b`), and
 * registers and starts its core's LaunchAgent as it does on every launch. On
 * Linux an enabled systemd user unit is started; otherwise, in a desktop
 * session, the app's launcher runs in the tray. Without either it throws.
 * Windows has no start here: its logon task is off unless the person turned it on.
 *
 * @param platform - The platform to start it on.
 * @param home - The person's home directory.
 * @param env - The environment, for install locations and the display.
 * @param effects - How commands run; replaced in tests.
 * @returns The command that was run, or undefined when there is no way to start it here.
 * @throws When the start command failed.
 */
export function startDesktopCore(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  effects: DesktopStartEffects = defaultDesktopStartEffects
): string | undefined {
  switch (platform) {
    case 'darwin': {
      const args = ['-g', '-j', '-b', DESKTOP_BUNDLE_ID];
      const status = effects.run('open', args);
      if (status !== 0) throw new Error(`${shown('open', args)} exited with ${status ?? 'no status'}`);
      return shown('open', args);
    }
    case 'linux':
      return startLinuxDesktopCore(home, env, effects);
    default:
      return undefined;
  }
}

/**
 * Whether a core `relay init` did not start is running: the desktop app's or
 * a service's. One that answers but cannot be read counts.
 *
 * @param connect - How to reach the core; replaced in tests.
 * @returns True for a core with no matching record.
 */
export async function foreignCoreRunning(
  connect: (socket: string) => Promise<CoreClient | undefined> = (socket) => connectCore(socket)
): Promise<boolean> {
  let client: CoreClient | undefined;
  try {
    client = await connect(coreSocketPath(process.env, os.homedir()));
    if (!client) return false;
    const status = await client.call<CoreStatus>('status.get');
    const state = readCoreState(path.join(path.dirname(originBindingsPath()), 'local', 'core.json'));
    return state?.pid !== status.daemon.pid;
  } catch {
    return true;
  } finally {
    client?.close();
  }
}

/**
 * Whether this machine's agents depend on the desktop app's core, which
 * serves cast.agentrelay.com only.
 *
 * @returns True when the app is installed or a core init did not start runs.
 */
export async function desktopPresent(): Promise<boolean> {
  return desktopAppInstalled() || (await foreignCoreRunning());
}
