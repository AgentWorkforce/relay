import path from 'node:path';

type ExistsSyncLike = (filePath: string) => boolean;

export function resolveBundledRelaycastMcpScript(
  cliScript: string,
  existsSync: ExistsSyncLike
): string | null {
  const candidate = path.join(path.dirname(cliScript), 'relaycast-mcp.js');
  return existsSync(candidate) ? candidate : null;
}

export function buildBundledRelaycastMcpCommand(
  execPath: string,
  cliScript: string,
  existsSync: ExistsSyncLike
): string | null {
  const scriptPath = resolveBundledRelaycastMcpScript(cliScript, existsSync);
  if (!scriptPath) {
    return null;
  }

  return `${execPath} ${scriptPath}`;
}
