import path from 'node:path';

type ExistsSyncLike = (filePath: string) => boolean;

export function resolveBundledAgentRelayMcpScript(
  cliScript: string,
  existsSync: ExistsSyncLike
): string | null {
  const candidate = path.join(path.dirname(cliScript), 'agent-relay-mcp.js');
  return existsSync(candidate) ? candidate : null;
}

export function buildBundledAgentRelayMcpCommand(
  execPath: string,
  cliScript: string,
  existsSync: ExistsSyncLike
): string | null {
  const scriptPath = resolveBundledAgentRelayMcpScript(cliScript, existsSync);
  if (!scriptPath) {
    return null;
  }

  return `${execPath} ${scriptPath}`;
}
