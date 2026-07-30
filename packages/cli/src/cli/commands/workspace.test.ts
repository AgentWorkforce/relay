import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agent-relay/cloud', () => ({
  readWorkspaceStore: vi.fn(() => ({ workspaces: {} })),
  resolveActiveWorkspace: vi.fn(),
  setWorkspaceKey: vi.fn(),
  switchWorkspace: vi.fn(),
}));

vi.mock('../lib/workspace-session.js', () => ({
  persistWorkspaceSession: vi.fn(),
  validateWorkspaceSessionName: vi.fn((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Workspace name is required.');
    return trimmed;
  }),
}));

import {
  readWorkspaceStore,
  resolveActiveWorkspace,
  setWorkspaceKey,
  switchWorkspace,
} from '@agent-relay/cloud';

import { registerWorkspaceCommands, type WorkspaceCommandDependencies } from './workspace.js';
import { persistWorkspaceSession, validateWorkspaceSessionName } from '../lib/workspace-session.js';

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
      bootstrapFromCloud: true,
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

  it('workspace create starts and persists a new workspace session', async () => {
    const { program, deps } = createHarness();
    vi.mocked(deps.createWorkspace).mockResolvedValueOnce({
      workspaceKey: 'rk_live_session_two',
    } as never);

    await program.parseAsync(['node', 'agent-relay', 'workspace', 'create', 'session-two']);

    expect(persistWorkspaceSession).toHaveBeenCalledWith({
      name: 'session-two',
      workspaceKey: 'rk_live_session_two',
    });
  });

  it('workspace create rejects a blank name before provisioning a remote workspace', async () => {
    const { program, deps } = createHarness();

    await expect(program.parseAsync(['node', 'agent-relay', 'workspace', 'create', '   '])).rejects.toThrow(
      'exit:1'
    );

    expect(validateWorkspaceSessionName).toHaveBeenCalledWith('   ');
    expect(deps.error).toHaveBeenCalledWith('Workspace name is required.');
    expect(deps.createWorkspace).not.toHaveBeenCalled();
    expect(persistWorkspaceSession).not.toHaveBeenCalled();
  });

  it('workspace join persists the joined workspace as the current session', async () => {
    const { program } = createHarness();

    await program.parseAsync(['node', 'agent-relay', 'workspace', 'join', 'shared', 'rk_live_shared']);

    expect(persistWorkspaceSession).toHaveBeenCalledWith({
      name: 'shared',
      workspaceKey: 'rk_live_shared',
    });
    expect(setWorkspaceKey).not.toHaveBeenCalled();
    expect(switchWorkspace).not.toHaveBeenCalled();
  });

  it('workspace switch pins the selected workspace to the current project', async () => {
    vi.mocked(readWorkspaceStore).mockReturnValueOnce({
      active: 'default',
      workspaces: {
        default: { key: 'rk_live_default' },
        shared: { key: 'rk_live_shared' },
      },
    });
    const { program } = createHarness();

    await program.parseAsync(['node', 'agent-relay', 'workspace', 'switch', 'shared']);

    expect(persistWorkspaceSession).toHaveBeenCalledWith({
      name: 'shared',
      workspaceKey: 'rk_live_shared',
    });
  });
});
