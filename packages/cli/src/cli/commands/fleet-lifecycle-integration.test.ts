import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerFleetCommands } from './fleet.js';
import { registerLocalAgentCommands } from './local-agent.js';
import { registerMessageCommands } from './message.js';
import {
  resolveWorkspaceSelection,
  resolveWorkspaceTransport,
  persistWorkspaceRelaycastTarget,
} from '../lib/sdk-client.js';
import { resolveFleetAttachTarget } from '../lib/fleet-attach-target.js';
import { readProjectWorkspaceSession, writeProjectWorkspaceKey } from '../lib/project-workspace-key.js';

const TARGET = {
  route: 'agent37-isolated' as const,
  baseUrl: 'https://agent37-cast.agentrelay.com',
  workspaceId: 'rw_test',
  relaycastApiKey: 'rk_live_cloud_returned',
};

const SANDBOX_ID = 'sbx_123e4567-e89b-42d3-a456-426614174000';
const SANDBOX_NAME = 'fleet-sandbox-123e4567-e89b-42d3-a456-426614174000';

let projectRoot: string;
let relayHome: string;

afterEach(() => {
  vi.unstubAllEnvs();
  if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
  if (relayHome) fs.rmSync(relayHome, { recursive: true, force: true });
});

describe('fleet CLI lifecycle routing', () => {
  it('reuses the persisted Cloud target across spawn, attach, message, list, and release without --base-url', async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-fleet-lifecycle-project-'));
    relayHome = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-fleet-lifecycle-home-'));
    vi.stubEnv('AGENT_RELAY_PROJECT', projectRoot);
    vi.stubEnv('AGENT_RELAY_HOME', relayHome);
    const dataDir = path.join(projectRoot, '.agentworkforce', 'relay');
    writeProjectWorkspaceKey(dataDir, 'rk_live_workspace', { workspaceId: TARGET.workspaceId });

    const nodeName = 'retained-sandbox-node';
    const workerName = 'unique-retained-worker';
    const transportCalls: { workspaceKey: string; baseUrl?: string }[] = [];
    const attachNode = vi.fn(async () => 0);
    const release = vi.fn(async () => ({ name: workerName, released: true, deleted: false }));
    const direct = vi.fn(async (input: unknown) => ({ id: 'message-1', ...(input as object) }));
    const nodesList = vi.fn(async () => [
      {
        id: 'node-1',
        nodeId: 'node-1',
        name: nodeName,
        status: 'online',
        live: true,
        handlersLive: true,
        capabilities: [
          {
            name: 'relay:live-agents:v1',
            metadata: { names: [workerName] },
          },
        ],
      },
    ]);
    const workspaceClient = {
      nodes: { list: nodesList },
      agents: {
        list: vi.fn(async () => [{ name: workerName, status: 'online' }]),
        release,
      },
      workspace: {
        info: vi.fn(async () => ({ id: TARGET.workspaceId })),
        register: vi.fn(async () => ({ token: 'at_live_launcher' })),
        release: vi.fn(async () => ({ released: true, deleted: true })),
      },
    };
    const createWorkspaceRelay = vi.fn((options: { workspaceKey?: string; baseUrl?: string } = {}) => {
      const transport = resolveWorkspaceTransport(options);
      transportCalls.push({
        workspaceKey: transport.workspaceKey,
        ...(transport.baseUrl ? { baseUrl: transport.baseUrl } : {}),
      });
      return workspaceClient as never;
    });
    const createAgentRelay = vi.fn((options: { workspaceKey?: string; baseUrl?: string } = {}) => {
      const transport = resolveWorkspaceTransport(options);
      transportCalls.push({
        workspaceKey: transport.workspaceKey,
        ...(transport.baseUrl ? { baseUrl: transport.baseUrl } : {}),
      });
      return {
        messages: { direct },
        messaging: { placement },
      } as never;
    });
    const placement = {
      spawn: vi.fn(async () => ({ invocationId: 'inv_lifecycle', node: { name: nodeName } })),
    };
    const ensureCloudFleetSandbox = vi.fn(async () => ({
      outcome: 'provisioned' as const,
      providerId: 'agent37' as const,
      cloudWorkspaceId: 'cloud-workspace',
      nodeId: 'node-1',
      nodeName,
      sandboxId: SANDBOX_ID,
      providerSandboxId: 'provider-sandbox-1',
      relayWorkspaceId: TARGET.workspaceId,
      relaycastTarget: TARGET,
      relayfileMounted: true,
      relayfileMountPath: '/workspace',
    }));
    const materialize = vi.fn(async () => ({
      cloudWorkspaceId: 'cloud-workspace',
      repository: 'AgentWorkforce/relay',
      revision: '0123456789abcdef0123456789abcdef01234567',
      filesWritten: 1,
      sourceProfile: 'complete-v1' as const,
      contentRoot: '/github/repos/AgentWorkforce/relay/contents',
      sentinelPath: '/github/repos/AgentWorkforce/relay/.relayfile/clone.json',
    }));
    const sdk = {
      createAgentRelay: createAgentRelay as never,
      createWorkspaceRelay: createWorkspaceRelay as never,
      createWorkspace: vi.fn() as never,
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error('__exit__');
      }) as never,
    };
    const core = {
      env: process.env,
      getProjectPaths: () => ({ projectRoot, dataDir, teamDir: projectRoot }),
      exit: vi.fn(),
    };
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      core: core as never,
      sdk,
      resolveWorkspaceSelection: resolveWorkspaceSelection as never,
      resolveSandboxRepository: () => ({
        repository: 'AgentWorkforce/relay',
        repositoryName: 'relay',
        revision: '0123456789abcdef0123456789abcdef01234567',
        projectRoot,
        repositoryRelativeCwd: '',
        workerCwd: '/srv/agent-workforce/relay',
      }),
      materializeCloudRelayfileRepository: materialize as never,
      ensureCloudFleetSandbox: ensureCloudFleetSandbox as never,
      persistWorkspaceRelaycastTarget: persistWorkspaceRelaycastTarget as never,
      createFleetWorkspaceClient: createWorkspaceRelay as never,
      deleteCloudFleetSandbox: vi.fn(async () => undefined),
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });

    const node = program.command('node');
    registerLocalAgentCommands(node, {
      cwd: () => projectRoot,
      env: process.env,
      attachNode,
      resolveFleetAttachTarget: (name) =>
        resolveFleetAttachTarget(
          name,
          () => workspaceClient as never,
          () => resolveWorkspaceTransport(),
          () => resolveWorkspaceSelection({ projectRoot })
        ),
      attach: vi.fn(async () => 0),
      attachRemote: vi.fn(async () => 0),
      connect: vi.fn() as never,
      connectLocal: vi.fn() as never,
      readConnectionFile: vi.fn(),
      getDefaultStateDir: () => dataDir,
      fetch: globalThis.fetch,
      redeemJoinTicket: vi.fn() as never,
      persistWorkspaceSession: vi.fn() as never,
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error('__exit__');
      }) as never,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    registerMessageCommands(program, {
      createAgentRelay,
      createWorkspaceRelay,
      log: vi.fn(),
      error: vi.fn(),
      exit: sdk.exit,
    });

    await program.parseAsync(
      [
        'fleet',
        'spawn',
        'codex',
        '--sandbox',
        '--sandbox-provider',
        'agent37',
        '--sandbox-id',
        SANDBOX_ID,
        '--sandbox-name',
        SANDBOX_NAME,
        '--workspace-id',
        TARGET.workspaceId,
        '--name',
        workerName,
        '--task',
        'Work',
        '--workspace-key',
        'rk_live_workspace',
      ],
      { from: 'user' }
    );
    expect(readProjectWorkspaceSession(dataDir)).toMatchObject({
      workspaceKey: 'rk_live_workspace',
      workspaceId: TARGET.workspaceId,
      relaycastRoute: TARGET.route,
      relaycastBaseUrl: TARGET.baseUrl,
      relaycastApiKey: TARGET.relaycastApiKey,
    });
    expect(fs.readFileSync(path.join(dataDir, 'workspace-key.json'), 'utf8')).not.toContain(
      TARGET.relaycastApiKey
    );

    await program.parseAsync(['node', 'agent', 'attach', workerName, '--mode', 'view'], { from: 'user' });
    await program.parseAsync(['message', 'dm', 'send', workerName, 'hello'], { from: 'user' });
    await program.parseAsync(['fleet', 'agent', 'list'], { from: 'user' });
    await program.parseAsync(['fleet', 'release', workerName], { from: 'user' });

    expect(attachNode).toHaveBeenCalledWith(workerName, 'view', 'node-1', {
      baseUrl: TARGET.baseUrl,
      workspaceKey: undefined,
      json: undefined,
      reasoning: undefined,
      diagnostics: undefined,
    });
    expect(direct).toHaveBeenCalledWith({ to: workerName, text: 'hello' });
    expect(nodesList).toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ name: workerName, deleteAgent: false }));
    expect(transportCalls.length).toBeGreaterThanOrEqual(4);
    expect(
      transportCalls.every(
        (call) => call.workspaceKey === TARGET.relaycastApiKey && call.baseUrl === TARGET.baseUrl
      )
    ).toBe(true);
  });
});
