import { describe, expect, it } from 'vitest';

import {
  MCP_PREFLIGHT_REMEDIATION,
  REQUIRED_CLOUD_LOCAL_MOUNT_TOOLS,
  runMcpPreflight,
} from './mcp-preflight.js';

const FULL_TOOLS = [
  { name: 'cloud.agent.spawn' },
  { name: 'cloud.agent.list' },
  { name: 'cloud.local-mount.ensure' },
  { name: 'cloud.local-mount.status' },
  { name: 'cloud.local-mount.stop' },
];

describe('runMcpPreflight', () => {
  it('returns ok when all required cloud.local-mount.* tools are present', async () => {
    const result = await runMcpPreflight({
      listTools: () => FULL_TOOLS,
    });

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.remediation).toBeUndefined();
  });

  it('returns missing list and verbatim remediation when cloud.local-mount.ensure is absent', async () => {
    const partial = FULL_TOOLS.filter((t) => t.name !== 'cloud.local-mount.ensure');

    const result = await runMcpPreflight({
      listTools: () => partial,
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['cloud.local-mount.ensure']);
    expect(result.remediation).toBe(MCP_PREFLIGHT_REMEDIATION);
    expect(MCP_PREFLIGHT_REMEDIATION).toBe(
      'Upgrade `@relaycast/mcp` to a build that includes `cloud.local-mount.*` (see relaycast PR `feat/cloud-local-mount-tools`).'
    );
  });

  it('reports every missing tool when the MCP omits the whole local-mount surface', async () => {
    const result = await runMcpPreflight({
      listTools: () => [{ name: 'cloud.agent.spawn' }, { name: 'cloud.agent.list' }],
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([
      'cloud.local-mount.ensure',
      'cloud.local-mount.status',
      'cloud.local-mount.stop',
    ]);
    expect(result.remediation).toBe(MCP_PREFLIGHT_REMEDIATION);
  });

  it('exports the canonical required-tools tuple', () => {
    expect(REQUIRED_CLOUD_LOCAL_MOUNT_TOOLS).toEqual([
      'cloud.local-mount.ensure',
      'cloud.local-mount.status',
      'cloud.local-mount.stop',
    ]);
  });
});
