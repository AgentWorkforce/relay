export const REQUIRED_CLOUD_LOCAL_MOUNT_TOOLS = [
  'cloud.local-mount.ensure',
  'cloud.local-mount.status',
  'cloud.local-mount.stop',
] as const;

export const MCP_PREFLIGHT_REMEDIATION =
  'Upgrade `@relaycast/mcp` to a build that includes `cloud.local-mount.*` (see relaycast PR `feat/cloud-local-mount-tools`).';

export interface McpToolDescriptor {
  name: string;
}

export interface McpPreflightResult {
  ok: boolean;
  missing: string[];
  remediation?: string;
}

export interface McpPreflightArgs {
  listTools: () => Promise<readonly McpToolDescriptor[]> | readonly McpToolDescriptor[];
  required?: readonly string[];
}

export async function runMcpPreflight(args: McpPreflightArgs): Promise<McpPreflightResult> {
  const required = args.required ?? REQUIRED_CLOUD_LOCAL_MOUNT_TOOLS;
  const tools = await args.listTools();
  const present = new Set(tools.map((t) => t.name));
  const missing = required.filter((name) => !present.has(name));

  if (missing.length === 0) {
    return { ok: true, missing: [] };
  }

  return {
    ok: false,
    missing,
    remediation: MCP_PREFLIGHT_REMEDIATION,
  };
}
