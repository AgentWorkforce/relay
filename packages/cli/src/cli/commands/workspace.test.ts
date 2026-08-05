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
  pinProjectWorkspaceSession: vi.fn(),
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
import {
  persistWorkspaceSession,
  pinProjectWorkspaceSession,
  validateWorkspaceSessionName,
} from '../lib/workspace-session.js';

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
      key: 'rk_live_…',
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

  it('workspace active --json includes raw keys only with --reveal-secrets', async () => {
    const { program, deps } = createHarness();
    vi.mocked(resolveActiveWorkspace).mockResolvedValueOnce({
      name: 'Ops',
      key: 'rk_live_ops',
      cloudWorkspaceId: 'rw_ops',
      relaycastWorkspaceId: 'rc_ops',
      relaycastApiKey: 'rk_live_castkey01',
      relayfileWorkspaceId: 'rw_ops',
      relayauthWorkspaceId: 'rw_ops',
      urls: {},
      apiUrl: 'https://cloud.test',
    });

    await program.parseAsync(['node', 'agent-relay', 'workspace', 'active', '--json', '--reveal-secrets']);

    const printed = JSON.parse(String(vi.mocked(deps.log).mock.calls[0][0]));
    expect(printed.key).toBe('rk_live_ops');
    expect(printed.relaycastApiKey).toBe('rk_live_castkey01');
  });

  it('workspace active --json masks relaycastApiKey by default', async () => {
    const { program, deps } = createHarness();
    vi.mocked(resolveActiveWorkspace).mockResolvedValueOnce({
      name: 'Ops',
      key: 'rk_live_ops',
      cloudWorkspaceId: 'rw_ops',
      relaycastWorkspaceId: 'rc_ops',
      relaycastApiKey: 'rk_live_castkey01',
      relayfileWorkspaceId: 'rw_ops',
      relayauthWorkspaceId: 'rw_ops',
      urls: {},
      apiUrl: 'https://cloud.test',
    });

    await program.parseAsync(['node', 'agent-relay', 'workspace', 'active', '--json']);

    const printed = JSON.parse(String(vi.mocked(deps.log).mock.calls[0][0]));
    expect(printed.key).toBe('rk_live_…');
    expect(printed.relaycastApiKey).toBe('rk_live_…ey01');
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
    // The raw key lands in the store; the printed output only carries the mask.
    expect(JSON.parse(String(vi.mocked(deps.log).mock.calls[0][0]))).toEqual({
      name: 'session-two',
      workspaceKey: 'rk_live_…_two',
    });
  });

  it('workspace create records and visibly warns about the previous active workspace on stderr', async () => {
    vi.mocked(readWorkspaceStore).mockReturnValueOnce({
      active: 'default',
      workspaces: { default: { key: 'rk_live_default' } },
    });
    const { program, deps } = createHarness();
    vi.mocked(deps.createWorkspace).mockResolvedValueOnce({
      workspaceKey: 'rk_live_session_two',
    } as never);

    await program.parseAsync(['node', 'agent-relay', 'workspace', 'create', 'session-two']);

    expect(persistWorkspaceSession).toHaveBeenCalledWith({
      name: 'session-two',
      workspaceKey: 'rk_live_session_two',
    });
    expect(deps.error).toHaveBeenNthCalledWith(1, '⚠  Active workspace changed: default → session-two');
    expect(deps.error).toHaveBeenNthCalledWith(2, '   Restore with: agent-relay workspace restore');
    expect(() => JSON.parse(String(vi.mocked(deps.log).mock.calls[0][0]))).not.toThrow();
  });

  it('workspace create keeps stdout parseable and routes the warning away from it', async () => {
    vi.mocked(readWorkspaceStore).mockReturnValueOnce({
      active: 'default',
      workspaces: { default: { key: 'rk_live_default' } },
    });
    const { program, deps } = createHarness();
    vi.mocked(deps.createWorkspace).mockResolvedValueOnce({
      workspaceKey: 'rk_live_json_workspace',
    } as never);

    await program.parseAsync(['node', 'agent-relay', 'workspace', 'create', 'json-workspace']);

    expect(vi.mocked(deps.log).mock.calls).toHaveLength(1);
    expect(JSON.parse(String(vi.mocked(deps.log).mock.calls[0][0]))).toMatchObject({
      name: 'json-workspace',
    });
    expect(deps.error).toHaveBeenCalledWith('⚠  Active workspace changed: default → json-workspace');
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

  it('workspace key prints the stored key masked by default and raw with --reveal-secrets', async () => {
    vi.mocked(readWorkspaceStore).mockReturnValue({
      active: 'default',
      workspaces: {
        default: { key: 'rk_live_defaultkey01' },
        shared: { key: 'rk_live_sharedkey02' },
      },
    });
    const first = createHarness();
    await first.program.parseAsync(['node', 'agent-relay', 'workspace', 'key']);
    expect(first.deps.log).toHaveBeenCalledWith('rk_live_…ey01');

    const second = createHarness();
    await second.program.parseAsync([
      'node',
      'agent-relay',
      'workspace',
      'key',
      'shared',
      '--reveal-secrets',
    ]);
    expect(second.deps.log).toHaveBeenCalledWith('rk_live_sharedkey02');
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

  it('workspace restore switches back to the recorded previous workspace', async () => {
    vi.mocked(readWorkspaceStore).mockReturnValueOnce({
      active: 'scratch',
      previous: 'default',
      workspaces: {
        default: { key: 'rk_live_default' },
        scratch: { key: 'rk_live_scratch' },
      },
    });
    const { program, deps } = createHarness();

    await program.parseAsync(['node', 'agent-relay', 'workspace', 'restore']);

    expect(persistWorkspaceSession).toHaveBeenCalledWith({
      name: 'default',
      workspaceKey: 'rk_live_default',
    });
    expect(deps.log).toHaveBeenCalledWith('Switched to workspace "default" (was scratch).');
  });

  it('workspace restore reports when nothing was recorded', async () => {
    vi.mocked(readWorkspaceStore).mockReturnValueOnce({ active: 'default', workspaces: {} });
    const { program, deps } = createHarness();

    await expect(program.parseAsync(['node', 'agent-relay', 'workspace', 'restore'])).rejects.toThrow(
      'exit:1'
    );

    expect(deps.error).toHaveBeenCalledWith('No previous workspace is recorded.');
  });

  it('workspace restore reports when the recorded workspace no longer exists', async () => {
    vi.mocked(readWorkspaceStore).mockReturnValueOnce({
      active: 'scratch',
      previous: 'deleted',
      workspaces: { scratch: { key: 'rk_live_scratch' } },
    });
    const { program, deps } = createHarness();

    await expect(program.parseAsync(['node', 'agent-relay', 'workspace', 'restore'])).rejects.toThrow(
      'exit:1'
    );

    expect(deps.error).toHaveBeenCalledWith('The recorded previous workspace "deleted" no longer exists.');
  });

  it('workspace restore reports when the recorded workspace is already active', async () => {
    vi.mocked(readWorkspaceStore).mockReturnValueOnce({
      active: 'default',
      previous: 'default',
      workspaces: { default: { key: 'rk_live_default' } },
    });
    const { program, deps } = createHarness();

    await expect(program.parseAsync(['node', 'agent-relay', 'workspace', 'restore'])).rejects.toThrow(
      'exit:1'
    );

    expect(deps.error).toHaveBeenCalledWith('The recorded previous workspace "default" is already active.');
  });

  it('workspace rebind pins the selected workspace to this project without changing global state', async () => {
    vi.mocked(readWorkspaceStore).mockReturnValueOnce({
      active: 'scratch',
      workspaces: { default: { key: 'rk_live_default' } },
    });
    const { program, deps } = createHarness();

    await program.parseAsync(['node', 'agent-relay', 'workspace', 'rebind', 'default']);

    expect(pinProjectWorkspaceSession).toHaveBeenCalledWith({ workspaceKey: 'rk_live_default' });
    expect(persistWorkspaceSession).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(
      `Rebound this project's broker to workspace "default". Restart the broker to apply it.`
    );
  });
});
