import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const brokerMocks = vi.hoisted(() => ({
  runUpCommand: vi.fn(async () => undefined),
  runDownCommand: vi.fn(async () => undefined),
  runStatusCommand: vi.fn(async () => undefined),
  readBrokerConnection: vi.fn(() => null),
}));

vi.mock('../lib/broker-lifecycle.js', () => ({
  WORKSPACE_BINDING_SOURCE_ENV: 'AGENT_RELAY_WORKSPACE_SOURCE',
  runUpCommand: (...args: unknown[]) => brokerMocks.runUpCommand(...args),
  runDownCommand: (...args: unknown[]) => brokerMocks.runDownCommand(...args),
  runStatusCommand: (...args: unknown[]) => brokerMocks.runStatusCommand(...args),
  readBrokerConnection: (...args: unknown[]) => brokerMocks.readBrokerConnection(...args),
}));

import { registerNodeCommands, type NodeCommandDependencies } from './node.js';
import type { CoreDependencies } from './core.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

const enrollmentRecord = {
  nodeId: 'node_abc',
  nodeName: 'kjglaptop',
  nodeToken: 'nt_secret',
  relayWorkspaceId: 'rw_123',
  relaycastUrl: 'https://relaycast.example.com',
  websocketUrl: 'https://relaycast.example.com/v1/node/ws',
  enrolledAt: '2026-07-03T00:00:00.000Z',
};

function createNodeHarness(opts?: {
  env?: NodeJS.ProcessEnv;
  resolveEnrollment?: NodeCommandDependencies['resolveEnrollment'];
  listFleetEnrollments?: NodeCommandDependencies['listFleetEnrollments'];
  resolveProjectWorkspaceSession?: NodeCommandDependencies['resolveProjectWorkspaceSession'];
}) {
  const env: NodeJS.ProcessEnv = opts?.env ?? {};
  const exit = vi.fn((code: number) => {
    throw new ExitSignal(code);
  }) as unknown as NodeCommandDependencies['exit'];
  const log = vi.fn();
  const error = vi.fn();
  const warn = vi.fn();

  const core = {
    env,
    exit,
    log,
    error,
    warn,
    getProjectPaths: () => ({ projectRoot: '/repo', dataDir: '/repo/.agentworkforce/relay' }),
  } as unknown as CoreDependencies;
  const resolveEnrollment =
    opts?.resolveEnrollment ??
    (vi.fn(() => undefined) as unknown as NodeCommandDependencies['resolveEnrollment']);
  const resolveProjectWorkspaceSession = opts?.resolveProjectWorkspaceSession ?? vi.fn(() => undefined);
  // Never let a test read the developer's real fleet-enrollments.json.
  const listFleetEnrollments = (opts?.listFleetEnrollments ??
    vi.fn(() => [])) as NodeCommandDependencies['listFleetEnrollments'];

  const program = new Command();
  program.exitOverride();
  registerNodeCommands(program, {
    core,
    exit,
    log,
    error,
    warn,
    resolveEnrollment,
    listFleetEnrollments,
    resolveProjectWorkspaceSession,
  });

  return {
    program,
    env,
    log,
    error,
    warn,
    exit,
    resolveEnrollment,
    listFleetEnrollments,
    resolveProjectWorkspaceSession,
  };
}

beforeEach(() => {
  brokerMocks.runUpCommand.mockClear();
  brokerMocks.runDownCommand.mockClear();
  brokerMocks.runStatusCommand.mockClear();
});

