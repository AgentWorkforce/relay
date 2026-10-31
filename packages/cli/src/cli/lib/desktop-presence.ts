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

/** What the desktop app or its headless service leaves on a machine, per platform. */
function desktopInstallMarkers(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  switch (platform) {
    case 'darwin':
      return ['/Applications/Agent Relay.app', path.join(home, 'Applications', 'Agent Relay.app')];
    case 'linux':
      return [
        '/usr/share/applications/agent-relay.desktop',
        '/usr/lib/systemd/user/agent-relay.service',
        // The per-user tarball: its launcher and unit sit inside this tree.
        env.AGENT_RELAY_PREFIX?.trim() || path.join(home, '.local', 'lib', 'agent-relay'),
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
 * @param env - The environment, for Windows' local app data folder.
 * @returns True when an install marker exists.
 */
export function desktopAppInstalled(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return desktopInstallMarkers(platform, home, env).some((marker) => fs.existsSync(marker));
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
