import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const addWorkspace = vi.fn();
const detectOpenClaw = vi.fn();
const saveGatewayConfig = vi.fn();
const registerRelaycastAgent = vi.fn();
const syncMcporterServers = vi.fn();

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue('{}'),
  copyFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock('node:net', () => ({
  createConnection: vi.fn(() => {
    const socket = new EventEmitter() as EventEmitter & {
      setTimeout: (ms: number) => void;
      destroy: () => void;
    };
    socket.setTimeout = () => undefined;
    socket.destroy = () => undefined;
    queueMicrotask(() => socket.emit('error', new Error('offline')));
    return socket;
  }),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    unref: vi.fn(),
  })),
}));

vi.mock('./../gateway.js', () => ({
  InboundGateway: {
    DEFAULT_CONTROL_PORT: 18790,
  },
}));

vi.mock('./../config.js', () => ({
  detectOpenClaw,
  saveGatewayConfig,
  addWorkspace,
}));

vi.mock('./../mcporter-config.js', () => ({
  registerRelaycastAgent,
  syncMcporterServers,
}));

describe('setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: {
              api_key: 'rk_live_new',
              workspace_id: 'ws_new',
            },
          }),
        text: () => Promise.resolve(''),
      })
    );

    detectOpenClaw.mockResolvedValue({
      installed: true,
      homeDir: '/home/test/.openclaw',
      workspaceDir: '/home/test/.openclaw/workspace',
      configFile: '/home/test/.openclaw/openclaw.json',
      config: {},
      variant: 'openclaw',
      configFilename: 'openclaw.json',
    });
    saveGatewayConfig.mockResolvedValue(undefined);
    registerRelaycastAgent.mockResolvedValue({
      agentToken: 'tok_new',
      workspaceId: 'ws_new',
    });
    addWorkspace.mockResolvedValue({
      workspaces: [
        {
          api_key: 'rk_live_new',
          workspace_alias: 'test-claw',
          workspace_id: 'ws_new',
          is_default: true,
        },
      ],
      default_workspace_id: 'ws_new',
    });
    syncMcporterServers.mockResolvedValue({
      configured: true,
      tokenAction: 'provided',
      agentToken: 'tok_new',
    });
  });

  it('records canonical workspace ids during setup and syncs mcporter with the registered token', async () => {
    const { setup } = await import('../setup.js');
    const result = await setup({
      clawName: 'test-claw',
      channels: ['general'],
      baseUrl: 'https://api.relaycast.dev',
    });

    expect(result.ok).toBe(true);
    expect(saveGatewayConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'rk_live_new',
        clawName: 'test-claw',
      })
    );
    expect(addWorkspace).toHaveBeenCalledWith(
      {
        api_key: 'rk_live_new',
        workspace_alias: 'test-claw',
        workspace_id: 'ws_new',
        is_default: true,
      },
      { syncRuntime: false }
    );
    expect(syncMcporterServers).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayConfig: expect.objectContaining({
          apiKey: 'rk_live_new',
          clawName: 'test-claw',
        }),
        workspacesConfig: expect.objectContaining({
          default_workspace_id: 'ws_new',
        }),
        agentToken: 'tok_new',
      })
    );
  });
});
