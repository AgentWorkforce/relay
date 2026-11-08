import path from 'node:path';

import { isBundledBunEntrypointPath } from './agent-relay-mcp-command.js';

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

export function resolveAgentRelayScriptInterpreter(input: {
  execPath: string;
  cliEntrypoint: string;
}): string {
  return isBundledBunEntrypointPath(input.cliEntrypoint) ? 'node' : input.execPath;
}
