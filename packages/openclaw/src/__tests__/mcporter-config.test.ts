import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = new Map<string, string>();
const execFileSync = vi.fn();
const registerOrGet = vi.fn();

vi.mock('node:child_process', () => ({
  execFileSync,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: vi.fn(() => '/home/test'),
  };
});

vi.mock('node:fs', () => ({
  existsSync: vi.fn((path: string) => files.has(path)),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (path: string) => {
    if (!files.has(path)) {
      throw new Error(`ENOENT: ${path}`);
    }
    return files.get(path)!;
  }),
}));

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn().mockImplementation(() => ({
    agents: {
      registerOrGet,
    },
  })),
}));

vi.mock('../config.js', () => ({
  buildWorkspacesJson: vi.fn((config: { default_workspace_id?: string }) =>
    JSON.stringify({
      memberships: [{ api_key: 'rk_live_a', workspace_id: 'ws_a', workspace_alias: 'team-a' }],
      ...(config.default_workspace_id
        ? { default_workspace_id: config.default_workspace_id }
        : {}),
    })
  ),
}));

describe('mcporter config helpers', () => {
  beforeEach(() => {
    files.clear();
    vi.clearAllMocks();
    execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return '1.0.0';
      }
      return '';
    });
    registerOrGet.mockResolvedValue({
      token: 'tok_new',
      data: { workspace_id: 'ws_new' },
    });
  });

  it('preserves the existing agent token when the active workspace key stays the same', async () => {
    files.set(
      '/home/test/.mcporter/mcporter.json',
      JSON.stringify({
        mcpServers: {
          relaycast: {
            env: {
              RELAY_API_KEY: 'rk_live_a',
              RELAY_AGENT_TOKEN: 'tok_existing',
            },
          },
        },
      })
    );

    const { syncMcporterServers } = await import('../mcporter-config.js');
    const result = await syncMcporterServers({
      gatewayConfig: {
        apiKey: 'rk_live_a',
        clawName: 'my-claw',
        baseUrl: 'https://api.relaycast.dev',
        channels: ['general'],
      },
      workspacesConfig: {
        workspaces: [{ api_key: 'rk_live_a', workspace_id: 'ws_a', workspace_alias: 'team-a' }],
        default_workspace_id: 'ws_a',
      },
    });

    expect(result.tokenAction).toBe('preserved');
    const relaycastAddCall = execFileSync.mock.calls.find(
      ([, args]) => Array.isArray(args) && args.includes('add') && args.includes('relaycast')
    );
    expect(relaycastAddCall?.[1]).toContain('RELAY_AGENT_TOKEN=tok_existing');
  });

  it('clears stale agent tokens when the active workspace key changes', async () => {
    files.set(
      '/home/test/.mcporter/mcporter.json',
      JSON.stringify({
        mcpServers: {
          relaycast: {
            env: {
              RELAY_API_KEY: 'rk_live_old',
              RELAY_AGENT_TOKEN: 'tok_old',
            },
          },
        },
      })
    );

    const { syncMcporterServers } = await import('../mcporter-config.js');
    const result = await syncMcporterServers({
      gatewayConfig: {
        apiKey: 'rk_live_new',
        clawName: 'my-claw',
        baseUrl: 'https://api.relaycast.dev',
        channels: ['general'],
      },
      workspacesConfig: {
        workspaces: [
          { api_key: 'rk_live_old', workspace_id: 'ws_old', workspace_alias: 'old' },
          { api_key: 'rk_live_new', workspace_id: 'ws_new', workspace_alias: 'new' },
        ],
        default_workspace_id: 'ws_new',
      },
    });

    expect(result.tokenAction).toBe('cleared');
    const relaycastAddCall = execFileSync.mock.calls.find(
      ([, args]) => Array.isArray(args) && args.includes('add') && args.includes('relaycast')
    );
    expect(
      (relaycastAddCall?.[1] as string[]).some((arg) => arg.includes('RELAY_AGENT_TOKEN='))
    ).toBe(false);
  });

  it('extracts agent tokens and workspace ids from Relaycast registration responses', async () => {
    const { registerRelaycastAgent } = await import('../mcporter-config.js');
    const registration = await registerRelaycastAgent({
      apiKey: 'rk_live_a',
      baseUrl: 'https://api.relaycast.dev',
      clawName: 'my-claw',
    });

    expect(registration).toEqual({
      agentToken: 'tok_new',
      workspaceId: 'ws_new',
    });
  });
});
