import path from 'node:path';

type ExistsSyncLike = (filePath: string) => boolean;

function isBundledBunEntrypoint(cliScript: string): boolean {
  const normalized = cliScript.replace(/\\/g, '/');
  return normalized.startsWith('/$bunfs/root/') || /^[A-Z]:\/~BUN\/root\//i.test(normalized);
}

function quoteCommandPart(value: string): string {
  return /[\s"'\\]/.test(value) ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value;
}

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
  // Bun's compiled executable exposes argv[1] as a virtual /$bunfs path, so
  // there is no adjacent agent-relay-mcp.js for the Node-style path below to
  // find. Re-enter the already-installed standalone executable instead. This
  // keeps MCP startup local and deterministic instead of falling through to a
  // cold `npx -y agent-relay mcp` resolution.
  if (isBundledBunEntrypoint(cliScript)) {
    return `${quoteCommandPart(execPath)} mcp`;
  }

  const scriptPath = resolveBundledAgentRelayMcpScript(cliScript, existsSync);
  if (!scriptPath) {
    return null;
  }

  return `${quoteCommandPart(execPath)} ${quoteCommandPart(scriptPath)}`;
}
