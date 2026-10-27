/**
 * Install-method detection and the per-method install steps behind
 * `agent-relay update`.
 *
 * The install method is read from the running executable, never guessed from
 * PATH: the binary that runs `update` is the one that must end up updated.
 *
 *   standalone  a Bun-compiled `agent-relay` in `<install root>/bin` (written by
 *               install.sh). Updated by running the target release's install.sh,
 *               pinned to that version, against the same install root.
 *   npm         `dist/cli/index.js` inside a `node_modules/agent-relay` package.
 *               Updated with `npm install -g agent-relay@<version>`.
 *   unknown     anything else (a source checkout, a copied binary); refused.
 */

import os from 'node:os';
import path from 'node:path';

import { RELAY_INSTALL_DIR_ENV, getRelayInstallDir } from '@agent-relay/harness-driver/install-paths';

import type { CoreDependencies } from '../commands/core.js';
import { isBundledBunEntrypointPath } from './agent-relay-mcp-command.js';

const RELEASE_REPO = 'AgentWorkforce/relay';
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const VERSION_IN_OUTPUT = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
const VERSION_CHECK_TIMEOUT_MS = 30_000;

export type InstallMethod =
  | { kind: 'standalone'; binaryPath: string; installRoot: string }
  | { kind: 'npm'; cliScript: string; globalPrefix?: string }
  | { kind: 'unknown'; reason: string };

type UpdateDeps = Pick<
  CoreDependencies,
  | 'cliScript'
  | 'execPath'
  | 'env'
  | 'fs'
  | 'pid'
  | 'log'
  | 'error'
  | 'execCommand'
  | 'execFileCommand'
  | 'runInheritedCommand'
  | 'fetchText'
>;

/** An update step failed; `message` is shown to the user as is. */
export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateError';
  }
}

/**
 * Whether `version` is a plain semver, and so safe to put in a URL or command.
 * @param version - Version string from the registry
 * @returns true for `1.2.3` or `1.2.3-next.0`
 */
export function isInstallableVersion(version: string): boolean {
  return VERSION_PATTERN.test(version);
}

