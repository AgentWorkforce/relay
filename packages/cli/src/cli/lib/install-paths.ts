/**
 * The canonical location of Agent Relay's native binaries.
 *
 * However Agent Relay is installed (`install.sh`, `npm i -g agent-relay`, the
 * desktop app), its binaries converge on one directory so the CLI and the
 * desktop app always run the same executables:
 *
 *   $AGENT_RELAY_INSTALL_DIR/bin     when AGENT_RELAY_INSTALL_DIR is set
 *   $AGENT_RELAY_HOME/bin            otherwise, when AGENT_RELAY_HOME is set
 *   ~/.agentworkforce/relay/bin      by default
 *
 * Reserved binary slots in that directory (`.exe` suffix on Windows):
 *
 *   agent-relay          standalone CLI (written by install.sh)
 *   relaycast-engine     local Relaycast server (install.sh, when published)
 *   agent-relay-probe    the Agent Relay core that injects messages into
 *                        running agent sessions (`relay init`, from a
 *                        `probe-v<version>` GitHub release)
 *
 * Older releases also installed `agent-relay-broker` there; it is no longer
 * installed or run, and an existing copy is left in place untouched.
 *
 * `install.sh` resolves the same directory, so the shell installer and the
 * runtime resolvers cannot disagree about where binaries live.
 */

import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const RELAYCAST_ENGINE_BINARY_NAME = 'relaycast-engine';
const PROBE_BINARY_NAME = 'agent-relay-probe';

/** Environment variable that relocates the whole install root. */
export const RELAY_INSTALL_DIR_ENV = 'AGENT_RELAY_INSTALL_DIR';
/** Relay home (credentials, state). Its `bin/` is used when no install dir is set. */
const RELAY_HOME_ENV = 'AGENT_RELAY_HOME';
/** Explicit path to an agent-relay-probe binary, used instead of the canonical slot. */
export const PROBE_PATH_ENV = 'AGENT_RELAY_PROBE_PATH';

type Env = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Executable file name for `name` on `platform` (`.exe` on Windows).
 * @param name - Binary base name, e.g. `agent-relay-probe`
 * @param platform - Target platform (defaults to the current one)
 * @returns The file name to look for on disk
 */
export function executableFileName(name: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

/**
 * Root of the Agent Relay install (`AGENT_RELAY_INSTALL_DIR` →
 * `AGENT_RELAY_HOME` → `~/.agentworkforce/relay`).
 * @param env - Environment to read overrides from
 * @param home - Home directory used for the default
 * @returns Absolute install root
 */
export function getRelayInstallDir(env: Env = process.env, home: string = homedir()): string {
  const explicit = nonEmpty(env[RELAY_INSTALL_DIR_ENV]) ?? nonEmpty(env[RELAY_HOME_ENV]);
  if (explicit) return resolve(explicit);
  return join(home, '.agentworkforce', 'relay');
}

/**
 * The canonical binary directory: `<install root>/bin`.
 * @param env - Environment to read overrides from
 * @param home - Home directory used for the default
 * @returns Absolute path of the canonical bin directory
 */
export function getRelayBinDir(env: Env = process.env, home: string = homedir()): string {
  return join(getRelayInstallDir(env, home), 'bin');
}

/**
 * Canonical path of the local Relaycast server binary (may not exist).
 * @param env - Environment to read overrides from
 * @param platform - Target platform
 * @returns `<bin>/relaycast-engine[.exe]`
 */
export function getCanonicalRelaycastEnginePath(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  return join(getRelayBinDir(env), executableFileName(RELAYCAST_ENGINE_BINARY_NAME, platform));
}

/**
 * Canonical path of the Agent Relay core (`agent-relay-probe`) binary (may not exist).
 * @param env - Environment to read overrides from
 * @param platform - Target platform
 * @returns `<bin>/agent-relay-probe[.exe]`
 */
export function getCanonicalProbePath(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  return join(getRelayBinDir(env), executableFileName(PROBE_BINARY_NAME, platform));
}

/**
 * Whether `filePath` looks runnable: a non-empty regular file that is
 * executable (the execute bit is not checked on Windows). Cheap enough for
 * every resolve; it does not execute the file.
 * @param filePath - Candidate binary
 * @returns true when the file can plausibly be launched
 */
export function isUsableBinary(filePath: string): boolean {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return false;
    if (process.platform !== 'win32') accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
