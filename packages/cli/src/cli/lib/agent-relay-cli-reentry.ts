import path from 'node:path';

import { isBundledBunEntrypointPath } from './agent-relay-mcp-command.js';

/**
 * Build a child command that re-enters the Agent Relay CLI.
 *
 * Compiled Bun launches omit their virtual script path, while Node launches
 * retain an absolute script path that remains valid after the child changes cwd.
 *
 * @param input - Runtime executable, CLI entrypoint, subcommand arguments, and parent cwd.
 * @returns The executable and arguments to pass to the child process.
 */
export function resolveAgentRelayCliChildCommand(input: {
  execPath: string;
  cliEntrypoint: string;
  args: string[];
  cwd: string;
}): { command: string; args: string[] } {
  if (isBundledBunEntrypointPath(input.cliEntrypoint)) {
    return { command: input.execPath, args: input.args };
  }

  const cliEntrypoint = path.isAbsolute(input.cliEntrypoint)
    ? input.cliEntrypoint
    : path.resolve(input.cwd, input.cliEntrypoint);
  return { command: input.execPath, args: [cliEntrypoint, ...input.args] };
}

/**
 * Select an interpreter for a standalone JavaScript file launched by the CLI.
 *
 * @param input - Current runtime executable and CLI entrypoint.
 * @returns Node for compiled Bun, whose executable is the CLI rather than a script runtime; otherwise the current runtime.
 */
export function resolveAgentRelayScriptInterpreter(input: {
  execPath: string;
  cliEntrypoint: string;
}): string {
  return isBundledBunEntrypointPath(input.cliEntrypoint) ? 'node' : input.execPath;
}

/**
 * Build arguments for Relayflows v2's supported local run surface.
 *
 * @param workflowPath - Absolute path to the workflow file.
 * @param fileType - Workflow format used to determine whether v2 requires explicit input.
 * @param options - Explicit local executor selection; disabled by default.
 * @returns Arguments beginning with `flows run` for Agent Relay CLI re-entry.
 */
export function buildRelayflowsRunArgs(
  workflowPath: string,
  fileType: 'yaml' | 'ts',
  options: { localAgent?: boolean } = {}
): string[] {
  return [
    'flows',
    'run',
    workflowPath,
    ...(fileType === 'ts' ? ['--input', '{}'] : []),
    ...(options.localAgent ? ['--local-agent'] : []),
  ];
}
