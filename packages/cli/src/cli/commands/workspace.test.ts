import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agent-relay/cloud', async (importOriginal) => {
  // The convergence helpers are pure and are the thing under test here — keep
  // the real implementations so the command's evidence output isn't asserted
  // against a stub that could drift from it.
  const actual = await importOriginal<typeof import('@agent-relay/cloud')>();
  return {
    describeDataPlaneConvergence: actual.describeDataPlaneConvergence,
    formatDataPlaneDivergence: actual.formatDataPlaneDivergence,
    readWorkspaceStore: vi.fn(() => ({ workspaces: {} })),
    resolveActiveWorkspace: vi.fn(),
    setWorkspaceKey: vi.fn(),
    switchWorkspace: vi.fn(),
  };
});

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
      relaycastWorkspaceId: 'rw_ops',
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
      relaycastWorkspaceId: 'rw_ops',
      relayfileWorkspaceId: 'rw_ops',
      relayauthWorkspaceId: 'rw_ops',
      organizationId: 'org_1',
      slug: 'ops',
      urls: {},
      apiUrl: 'https://cloud.test',
      dataPlane: {
        unified: true,
        workspaceId: 'rw_ops',
        planes: { relaycast: 'rw_ops', relayfile: 'rw_ops', relayauth: 'rw_ops' },
        divergent: [],
      },
    });
  });

  it('workspace active --json proves the three data planes share one workspace ID', async () => {
    const { program, deps } = createHarness();
    vi.mocked(resolveActiveWorkspace).mockResolvedValueOnce({
      key: 'rk_live_ops',
      cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99',
      relaycastWorkspaceId: 'rw_7ccfea89',
      relayfileWorkspaceId: 'rw_7ccfea89',
      relayauthWorkspaceId: 'rw_7ccfea89',
      urls: {},
      apiUrl: 'https://cloud.test',
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'workspace',
      'active',
      '--json',
      '--require-unified',
    ]);

    const printed = JSON.parse(String(vi.mocked(deps.log).mock.calls[0][0]));
    expect(printed.dataPlane).toEqual({
      unified: true,
      workspaceId: 'rw_7ccfea89',
      planes: { relaycast: 'rw_7ccfea89', relayfile: 'rw_7ccfea89', relayauth: 'rw_7ccfea89' },
      divergent: [],
    });
    expect(deps.error).not.toHaveBeenCalled();
    expect(deps.exit).not.toHaveBeenCalled();
  });

  it('workspace active --require-unified exits 1 when the planes diverge', async () => {
    const { program, deps } = createHarness();
    vi.mocked(resolveActiveWorkspace).mockResolvedValueOnce({
      key: 'rk_live_ops',
      cloudWorkspaceId: 'rw_ops',
      relaycastWorkspaceId: 'rw_cast',
      relayfileWorkspaceId: 'rw_file',
      relayauthWorkspaceId: 'rw_cast',
      urls: {},
      apiUrl: 'https://cloud.test',
    });

    await expect(
      program.parseAsync(['node', 'agent-relay', 'workspace', 'active', '--json', '--require-unified'])
    ).rejects.toThrow('exit:1');

    const printed = JSON.parse(String(vi.mocked(deps.log).mock.calls[0][0]));
    expect(printed.dataPlane).toMatchObject({ unified: false, divergent: ['relayfile'] });
    expect(printed.dataPlane.workspaceId).toBeUndefined();
    expect(vi.mocked(deps.error).mock.calls.flat().join('\n')).toContain('not durable');
  });

  it('workspace active warns but still succeeds on divergence without --require-unified', async () => {
    const { program, deps } = createHarness();
    vi.mocked(resolveActiveWorkspace).mockResolvedValueOnce({
      key: 'rk_live_ops',
      cloudWorkspaceId: 'rw_ops',
      relaycastWorkspaceId: 'rw_cast',
      relayfileWorkspaceId: 'rw_file',
      relayauthWorkspaceId: 'rw_cast',
      urls: {},
      apiUrl: 'https://cloud.test',
    });

    await program.parseAsync(['node', 'agent-relay', 'workspace', 'active', '--json']);

    expect(deps.error).toHaveBeenCalled();
    expect(deps.exit).not.toHaveBeenCalled();
  });

  it('workspace active prints every plane ID, including Relaycast, in human output', async () => {
    const { program, deps } = createHarness();
    vi.mocked(resolveActiveWorkspace).mockResolvedValueOnce({
      name: 'default',
      key: 'rk_live_ops',
      cloudWorkspaceId: 'cloud-uuid',
      relaycastWorkspaceId: 'rw_7ccfea89',
      relayfileWorkspaceId: 'rw_7ccfea89',
      relayauthWorkspaceId: 'rw_7ccfea89',
      urls: {},
      apiUrl: 'https://cloud.test',
    });

    await program.parseAsync(['node', 'agent-relay', 'workspace', 'active']);

    const output = vi.mocked(deps.log).mock.calls.flat().join('\n');
    expect(output).toContain('Relaycast workspace ID: rw_7ccfea89');
    expect(output).toContain('Relayfile workspace ID: rw_7ccfea89');
    expect(output).toContain('Relayauth workspace ID: rw_7ccfea89');
    expect(output).toContain('Data-plane workspace ID: rw_7ccfea89 (unified)');
    // Human output must not carry the credential that unlocks the workspace.
    expect(output).not.toContain('rk_live_ops');
  });

  it('workspace active --json includes raw keys only with --reveal-secrets', async () => {
    const { program, deps } = createHarness();
    vi.mocked(resolveActiveWorkspace).mockResolvedValueOnce({
      name: 'Ops',
      key: 'rk_live_ops',
      cloudWorkspaceId: 'rw_ops',
      relaycastWorkspaceId: 'rw_ops',
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
      relaycastWorkspaceId: 'rw_ops',
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
});