describe('registerNodeCommands', () => {
  it('registers the node command tree (up/down/status/metrics/agent/tail/workflow)', () => {
    const { program } = createNodeHarness();
    const node = program.commands.find((command) => command.name() === 'node')!;

    expect(node.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(['up', 'down', 'status', 'metrics', 'agent', 'tail', 'workflow'])
    );

    const workflow = node.commands.find((command) => command.name() === 'workflow')!;
    expect(workflow.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(['run', 'logs', 'sync'])
    );

    const agent = node.commands.find((command) => command.name() === 'agent')!;
    expect(agent.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(['list', 'spawn', 'new', 'release', 'set-model', 'attach', 'message'])
    );

    const up = node.commands.find((command) => command.name() === 'up')!;
    expect(up.options.map((option) => option.long)).toContain('--config');
  });

  it('defaults node startup to an atomically OS-assigned broker API port', async () => {
    const { program, env } = createNodeHarness();

    await program.parseAsync(['node', 'up'], { from: 'user' });

    expect(env.AGENT_RELAY_BROKER_PORT).toBe('0');
    expect(brokerMocks.runUpCommand).toHaveBeenCalledTimes(1);
  });

  it('preserves an explicit broker base port for node startup', async () => {
    const { program, env } = createNodeHarness({
      env: { AGENT_RELAY_BROKER_PORT: '4100' },
    });

    await program.parseAsync(['node', 'up'], { from: 'user' });

    expect(env.AGENT_RELAY_BROKER_PORT).toBe('4100');
    expect(brokerMocks.runUpCommand).toHaveBeenCalledTimes(1);
  });

  it('picks up a persisted enrollment and wires its creds into the env', async () => {
    const resolveEnrollment = vi.fn(
      () => enrollmentRecord
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const { program, env, log } = createNodeHarness({ env: {}, resolveEnrollment });

    await program.parseAsync(['node', 'up'], { from: 'user' });

    expect(resolveEnrollment).toHaveBeenCalledTimes(1);
    expect(env.RELAY_NODE_TOKEN).toBe('nt_secret');
    expect(env.RELAY_NODE_ID).toBe('node_abc');
    expect(env.AGENT_RELAY_ENROLLED_NODE_ID).toBe('node_abc');
    expect(env.RELAY_BASE_URL).toBe('https://relaycast.example.com');
    expect(brokerMocks.runUpCommand).toHaveBeenCalledWith(
      expect.objectContaining({ discoverConfig: true, nodeName: 'kjglaptop' }),
      expect.anything()
    );
    expect(log.mock.calls.flat().join('\n')).toContain('kjglaptop');
    expect(log.mock.calls.flat().join('\n')).toContain('rw_123');
  });

  it('preserves the enrolled identity when background startup re-execs the CLI', async () => {
    const resolveEnrollment = vi.fn(
      () => enrollmentRecord
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const { program, env } = createNodeHarness({ env: {}, resolveEnrollment });

    await program.parseAsync(['node', 'up', '--background'], { from: 'user' });

    expect(env).toMatchObject({
      RELAY_NODE_ID: 'node_abc',
      RELAY_NODE_TOKEN: 'nt_secret',
    });
    expect(brokerMocks.runUpCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        background: true,
        brokerName: 'kjglaptop',
        nodeName: 'kjglaptop',
      }),
      expect.anything()
    );
  });

  it('lets --broker-name beat the enrolled node name', async () => {
    const resolveEnrollment = vi.fn(
      () => enrollmentRecord
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const { program } = createNodeHarness({ env: {}, resolveEnrollment });

    await program.parseAsync(['node', 'up', '--broker-name', 'edge-1'], { from: 'user' });

    expect(brokerMocks.runUpCommand).toHaveBeenCalledWith(
      expect.objectContaining({ nodeName: 'edge-1' }),
      expect.anything()
    );
  });

  it('keeps enrollment pickup when --workspace-key matches the pinned enrollment workspace', async () => {
    const resolveEnrollment = vi.fn(
      () => enrollmentRecord
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const { program, env } = createNodeHarness({
      env: {},
      resolveEnrollment,
      resolveProjectWorkspaceSession: vi.fn(() => ({
        workspaceKey: 'rk_enrolled',
        workspaceId: 'rw_123',
        enrolledNodeId: 'node_abc',
      })),
    });

    await program.parseAsync(['node', 'up', '--workspace-key', 'rk_enrolled'], { from: 'user' });

    expect(resolveEnrollment).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'node_abc' }));
    expect(env.RELAY_NODE_TOKEN).toBe('nt_secret');
    expect(brokerMocks.runUpCommand).toHaveBeenCalledTimes(1);
  });

  it('keeps enrollment pickup when RELAY_WORKSPACE_KEY matches the pinned enrollment workspace', async () => {
    const resolveEnrollment = vi.fn(
      () => enrollmentRecord
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const { program, env } = createNodeHarness({
      env: { RELAY_WORKSPACE_KEY: 'rk_enrolled' },
      resolveEnrollment,
      resolveProjectWorkspaceSession: vi.fn(() => ({
        workspaceKey: 'rk_enrolled',
        workspaceId: 'rw_123',
      })),
    });

    await program.parseAsync(['node', 'up'], { from: 'user' });

    expect(resolveEnrollment).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'rw_123' }));
    expect(env.RELAY_NODE_TOKEN).toBe('nt_secret');
    expect(brokerMocks.runUpCommand).toHaveBeenCalledTimes(1);
  });

  it('lets a genuinely different explicit workspace win and warns that enrollment was skipped', async () => {
    const resolveEnrollment = vi.fn(
      () => enrollmentRecord
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const listFleetEnrollments = vi.fn(() => [
      enrollmentRecord,
    ]) as unknown as NodeCommandDependencies['listFleetEnrollments'];
    const { program, env, warn } = createNodeHarness({
      env: {},
      resolveEnrollment,
      listFleetEnrollments,
      resolveProjectWorkspaceSession: vi.fn(() => ({
        workspaceKey: 'rk_enrolled',
        workspaceId: 'rw_123',
      })),
    });

    await program.parseAsync(['node', 'up', '--workspace-key', 'rk_other'], { from: 'user' });

    expect(resolveEnrollment).not.toHaveBeenCalled();
    expect(env.RELAY_NODE_TOKEN).toBeUndefined();
    expect(env.AGENT_RELAY_ENROLLED_NODE_ID).toBeUndefined();
    expect(warn.mock.calls.flat().join('\n')).toContain('explicit workspace key differs');
    expect(brokerMocks.runUpCommand).toHaveBeenCalledTimes(1);
  });

  it('lets an explicit pinned workspace win over a stale enrolled-node association', async () => {
    const resolveEnrollment = vi.fn(
      () => enrollmentRecord
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const listFleetEnrollments = vi.fn(() => [
      enrollmentRecord,
    ]) as unknown as NodeCommandDependencies['listFleetEnrollments'];
    const { program, env, error, warn } = createNodeHarness({
      env: {},
      resolveEnrollment,
      listFleetEnrollments,
      resolveProjectWorkspaceSession: vi.fn(() => ({
        workspaceKey: 'rk_explicit',
        workspaceId: 'rw_other',
        enrolledNodeId: 'node_abc',
      })),
    });

    await program.parseAsync(['node', 'up', '--workspace-key', 'rk_explicit'], { from: 'user' });

    expect(env.RELAY_NODE_TOKEN).toBeUndefined();
    expect(env.AGENT_RELAY_ENROLLED_NODE_ID).toBeUndefined();
    expect(error).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join('\n')).toContain('explicit workspace key differs');
    expect(brokerMocks.runUpCommand).toHaveBeenCalledTimes(1);
  });

  it('lets a different RELAY_WORKSPACE_KEY win without restoring a stale enrolled node id', async () => {
    const resolveEnrollment = vi.fn(
      () => enrollmentRecord
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const listFleetEnrollments = vi.fn(() => [
      enrollmentRecord,
    ]) as unknown as NodeCommandDependencies['listFleetEnrollments'];
    const { program, env, warn } = createNodeHarness({
      env: { RELAY_WORKSPACE_KEY: 'rk_other' },
      resolveEnrollment,
      listFleetEnrollments,
      resolveProjectWorkspaceSession: vi.fn(() => ({
        workspaceKey: 'rk_enrolled',
        workspaceId: 'rw_123',
        enrolledNodeId: 'node_abc',
      })),
    });

    await program.parseAsync(['node', 'up'], { from: 'user' });

    expect(resolveEnrollment).not.toHaveBeenCalled();
    expect(env.RELAY_NODE_TOKEN).toBeUndefined();
    expect(env.AGENT_RELAY_ENROLLED_NODE_ID).toBeUndefined();
    expect(warn.mock.calls.flat().join('\n')).toContain('explicit workspace key differs');
    expect(brokerMocks.runUpCommand).toHaveBeenCalledTimes(1);
  });

  it('falls through a blank primary workspace env var to an explicit alias', async () => {
    const resolveEnrollment = vi.fn(
      () => enrollmentRecord
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const resolveProjectWorkspaceSession = vi.fn(() => ({
      workspaceKey: 'rk_project_session',
      enrolledNodeId: 'node_abc',
    }));
    const { program, env } = createNodeHarness({
      env: {
        RELAY_WORKSPACE_KEY: '   ',
        AGENT_RELAY_WORKSPACE_KEY: ' rk_alias ',
      },
      resolveEnrollment,
      resolveProjectWorkspaceSession,
    });

    await program.parseAsync(['node', 'up'], { from: 'user' });

    expect(resolveEnrollment).not.toHaveBeenCalled();
    expect(resolveProjectWorkspaceSession).toHaveBeenCalledTimes(1);
    expect(env.RELAY_WORKSPACE_KEY).toBe('rk_alias');
    expect(env.RELAY_NODE_TOKEN).toBeUndefined();
  });

  it('adopts an enrollment for a project pin whose workspace id matches', async () => {
    const resolveEnrollment = vi.fn(
      () => enrollmentRecord
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const resolveProjectWorkspaceSession = vi.fn(() => ({
      workspaceKey: 'rk_project_session',
      workspaceId: 'rw_123',
    }));
    const { program, env } = createNodeHarness({
      env: {},
      resolveEnrollment,
      resolveProjectWorkspaceSession,
    });

    await program.parseAsync(['node', 'up'], { from: 'user' });

    expect(resolveEnrollment).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'rw_123' }));
    expect(env.RELAY_NODE_TOKEN).toBe('nt_secret');
    expect(brokerMocks.runUpCommand).toHaveBeenCalledTimes(1);
  });

  it('warns that a project pin without an enrolled node id is shadowing stored enrollments', async () => {
    const resolveEnrollment = vi.fn(
      () => enrollmentRecord
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const listFleetEnrollments = vi.fn(() => [
      enrollmentRecord,
    ]) as unknown as NodeCommandDependencies['listFleetEnrollments'];
    const { program, warn, env } = createNodeHarness({
      env: {},
      resolveEnrollment,
      listFleetEnrollments,
      resolveProjectWorkspaceSession: vi.fn(() => ({ workspaceKey: 'rk_project_session' })),
    });

    await program.parseAsync(['node', 'up'], { from: 'user' });

    // The silent case: the pin wins, the enrollment is dropped, and before this
    // fix nothing was printed at all.
    expect(env.RELAY_NODE_TOKEN).toBeUndefined();
    const warned = warn.mock.calls.flat().join('\n');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warned).toContain('1 stored Cloud fleet enrollment(s)');
    expect(warned).toContain('pinned to a workspace with no enrolled node id');
    expect(warned).toContain('relay cloud enroll');
  });

  it('stays quiet when a project pin shadows nothing', async () => {
    const { program, warn } = createNodeHarness({
      env: {},
      listFleetEnrollments: vi.fn(() => []) as unknown as NodeCommandDependencies['listFleetEnrollments'],
      resolveProjectWorkspaceSession: vi.fn(() => ({ workspaceKey: 'rk_project_session' })),
    });

    await program.parseAsync(['node', 'up'], { from: 'user' });

    expect(warn).not.toHaveBeenCalled();
    expect(brokerMocks.runUpCommand).toHaveBeenCalledTimes(1);
  });

  it('still warns and still starts when the enrollment store cannot be read', async () => {
    const listFleetEnrollments = vi.fn(() => {
      throw new Error('Fleet enrollment store at /tmp/fleet-enrollments.json is corrupt');
    }) as unknown as NodeCommandDependencies['listFleetEnrollments'];
    const { program, warn } = createNodeHarness({
      env: {},
      listFleetEnrollments,
      resolveProjectWorkspaceSession: vi.fn(() => ({ workspaceKey: 'rk_project_session' })),
    });

    await program.parseAsync(['node', 'up'], { from: 'user' });

    expect(warn.mock.calls.flat().join('\n')).toContain('stored Cloud fleet enrollments');
    expect(brokerMocks.runUpCommand).toHaveBeenCalledTimes(1);
  });

  it('does not warn about shadowed enrollments when the pin names an enrolled node', async () => {
    const resolveEnrollment = vi.fn(
      () => enrollmentRecord
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const listFleetEnrollments = vi.fn(() => [
      enrollmentRecord,
    ]) as unknown as NodeCommandDependencies['listFleetEnrollments'];
    const { program, warn } = createNodeHarness({
      env: {},
      resolveEnrollment,
      listFleetEnrollments,
      resolveProjectWorkspaceSession: vi.fn(() => ({
        workspaceKey: 'rk_enrolled',
        enrolledNodeId: 'node_abc',
      })),
    });

    await program.parseAsync(['node', 'up'], { from: 'user' });

    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses to start when the enrollment and the repository pin disagree (#1406)', async () => {
    const resolveEnrollment = vi.fn(
      () => enrollmentRecord
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const { program, env, error, exit } = createNodeHarness({
      env: { AGENT_RELAY_HOME: '/tmp/relay-home-fixture' },
      resolveEnrollment,
      // A previous start recorded rw_stale; the enrollment points at rw_123.
      resolveProjectWorkspaceSession: vi.fn(() => ({
        workspaceKey: 'rk_project_session',
        enrolledNodeId: 'node_abc',
        workspaceId: 'rw_stale',
      })),
    });

    await expect(program.parseAsync(['node', 'up'], { from: 'user' })).rejects.toBeInstanceOf(ExitSignal);

    expect(exit).toHaveBeenCalledWith(1);
    const message = error.mock.calls.flat().join('\n');
    expect(message).toContain('select different workspaces');
    expect(message).toContain('rw_stale');
    expect(message).toContain('rw_123');
    expect(message).toContain('workspace-key.json');
    expect(message).toContain('agent-relay workspace rebind <name>');
    // Diagnostics name sources, never credentials.
    expect(message).not.toContain('rk_project_session');
    expect(message).not.toContain('nt_secret');
    expect(env.RELAY_NODE_TOKEN).toBeUndefined();
    expect(brokerMocks.runUpCommand).not.toHaveBeenCalled();
  });

  it('starts normally when the enrollment matches the pinned workspace', async () => {
    const resolveEnrollment = vi.fn(
      () => enrollmentRecord
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const { program, env } = createNodeHarness({
      env: {},
      resolveEnrollment,
      resolveProjectWorkspaceSession: vi.fn(() => ({
        workspaceKey: 'rk_project_session',
        enrolledNodeId: 'node_abc',
        workspaceId: 'rw_123',
      })),
    });

    await program.parseAsync(['node', 'up'], { from: 'user' });

    expect(env.RELAY_NODE_TOKEN).toBe('nt_secret');
    expect(brokerMocks.runUpCommand).toHaveBeenCalledTimes(1);
  });

  it('preserves an enrolled identity across a consecutive project-session restart', async () => {
    const firstResolveEnrollment = vi.fn(
      () => enrollmentRecord
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const first = createNodeHarness({ env: {}, resolveEnrollment: firstResolveEnrollment });

    await first.program.parseAsync(['node', 'up', '--background'], { from: 'user' });

    expect(first.env).toMatchObject({
      AGENT_RELAY_ENROLLED_NODE_ID: 'node_abc',
      RELAY_NODE_ID: 'node_abc',
      RELAY_NODE_TOKEN: 'nt_secret',
    });

    const restartResolveEnrollment = vi.fn(
      () => enrollmentRecord
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const restart = createNodeHarness({
      env: {},
      resolveEnrollment: restartResolveEnrollment,
      resolveProjectWorkspaceSession: vi.fn(() => ({
        workspaceKey: 'rk_enrolled',
        enrolledNodeId: 'node_abc',
      })),
    });

    await restart.program.parseAsync(['node', 'up', '--background'], { from: 'user' });

    expect(restartResolveEnrollment).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'node_abc' }));
    expect(restart.env).toMatchObject({
      AGENT_RELAY_ENROLLED_NODE_ID: 'node_abc',
      RELAY_NODE_ID: 'node_abc',
      RELAY_NODE_TOKEN: 'nt_secret',
    });
    // Node startup resolves identity only. The shared runUpCommand resolver
    // applies the repository workspace, so there is no second ladder here.
    expect(restart.env.RELAY_WORKSPACE_KEY).toBeUndefined();
    expect(restart.env.RELAY_API_KEY).toBeUndefined();
    expect(brokerMocks.runUpCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        background: true,
        brokerName: 'kjglaptop',
        nodeName: 'kjglaptop',
      }),
      expect.anything()
    );
  });

  it('does not clobber an existing RELAY_NODE_TOKEN or query the store', async () => {
    const resolveEnrollment = vi.fn(
      () => enrollmentRecord
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const { program, env } = createNodeHarness({
      env: { RELAY_NODE_TOKEN: 'preexisting' },
      resolveEnrollment,
    });

    await program.parseAsync(['node', 'up'], { from: 'user' });

    expect(resolveEnrollment).not.toHaveBeenCalled();
    expect(env.RELAY_NODE_TOKEN).toBe('preexisting');
    expect(brokerMocks.runUpCommand).toHaveBeenCalledTimes(1);
  });

  it('reuses the forwarded enrolled name when the detached child already has credentials', async () => {
    const resolveEnrollment = vi.fn(
      () => enrollmentRecord
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const { program } = createNodeHarness({
      env: { RELAY_NODE_ID: 'node_abc', RELAY_NODE_TOKEN: 'nt_secret' },
      resolveEnrollment,
    });

    await program.parseAsync(['node', 'up', '--broker-name', 'kjglaptop'], { from: 'user' });

    expect(resolveEnrollment).not.toHaveBeenCalled();
    expect(brokerMocks.runUpCommand).toHaveBeenCalledWith(
      expect.objectContaining({ brokerName: 'kjglaptop', nodeName: 'kjglaptop' }),
      expect.anything()
    );
  });

  it('keeps an existing RELAY_BASE_URL when applying enrollment creds', async () => {
    const resolveEnrollment = vi.fn(
      () => enrollmentRecord
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const { program, env } = createNodeHarness({
      env: { RELAY_BASE_URL: 'https://existing.example' },
      resolveEnrollment,
    });

    await program.parseAsync(['node', 'up'], { from: 'user' });

    expect(env.RELAY_NODE_TOKEN).toBe('nt_secret');
    expect(env.RELAY_BASE_URL).toBe('https://existing.example');
  });

  it('proceeds without enrollment when the store has no match', async () => {
    const resolveEnrollment = vi.fn(
      () => undefined
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const { program, env } = createNodeHarness({ env: {}, resolveEnrollment });

    await program.parseAsync(['node', 'up'], { from: 'user' });

    expect(env.RELAY_NODE_TOKEN).toBeUndefined();
    expect(brokerMocks.runUpCommand).toHaveBeenCalledTimes(1);
  });

  it('surfaces an ambiguous enrollment as a clear error and exits 1', async () => {
    const resolveEnrollment = vi.fn(() => {
      throw new Error('Multiple fleet node enrollments match; pass baseUrl and workspaceId to disambiguate.');
    }) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const { program, error } = createNodeHarness({ env: {}, resolveEnrollment });

    await expect(program.parseAsync(['node', 'up'], { from: 'user' })).rejects.toMatchObject({ code: 1 });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('Multiple fleet node enrollments match'));
    expect(brokerMocks.runUpCommand).not.toHaveBeenCalled();
  });

  it('forwards --config through to runUpCommand', async () => {
    const { program } = createNodeHarness({ env: { RELAY_NODE_TOKEN: 'x' } });

    await program.parseAsync(['node', 'up', '--config', 'agent-relay.ts'], { from: 'user' });

    expect(brokerMocks.runUpCommand).toHaveBeenCalledWith(
      expect.objectContaining({ config: 'agent-relay.ts', discoverConfig: true }),
      expect.anything()
    );
  });
});
