import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agent-relay/cloud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-relay/cloud')>();
  return {
    readWorkspaceStore: vi.fn(() => ({ workspaces: {} })),
    resolveActiveWorkspace: vi.fn(),
    setWorkspaceKey: vi.fn(),
    switchWorkspace: vi.fn(),
    // The real convergence helpers, not stand-ins: these tests assert on what
    // the command reports about the AR-448 data-plane invariant, so a copy here
    // would let the real check drift past them.
    describeDataPlaneConvergence: actual.describeDataPlaneConvergence,
    formatDataPlaneDivergence: actual.formatDataPlaneDivergence,
  };
});

vi.mock('../lib/workspace-session.js', async (importOriginal) => ({
  // Returns a result object describing what the write changed beyond the key.
  persistWorkspaceSession: vi.fn(() => ({})),
  pinProjectWorkspaceSession: vi.fn(),
  // The real formatter, not a copy: these tests assert on its wording, so a
  // stand-in here would let the command output drift past them.
  describeClearedEnrollment: (await importOriginal<typeof import('../lib/workspace-session.js')>())
    .describeClearedEnrollment,
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
      // This fixture's planes genuinely disagree (rc_ops vs rw_ops), so the
      // evidence block reports the split rather than a shared identity.
      dataPlane: {
        unified: false,
        planes: { relaycast: 'rc_ops', relayfile: 'rw_ops', relayauth: 'rw_ops' },
        divergent: ['relayfile', 'relayauth'],
      },
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

  it('workspace active --json proves one data-plane workspace ID when the planes agree', async () => {
    const { program, deps } = createHarness();
    vi.mocked(resolveActiveWorkspace).mockResolvedValueOnce({
      name: 'Ops',
      key: 'rk_live_ops',
      // The cloud ID is a UUID in a different id space and must not count
      // against convergence.
      cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99',
      relaycastWorkspaceId: 'rw_7ccfea89',
      relayfileWorkspaceId: 'rw_7ccfea89',
      relayauthWorkspaceId: 'rw_7ccfea89',
      urls: {},
      apiUrl: 'https://cloud.test',
    });

    await program.parseAsync(['node', 'agent-relay', 'workspace', 'active', '--json']);

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

  it('workspace active reports the Relaycast ID and the unified data plane in human output', async () => {
    const { program, deps } = createHarness();
    vi.mocked(resolveActiveWorkspace).mockResolvedValueOnce({
      name: 'Ops',
      key: 'rk_live_ops',
      cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99',
      relaycastWorkspaceId: 'rw_7ccfea89',
      relayfileWorkspaceId: 'rw_7ccfea89',
      relayauthWorkspaceId: 'rw_7ccfea89',
      urls: {},
      apiUrl: 'https://cloud.test',
    });

    await program.parseAsync(['node', 'agent-relay', 'workspace', 'active']);

    const output = vi.mocked(deps.log).mock.calls.flat().map(String).join('\n');
    // The Relaycast ID is the durable delivery identity and was previously the
    // one plane the human output omitted.
    expect(output).toContain('Relaycast workspace ID: rw_7ccfea89');
    expect(output).toContain('Data-plane workspace ID: rw_7ccfea89 (unified)');
    // Human output is not a place for credentials.
    expect(output).not.toContain('rk_live_ops');
  });

  it('workspace active warns on a divergence but still exits 0 without --require-unified', async () => {
    const { program, deps } = createHarness();
    vi.mocked(resolveActiveWorkspace).mockResolvedValueOnce({
      name: 'Ops',
      key: 'rk_live_ops',
      cloudWorkspaceId: 'cloud-uuid',
      relaycastWorkspaceId: 'rw_a',
      relayfileWorkspaceId: 'rw_b',
      relayauthWorkspaceId: 'rw_a',
      urls: {},
      apiUrl: 'https://cloud.test',
    });

    await program.parseAsync(['node', 'agent-relay', 'workspace', 'active']);

    expect(vi.mocked(deps.error).mock.calls.flat().map(String).join('\n')).toContain(
      'relayfile=rw_b'
    );
    // Existing scripted callers keep their exit code; only the explicit gate
    // below changes it.
    expect(deps.exit).not.toHaveBeenCalled();
  });

  it('workspace active --require-unified exits non-zero on a divergence', async () => {
    const { program, deps } = createHarness();
    vi.mocked(resolveActiveWorkspace).mockResolvedValueOnce({
      name: 'Ops',
      key: 'rk_live_ops',
      cloudWorkspaceId: 'cloud-uuid',
      relaycastWorkspaceId: 'rw_a',
      relayfileWorkspaceId: 'rw_b',
      relayauthWorkspaceId: 'rw_c',
      urls: {},
      apiUrl: 'https://cloud.test',
    });

    // The harness `exit` throws, which is how a real exit aborts the action.
    await expect(
      program.parseAsync(['node', 'agent-relay', 'workspace', 'active', '--require-unified'])
    ).rejects.toThrow('exit:1');

    expect(deps.exit).toHaveBeenCalledWith(1);
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

  it('workspace create suppresses the active-workspace warning when re-creating the already-active workspace', async () => {
    vi.mocked(readWorkspaceStore).mockReturnValueOnce({
      active: 'session-two',
      workspaces: { 'session-two': { key: 'rk_live_old' } },
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
    expect(deps.error).not.toHaveBeenCalled();
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

  it('workspace switch reports an enrolled fleet node dropped by the move', async () => {
    vi.mocked(readWorkspaceStore).mockReturnValue({
      active: 'default',
      workspaces: { other: { key: 'rk_live_other' } },
    });
    vi.mocked(persistWorkspaceSession).mockReturnValueOnce({ clearedEnrolledNodeId: 'node_abc' });
    const { program, deps } = createHarness();

    await program.parseAsync(['node', 'agent-relay', 'workspace', 'switch', 'other']);

    const output = vi.mocked(deps.log).mock.calls.flat().join('\n');
    expect(output).toContain('node_abc');
    expect(output).toContain('relay cloud enroll');
  });

  it('workspace create reports a dropped enrolled node inside its JSON output', async () => {
    vi.mocked(persistWorkspaceSession).mockReturnValueOnce({ clearedEnrolledNodeId: 'node_abc' });
    const { program, deps } = createHarness();
    vi.mocked(deps.createWorkspace).mockResolvedValueOnce({ workspaceKey: 'rk_live_fresh' } as never);

    await program.parseAsync(['node', 'agent-relay', 'workspace', 'create', 'fresh']);

    // A new workspace key never matches the existing pin, so create is a
    // clearing path too — and its output must stay parseable JSON.
    const printed = JSON.parse(String(vi.mocked(deps.log).mock.calls[0][0]));
    expect(printed.clearedEnrolledNodeId).toBe('node_abc');
    expect(printed.warning).toContain('relay cloud enroll');
  });

  it('workspace create emits no warning key when nothing was dropped', async () => {
    const { program, deps } = createHarness();
    vi.mocked(deps.createWorkspace).mockResolvedValueOnce({ workspaceKey: 'rk_live_fresh' } as never);

    await program.parseAsync(['node', 'agent-relay', 'workspace', 'create', 'fresh']);

    const printed = JSON.parse(String(vi.mocked(deps.log).mock.calls[0][0]));
    expect(printed).not.toHaveProperty('clearedEnrolledNodeId');
    expect(printed).not.toHaveProperty('warning');
  });

  it('workspace switch stays quiet when no enrolled node was dropped', async () => {
    vi.mocked(readWorkspaceStore).mockReturnValue({
      active: 'default',
      workspaces: { other: { key: 'rk_live_other' } },
    });
    const { program, deps } = createHarness();

    await program.parseAsync(['node', 'agent-relay', 'workspace', 'switch', 'other']);

    expect(vi.mocked(deps.log).mock.calls.flat().join('\n')).not.toContain('Cleared');
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
