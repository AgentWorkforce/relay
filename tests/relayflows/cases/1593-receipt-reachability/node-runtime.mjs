import { spawnSync } from 'node:child_process';

const PINNED_NODE_VERSION = '22.14.0';
const BOOTSTRAP_MARKER = 'RELAY_PR_PROOF_NODE_BOOTSTRAPPED';

/**
 * Returns the replacement process exit code, or undefined when no replacement is needed.
 * @param {{
 *   moduleApi: { stripTypeScriptTypes?: unknown },
 *   scriptPath: string,
 *   env?: NodeJS.ProcessEnv,
 *   spawn?: (command: string, args: string[], options: import('node:child_process').SpawnSyncOptions) =>
 *     { status: number | null, signal?: string | null, error?: Error }
 * }} options
 */
export function ensureTypeStrippingRuntime({ moduleApi, scriptPath, env = process.env, spawn = spawnSync }) {
  if (typeof moduleApi.stripTypeScriptTypes === 'function') return undefined;
  if (env[BOOTSTRAP_MARKER]) {
    throw new Error(`Pinned Node.js ${PINNED_NODE_VERSION} did not provide stripTypeScriptTypes`);
  }
  // Fresh proof checkouts have no compiler dependencies. Older Node 22 runtimes
  // use a pinned Node executable in their isolated npm cache; supported runtimes
  // keep the dependency-free path. Installation/launch failure is infrastructure
  // failure, never an expected-red observation. The node package needs its
  // install script to provision the pinned executable, even when npm defaults
  // to ignore-scripts. This override applies only to this pinned invocation.
  const result = spawn(
    'npm',
    [
      'exec',
      '--yes',
      '--ignore-scripts=false',
      `--package=node@${PINNED_NODE_VERSION}`,
      '--',
      'node',
      scriptPath,
    ],
    {
      env: { ...env, [BOOTSTRAP_MARKER]: PINNED_NODE_VERSION },
      stdio: 'inherit',
      timeout: 120_000,
    }
  );
  if (result.error) {
    throw new Error(`Could not launch pinned Node.js ${PINNED_NODE_VERSION}`, { cause: result.error });
  }
  if (!Number.isInteger(result.status)) {
    throw new Error(
      `Pinned Node.js ${PINNED_NODE_VERSION} exited without a status (${result.signal ?? 'unknown signal'})`
    );
  }
  return result.status;
}
