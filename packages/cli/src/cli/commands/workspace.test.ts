import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agent-relay/cloud', () => ({
  readWorkspaceStore: vi.fn(() => ({ workspaces: {} })),
  resolveActiveWorkspace: vi.fn(),
  setWorkspaceKey: vi.fn(),
  switchWorkspace: vi.fn(),
}));

import { resolveActiveWorkspace, setWorkspaceKey } from '@agent-relay/cloud';

import { registerWorkspaceCommands, type WorkspaceCommandDependencies } from './workspace.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function createHarness() {
  const exit = vi.fn((code: number) => {
    throw new Error(`exit:${code}`);
  }) as unknown as WorkspaceCommandDependencies['exit'];

  const deps: WorkspaceCommandDependencies = {
    createAgentRelay: vi.fn() as never,
    createWorkspaceRelay: vi.fn() as never,
    createWorkspace: vi.fn() as never,
    log: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    exit,
  };

  const program = new Command();
  program.exitOverride();
  registerWorkspaceCommands(program, deps);

  return { program, deps };
}

describe('registerWorkspaceCommands', () => {
  it('prints the active canonical workspace as JSON', async () => {
    const { program, deps } = createHarness();
    vi.mocked(resolveActiveWorkspace).mockResolvedValueOnce({
      name: 'Ops',
      key: 'rk_live_ops',
      cloudWorkspaceId: 'rw_ops',
      relaycastWorkspaceId: 'rc_ops',
      relayfileWorkspaceId: 'rw_ops',
      relayauthWorkspaceId: 'rw_ops',
      organizationId: 'org_1',
      slug: 'ops',
      urls: {},
      apiUrl: 'https://cloud.test',
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'workspace',
      'active',
      '--json',
      '--api-url',
      'https://cloud.test',
      '--refresh-timeout',
      '25',
    ]);

    expect(resolveActiveWorkspace).toHaveBeenCalledWith({
      apiUrl: 'https://cloud.test',
      interactive: false,
      refreshTimeoutMs: 25,
    });
    expect(JSON.parse(String(vi.mocked(deps.log).mock.calls[0][0]))).toEqual({
      name: 'Ops',
      key: 'rk_live_ops',
      cloudWorkspaceId: 'rw_ops',
      relaycastWorkspaceId: 'rc_ops',
      relayfileWorkspaceId: 'rw_ops',
      relayauthWorkspaceId: 'rw_ops',
      organizationId: 'org_1',
      slug: 'ops',
      urls: {},
      apiUrl: 'https://cloud.test',
    });
  });

  // Regression coverage for AgentWorkforce/relay#1260: `workspace create` must
  // store the Cloud-issued `relaycastApiKey` (which has the Postgres row
  // `resolveActiveWorkspace` looks up), not silently store nothing / a key
  // from a direct-Relaycast create that would later 404 on `workspace active`.
  it('stores the Cloud-issued relaycastApiKey after create and prints it', async () => {
    const { program, deps } = createHarness();
    vi.mocked(deps.createWorkspace).mockResolvedValueOnce({
      workspaceId: 'rw_new',
      name: 'new-ws',
      relaycastApiKey: 'rk_live_new',
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'workspace',
      'create',
      'new-ws',
      '--api-url',
      'https://cloud.test',
    ]);

    expect(deps.createWorkspace).toHaveBeenCalledWith('new-ws', 'https://cloud.test');
    expect(vi.mocked(setWorkspaceKey)).toHaveBeenCalledWith('new-ws', 'rk_live_new', undefined, 'rw_new');
    expect(JSON.parse(String(vi.mocked(deps.log).mock.calls[0][0]))).toEqual({
      name: 'new-ws',
      workspaceId: 'rw_new',
      workspaceKey: 'rk_live_new',
    });
  });

  it('fails loudly instead of storing an unusable workspace when relaycastApiKey is missing', async () => {
    const { program, deps } = createHarness();
    vi.mocked(deps.createWorkspace).mockResolvedValueOnce({ workspaceId: 'rw_new' });

    await expect(
      program.parseAsync(['node', 'agent-relay', 'workspace', 'create', 'new-ws'])
    ).rejects.toThrow('exit:1');

    expect(vi.mocked(setWorkspaceKey)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.error)).toHaveBeenCalledWith(expect.stringContaining('missing relaycastApiKey'));
  });
});