function realpathOrResolve(deps: Pick<UpdateDeps, 'fs'>, filePath: string): string {
  try {
    return deps.fs.realpathSync?.(filePath) ?? path.resolve(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/**
 * Install roots a standalone binary may live under: the configured root
 * (`AGENT_RELAY_INSTALL_DIR` → `AGENT_RELAY_HOME` → default), the default root
 * (older installers ignored `AGENT_RELAY_HOME`) and the legacy `~/.agent-relay`.
 */
function candidateInstallRoots(env: NodeJS.ProcessEnv, home: string): string[] {
  const roots = [
    getRelayInstallDir(env, home),
    path.join(home, '.agentworkforce', 'relay'),
    path.join(home, '.agent-relay'),
  ];
  return [...new Set(roots)];
}

/**
 * Work out how the running CLI was installed, from the running executable.
 * @param deps - Process facts (argv[1], execPath, env) and a filesystem
 * @param home - Home directory (for the default and legacy install roots)
 * @returns The install method and the paths `update` must replace
 */
export function detectInstallMethod(
  deps: Pick<UpdateDeps, 'cliScript' | 'execPath' | 'env' | 'fs'>,
  home: string = os.homedir()
): InstallMethod {
  if (isBundledBunEntrypointPath(deps.cliScript)) {
    const binaryPath = realpathOrResolve(deps, deps.execPath);
    const binDir = path.dirname(binaryPath);
    for (const root of candidateInstallRoots(deps.env, home)) {
      if (realpathOrResolve(deps, path.join(root, 'bin')) === binDir) {
        return { kind: 'standalone', binaryPath, installRoot: path.dirname(binDir) };
      }
    }
    return {
      kind: 'unknown',
      reason:
        `this standalone binary (${binaryPath}) is not in an Agent Relay install directory ` +
        `(expected ${path.join(getRelayInstallDir(deps.env, home), 'bin')}; set ${RELAY_INSTALL_DIR_ENV} ` +
        'if you installed elsewhere)',
    };
  }

  const script = realpathOrResolve(deps, deps.cliScript);
  const marker = `${path.sep}node_modules${path.sep}agent-relay${path.sep}`;
  const markerAt = script.indexOf(marker);
  if (markerAt >= 0) {
    // A global install on Unix lives in `<prefix>/lib/node_modules`; pin npm to
    // that prefix so it updates this copy, not whichever prefix npm defaults to.
    const libDir = script.slice(0, markerAt);
    const globalPrefix = path.basename(libDir) === 'lib' ? path.dirname(libDir) : undefined;
    return { kind: 'npm', cliScript: script, ...(globalPrefix ? { globalPrefix } : {}) };
  }
  return {
    kind: 'unknown',
    reason: `the running CLI (${script}) is neither a standalone install nor an npm package (a source checkout?)`,
  };
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function npmInstallCommand(method: Extract<InstallMethod, { kind: 'npm' }>, version: string): string {
  const prefix = method.globalPrefix ? ` --prefix ${shellQuote(method.globalPrefix)}` : '';
  return `npm install -g${prefix} agent-relay@${version}`;
}

/**
 * The command a user can run by hand to install `version` with `method`.
 * @param method - Detected install method
 * @param version - Version to install
 * @returns A shell command line
 */
export function manualUpdateCommand(method: InstallMethod, version: string): string {
  if (method.kind === 'npm') {
    return npmInstallCommand(method, version);
  }
  const dirPrefix =
    method.kind === 'standalone' ? `${RELAY_INSTALL_DIR_ENV}=${shellQuote(method.installRoot)} ` : '';
  return `curl -fsSL https://raw.githubusercontent.com/${RELEASE_REPO}/v${version}/install.sh | ${dirPrefix}AGENT_RELAY_VERSION=${version} bash`;
}

/**
 * Version a binary reports for `--version`, or null when it cannot be run.
 * `AGENT_RELAY_VERSION` is removed from the child's environment because the
 * npm CLI reports that variable instead of its package version.
 */
async function reportedVersion(deps: UpdateDeps, file: string, args: string[]): Promise<string | null> {
  const env = { ...deps.env };
  delete env.AGENT_RELAY_VERSION;
  try {
    const { stdout, stderr } = await deps.execFileCommand(file, [...args, '--version'], {
      env,
      timeoutMs: VERSION_CHECK_TIMEOUT_MS,
    });
    return VERSION_IN_OUTPUT.exec(`${stdout}\n${stderr}`)?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Standalone update: run the release's own install.sh, pinned to `version`,
 * against the install root of the running binary. install.sh downloads the CLI
 * and broker, checks them against the SHA-256 digests GitHub publishes, smoke
 * tests them on temp files and swaps both in with renames as one transaction
 * (rolled back together on failure); relaycast-engine is installed from its
 * pinned, `.sha256`-verified release the same way. Afterwards the binaries in
 * the install root must report `version`.
 * @param deps - Update dependencies
 * @param method - Detected standalone install
 * @param version - Version to install
 * @throws UpdateError when the installer fails or the binaries do not report `version`
 */
export async function updateStandaloneInstall(
  deps: UpdateDeps,
  method: Extract<InstallMethod, { kind: 'standalone' }>,
  version: string
): Promise<void> {
  const url = `https://raw.githubusercontent.com/${RELEASE_REPO}/v${version}/install.sh`;
  deps.log(`Downloading the v${version} installer...`);
  let script: string;
  try {
    script = await deps.fetchText(url);
  } catch (err: unknown) {
    throw new UpdateError(`could not download ${url}: ${(err as Error)?.message ?? String(err)}`);
  }
  if (!script.startsWith('#!')) {
    throw new UpdateError(`${url} did not return an installer script`);
  }

  // The work dir sits in the install root, not TMPDIR: the root has to be
  // writable for the update anyway, and TMPDIR may not be (#1963).
  const workDir = path.join(method.installRoot, `.update-${deps.pid}`);
  const scriptPath = path.join(workDir, 'install.sh');
  let exitCode: number;
  try {
    deps.fs.mkdirSync(workDir, { recursive: true });
    deps.fs.writeFileSync(scriptPath, script, 'utf-8');
    deps.log(`Installing v${version} into ${path.join(method.installRoot, 'bin')}...`);
    exitCode = await deps.runInheritedCommand('bash', [scriptPath], {
      env: {
        ...deps.env,
        AGENT_RELAY_VERSION: version,
        [RELAY_INSTALL_DIR_ENV]: method.installRoot,
        // Fail instead of installing a second, npm-managed copy (honoured by
        // installers that include #1963; the version check below covers older ones).
        AGENT_RELAY_INSTALL_METHOD: 'standalone',
      },
    });
  } catch (err: unknown) {
    throw new UpdateError(`could not run the installer: ${(err as Error)?.message ?? String(err)}`);
  } finally {
    try {
      deps.fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
  if (exitCode !== 0) {
    throw new UpdateError(
      `the installer exited with status ${exitCode} (see its output above); check \`agent-relay --version\` and \`agent-relay-broker --version\` before retrying`
    );
  }

  const cliVersion = await reportedVersion(deps, method.binaryPath, []);
  if (cliVersion !== version) {
    throw new UpdateError(
      `the installer finished, but ${method.binaryPath} reports ${cliVersion ?? 'no version'} instead of ${version}`
    );
  }
  const broker = await standaloneBrokerVersion(deps, method);
  if (broker && broker.version !== version) {
    throw new UpdateError(
      `the CLI is now ${version}, but the broker at ${broker.path} reports ${broker.version ?? 'no version'}; re-run \`agent-relay update\` to repair it`
    );
  }
}

/**
 * Version of the broker beside a standalone CLI.
 * @param deps - Update dependencies
 * @param method - Detected standalone install
 * @returns The broker path and its reported version, or null when no broker is installed
 */
export async function standaloneBrokerVersion(
  deps: UpdateDeps,
  method: Extract<InstallMethod, { kind: 'standalone' }>
): Promise<{ path: string; version: string | null } | null> {
  const brokerPath = path.join(method.installRoot, 'bin', 'agent-relay-broker');
  if (!deps.fs.existsSync(brokerPath)) return null;
  return { path: brokerPath, version: await reportedVersion(deps, brokerPath, []) };
}

/**
 * npm update: `npm install -g agent-relay@<version>` (pinned to the prefix the
 * running CLI was installed into, when that is a global install), then the CLI
 * script that is running must report `version`.
 * @param deps - Update dependencies
 * @param method - Detected npm install
 * @param version - Version to install
 * @throws UpdateError when npm fails or the running CLI does not report `version`
 */
export async function updateNpmInstall(
  deps: UpdateDeps,
  method: Extract<InstallMethod, { kind: 'npm' }>,
  version: string
): Promise<void> {
  const command = npmInstallCommand(method, version);
  let output: { stdout: string; stderr: string };
  try {
    output = await deps.execCommand(command);
  } catch (err: unknown) {
    throw new UpdateError(`\`${command}\` failed: ${(err as Error)?.message ?? String(err)}`);
  }
  if (output.stdout.trim().length > 0) deps.log(output.stdout.trimEnd());
  if (output.stderr.trim().length > 0) deps.error(output.stderr.trimEnd());

  const installed = await reportedVersion(deps, deps.execPath, [method.cliScript]);
  if (installed !== version) {
    throw new UpdateError(
      `npm finished, but the CLI you ran (${method.cliScript}) reports ${installed ?? 'no version'} instead of ${version}; ` +
        'npm probably installed into a different global prefix (check `npm prefix -g`)'
    );
  }
}
