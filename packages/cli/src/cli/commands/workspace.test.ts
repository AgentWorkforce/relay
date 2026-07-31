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
  it('prints the active canonical workspace as JSON with proof the planes align', async () => {
    const { program, deps } = createHarness();
    vi.mocked(resolveActiveWorkspace).mockResolvedValueOnce({
      name: 'Ops',
      key: 'rk_live_ops',
      cloudWorkspaceId: 'rw_ops',
      // A canonical node has one workspace id shared by every plane — that
      // shape lets a resident agent's inbox survive a restart.
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
      // The JSON output carries a machine-checkable proof of the durable
      // identity invariant so a downstream deploy gate can `jq .canonical`
      // rather than re-comparing per-plane ids itself.
      canonical: true,
      planes: {
        cloud: 'rw_ops',
        relaycast: 'rw_ops',
        relayfile: 'rw_ops',
        relayauth: 'rw_ops',
      },
    });
  });

  it('workspace active --json flags non-canonical divergence in the JSON payload', async () => {
    const { program, deps } = createHarness();
    vi.mocked(resolveActiveWorkspace).mockResolvedValueOnce({
      name: 'Ops',
      key: 'rk_live_ops',
      cloudWorkspaceId: 'rw_ops',
      relaycastWorkspaceId: 'rw_ops',
      // A Relayfile / RelayAuth id that doesn't match the cloud id would
      // break the durable-identity guarantee — assert we surface the split.
      relayfileWorkspaceId: 'rw_ops_relayfile_split',
      relayauthWorkspaceId: 'rw_ops',
      urls: {},
      apiUrl: 'https://cloud.test',
    });

    await program.parseAsync(['node', 'agent-relay', 'workspace', 'active', '--json']);

    const parsed = JSON.parse(String(vi.mocked(deps.log).mock.calls[0][0]));
    expect(parsed.canonical).toBe(false);
    expect(parsed.planes).toEqual({
      cloud: 'rw_ops',
      relaycast: 'rw_ops',
      relayfile: 'rw_ops_relayfile_split',
      relayauth: 'rw_ops',
    });
  });

  it('workspace active human output proves the single canonical id when planes agree', async () => {
    const { program, deps } = createHarness();
    vi.mocked(resolveActiveWorkspace).mockResolvedValueOnce({
      name: 'Ops',
      key: 'rk_live_ops',
      cloudWorkspaceId: 'rw_ops',
      relaycastWorkspaceId: 'rw_ops',
      relayfileWorkspaceId: 'rw_ops',
      relayauthWorkspaceId: 'rw_ops',
      urls: {},
      apiUrl: 'https://cloud.test',
    });

    await program.parseAsync(['node', 'agent-relay', 'workspace', 'active']);

    const logged = vi.mocked(deps.log).mock.calls.map((call) => String(call[0]));
    expect(logged).toContain('Workspace: Ops');
    expect(logged).toContain('Canonical workspace ID: rw_ops');
    expect(logged).toContain('  ✓ Relaycast, Relayfile, and RelayAuth all resolve this workspace');
  });

  it('workspace active human output warns when the workspace planes diverge', async () => {
    const { program, deps } = createHarness();
    vi.mocked(resolveActiveWorkspace).mockResolvedValueOnce({
      key: 'rk_live_ops',
      cloudWorkspaceId: 'rw_ops',
      relaycastWorkspaceId: 'rw_ops',
      relayfileWorkspaceId: 'rw_ops_relayfile_split',
      relayauthWorkspaceId: 'rw_ops',
      urls: {},
      apiUrl: 'https://cloud.test',
    });

    await program.parseAsync(['node', 'agent-relay', 'workspace', 'active']);

    const logged = vi.mocked(deps.log).mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('DIVERGE');
    expect(logged).toContain('Relayfile : rw_ops_relayfile_split');
    // The divergence branch must NOT print the canonical-id success banner.
    expect(logged).not.toContain('Canonical workspace ID:');
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
    // `--reveal-secrets` still emits the canonical proof; only the raw keys change.
    expect(printed.canonical).toBe(false);
    expect(printed.planes.relaycast).toBe('rc_ops');
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
    // The canonical proof is emitted even when secrets are masked.
    expect(printed.canonical).toBe(false);
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
