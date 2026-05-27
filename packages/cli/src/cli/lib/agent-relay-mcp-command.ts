import path from 'node:path';

type ExistsSyncLike = (filePath: string) => boolean;

export function resolveBundledAgentRelayMcpScript(
  cliScript: string,
  existsSync: ExistsSyncLike
): string | null {
  const scriptDir = path.dirname(cliScript);
  for (const filename of ['agent-relay-mcp.js', 'relaycast-mcp.js']) {
    const candidate = path.join(scriptDir, filename);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
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

export const resolveBundledRelaycastMcpScript = resolveBundledAgentRelayMcpScript;
export const buildBundledRelaycastMcpCommand = buildBundledAgentRelayMcpCommand;
