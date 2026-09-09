import { createRequire } from 'node:module';
import path from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';

import { isBundledBunEntrypointPath } from './agent-relay-mcp-command.js';

const nodeRequire = createRequire(import.meta.url);

export type WorkflowRuntimeDependencies = {
  env: NodeJS.ProcessEnv;
  argv?: readonly string[];
  execPath?: string;
  cliScript?: string;
  execFile?: typeof nodeExecFile;
};

/** The argv shape emitted by a `bun build --compile` standalone binary. */
export function isCompiledBunWorkflowRuntime(deps: WorkflowRuntimeDependencies): boolean {
  return (
    (deps.argv ?? process.argv)[0] === 'bun' &&
    isBundledBunEntrypointPath(deps.cliScript ?? process.argv[1] ?? '')
  );
}

/**
 * Return the executable that should run a user workflow or generated monitor.
 *
 * A compiled Bun executable cannot execute a Node script by re-entering itself:
 * `process.execPath` is the standalone binary. Use an operator-selected Node
 * executable or PATH's `node` in that case. Regular Node and non-compiled
 * installs retain their existing process executable.
 */
export function workflowNodeExecutable(deps: WorkflowRuntimeDependencies): string {
  if (!isCompiledBunWorkflowRuntime(deps)) {
    return deps.execPath ?? process.execPath;
  }
  return deps.env.AGENT_RELAY_NODE?.trim() || 'node';
}

/**
 * Resolve relayflows from the directory containing the real workflow file.
 * This is essential for standalone binaries, whose bundled dependencies live
 * in a sealed `/$bunfs` image and cannot resolve the user's project install.
 */
export async function resolveRelayflowsCliEntrypoint(
  workflowPath: string,
  deps: WorkflowRuntimeDependencies
): Promise<string> {
  const resolvedWorkflowPath = path.resolve(workflowPath);
  try {
    if (!isCompiledBunWorkflowRuntime(deps)) {
      return nodeRequire.resolve('@relayflows/cli');
    }

    const execFile = deps.execFile ?? nodeExecFile;
    const node = workflowNodeExecutable(deps);
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        node,
        [
          '-e',
          'process.stdout.write(require.resolve(process.argv[1], { paths: [process.argv[2]] }))',
          '@relayflows/cli',
          path.dirname(resolvedWorkflowPath),
        ],
        {
          cwd: path.dirname(resolvedWorkflowPath),
          env: deps.env,
          windowsHide: true,
        },
        (error, output, stderr) => {
          if (error) {
            reject({ error, stderr });
            return;
          }
          resolve(output);
        }
      );
    });
    const entrypoint = stdout.trim();
    if (!entrypoint) {
      throw new Error(`Node did not return a path for @relayflows/cli from ${resolvedWorkflowPath}`);
    }
    return entrypoint;
  } catch (error) {
    const childError =
      error && typeof error === 'object' && 'error' in error ? (error as { error: unknown }).error : error;
    const detail = childError instanceof Error ? childError.message : String(childError);
    if (/\bENOENT\b|spawn .* not found|not found/i.test(detail)) {
      throw describeWorkflowChildError(childError, workflowNodeExecutable(deps));
    }
    throw new Error(
      `Cannot resolve @relayflows/cli from ${resolvedWorkflowPath}. ` +
        'Install @relayflows/cli in the workflow project (for example, npm install @relayflows/cli). ' +
        `Cause: ${detail}${
          error && typeof error === 'object' && 'stderr' in error
            ? ` ${(error as { stderr?: unknown }).stderr ?? ''}`.trim()
            : ''
        }`,
      { cause: error }
    );
  }
}

/** Add a useful hint when a child executable cannot be started. */
export function describeWorkflowChildError(error: unknown, command: string): Error {
  const detail = error instanceof Error ? error.message : String(error);
  if (/\bENOENT\b|spawn .* not found|not found/i.test(detail)) {
    return new Error(
      `Unable to start workflow child ${command}: ${detail}. ` +
        'A Node.js executable is required for standalone workflow execution; install Node.js or set AGENT_RELAY_NODE to its path.'
    );
  }
  return error instanceof Error ? error : new Error(detail);
}
