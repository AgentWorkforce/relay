import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = new Map<string, string>();

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: vi.fn(() => '/home/test'),
  };
});

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(async (path: string) => {
    if (!files.has(path)) {
      throw new Error(`ENOENT: ${path}`);
    }
    return files.get(path)!;
  }),
  writeFile: vi.fn(async (path: string, data: string) => {
    files.set(path, data);
  }),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn((path: string) => files.has(path)),
  readFileSync: vi.fn((path: string) => {
    if (!files.has(path)) {
      throw new Error(`ENOENT: ${path}`);
    }
    return files.get(path)!;
  }),
}));

const registerRelaycastAgent = vi.fn();
const syncMcporterServers = vi.fn().mockResolvedValue({
  configured: true,
  tokenAction: 'provided',
});

vi.mock('../mcporter-config.js', () => ({
  registerRelaycastAgent,
  syncMcporterServers,
}));

describe('workspace config', () => {
  const workspacesPath = '/home/test/.openclaw/workspace/relaycast/workspaces.json';
  const gatewayEnvPath = '/home/test/.openclaw/workspace/relaycast/.env';

  beforeEach(() => {
    files.clear();
    vi.clearAllMocks();
    process.env.OPENCLAW_HOME = '/home/test/.openclaw';
    registerRelaycastAgent.mockResolvedValue({ agentToken: 'tok_new' });
    syncMcporterServers.mockResolvedValue({
      configured: true,
      tokenAction: 'provided',
      agentToken: 'tok_new',
    });
  });

  it('migrates legacy default selectors to canonical workspace ids on load', async () => {
    files.set(
      workspacesPath,
      JSON.stringify({
        workspaces: [
          {
            api_key: 'rk_live_a',
            workspace_alias: 'Team-A',
            workspace_id: 'ws_a',
            is_default: true,
          },
        ],
        default_workspace: 'Team-A',
      })
    );

    const { loadWorkspacesConfig } = await import('../config.js');
    const config = await loadWorkspacesConfig();

    expect(config).toEqual({
      workspaces: [
        {
          api_key: 'rk_live_a',
          workspace_alias: 'Team-A',
          workspace_id: 'ws_a',
          is_default: true,
        },
      ],
      default_workspace_id: 'ws_a',
    });
    expect(JSON.parse(files.get(workspacesPath)!)).toEqual({
      workspaces: [
        {
          api_key: 'rk_live_a',
          workspace_alias: 'Team-A',
          workspace_id: 'ws_a',
          is_default: true,
        },
      ],
      default_workspace_id: 'ws_a',
    });
  });

  it('rejects duplicate aliases case-insensitively', async () => {
    files.set(
      workspacesPath,
      JSON.stringify({
        workspaces: [
          {
            api_key: 'rk_live_a',
            workspace_alias: 'Team-A',
            workspace_id: 'ws_a',
            is_default: true,
          },
        ],
        default_workspace_id: 'ws_a',
      })
    );

    const { addWorkspace } = await import('../config.js');
    await expect(
      addWorkspace({
        api_key: 'rk_live_b',
        workspace_alias: 'team-a',
        workspace_id: 'ws_b',
      })
    ).rejects.toThrow(/Aliases must be unique/);
  });

  it('throws on ambiguous switch targets', async () => {
    files.set(
      workspacesPath,
      JSON.stringify({
        workspaces: [
          {
            api_key: 'rk_live_a',
            workspace_alias: 'shared',
            workspace_id: 'ws_a',
            is_default: true,
          },
          {
            api_key: 'rk_live_b',
            workspace_alias: 'team-b',
            workspace_id: 'shared',
            is_default: false,
          },
        ],
        default_workspace_id: 'ws_a',
      })
    );

    const { switchWorkspace } = await import('../config.js');
    await expect(switchWorkspace('shared')).rejects.toThrow(/ambiguous/);
  });

  it('switches by alias using canonical ids and preserves the claw name in .env', async () => {
    files.set(
      workspacesPath,
      JSON.stringify({
        workspaces: [
          {
            api_key: 'rk_live_a',
            workspace_alias: 'team-a',
            workspace_id: 'ws_a',
            is_default: true,
          },
          {
            api_key: 'rk_live_b',
            workspace_alias: 'team-b',
            workspace_id: 'ws_b',
            is_default: false,
          },
        ],
        default_workspace_id: 'ws_a',
      })
    );
    files.set(
      gatewayEnvPath,
      [
        'RELAY_API_KEY=rk_live_a',
        'RELAY_CLAW_NAME=my-claw',
        'RELAY_BASE_URL=https://api.relaycast.dev',
        'RELAY_CHANNELS=general',
        '',
      ].join('\n')
    );

    const { switchWorkspace } = await import('../config.js');
    const config = await switchWorkspace('team-b');

    expect(config?.default_workspace_id).toBe('ws_b');
    expect(files.get(gatewayEnvPath)).toContain('RELAY_API_KEY=rk_live_b');
    expect(files.get(gatewayEnvPath)).toContain('RELAY_CLAW_NAME=my-claw');
    expect(syncMcporterServers).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayConfig: expect.objectContaining({
          apiKey: 'rk_live_b',
          clawName: 'my-claw',
        }),
        workspacesConfig: expect.objectContaining({
          default_workspace_id: 'ws_b',
        }),
        agentToken: 'tok_new',
      })
    );
  });

  it('builds RELAY_WORKSPACES_JSON with canonical default_workspace_id', async () => {
    const { buildWorkspacesJson } = await import('../config.js');
    const json = buildWorkspacesJson({
      workspaces: [
        { api_key: 'rk_live_a', workspace_alias: 'team-a', workspace_id: 'ws_a' },
        { api_key: 'rk_live_b', workspace_alias: 'team-b', workspace_id: 'ws_b' },
      ],
      default_workspace_id: 'ws_b',
    });

    expect(JSON.parse(json!)).toEqual({
      memberships: [
        { api_key: 'rk_live_a', workspace_alias: 'team-a', workspace_id: 'ws_a' },
        { api_key: 'rk_live_b', workspace_alias: 'team-b', workspace_id: 'ws_b' },
      ],
      default_workspace_id: 'ws_b',
    });
  });
});
