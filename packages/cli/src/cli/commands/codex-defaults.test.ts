import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const cloudClient = {
    prewarm: vi.fn(),
    status: vi.fn(),
    acquire: vi.fn(),
    revoke: vi.fn(),
  };
  const appServer = {
    initialize: vi.fn(async () => undefined),
    startThread: vi.fn(async () => 'thread-local-1'),
    resumeThread: vi.fn(async () => undefined),
    addEnvironment: vi.fn(async () => undefined),
    environmentStatus: vi.fn(async () => ({ status: 'ready' })),
    runTurn: vi.fn(async () => {
      const turn = {
        id: 'turn-local-1',
        status: 'completed',
        itemsView: 'full',
        items: [{ id: 'answer-1', type: 'agentMessage', text: 'local answer' }],
      };
      return {
        turnId: turn.id,
        response: { turn },
        completed: { method: 'turn/completed', params: { threadId: 'thread-local-1', turn } },
      };
    }),
    turnOutcome: vi.fn(async () => ({ status: 'absent' as const })),
    close: vi.fn(async () => undefined),
  };
  const checkpointAndSeal = vi.fn();
  return {
    appServer,
    checkpointAndSeal,
    cloudClient,
    cloudConstructor: vi.fn(function () {
      return cloudClient;
    }),
    ensureCloudSession: vi.fn(),
    probeCapability: vi.fn(),
    resumePersistedLocalMount: vi.fn(async () => undefined),
  };
});

vi.mock('@agent-relay/cloud', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-relay/cloud')>()),
  CloudLiveTeleportClient: mocks.cloudConstructor,
  ensureCloudSession: mocks.ensureCloudSession,
}));

vi.mock('../lib/codex-app-server.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/codex-app-server.js')>()),
  probeCodexEnvironmentCapability: mocks.probeCapability,
  StdioCodexAppServerSession: { spawn: vi.fn(async () => mocks.appServer) },
}));

vi.mock('../lib/codex-relayfile-seal.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/codex-relayfile-seal.js')>()),
  createRelayfileSealLifecycle: () => ({
    checkpointAndSeal: mocks.checkpointAndSeal,
    resumePersistedLocalMount: mocks.resumePersistedLocalMount,
  }),
}));

import { registerCodexCommands } from './codex.js';
import { RELAY_LIVE_SESSION_TELEPORT_ENABLED_ENV } from '../lib/codex-live-controller.js';

describe('default Relay-managed Codex command wiring', () => {
  const temporaryRoots: string[] = [];
  const originalFlag = process.env[RELAY_LIVE_SESSION_TELEPORT_ENABLED_ENV];
  const originalStateDir = process.env.AGENT_RELAY_STATE_DIR;

  afterEach(() => {
    vi.clearAllMocks();
    if (originalFlag === undefined) delete process.env[RELAY_LIVE_SESSION_TELEPORT_ENABLED_ENV];
    else process.env[RELAY_LIVE_SESSION_TELEPORT_ENABLED_ENV] = originalFlag;
    if (originalStateDir === undefined) delete process.env.AGENT_RELAY_STATE_DIR;
    else process.env.AGENT_RELAY_STATE_DIR = originalStateDir;
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps a fresh durable run local when the captured startup switch is disabled', async () => {
    // Unix-domain socket paths are short on macOS; /tmp keeps the production
    // control socket below that limit while still exercising the real server.
    const root = fs.mkdtempSync(path.join('/tmp', 'relay-codex-'));
    temporaryRoots.push(root);
    const workspace = path.join(root, 'workspace');
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(workspace);
    const workspaceRoot = fs.realpathSync(workspace);
    process.env.AGENT_RELAY_STATE_DIR = stateDir;

    // Simulate dotenv or later bootstrap code mutating process.env after the
    // trusted ambient value was captured. Production wiring must use only the
    // immutable switch passed into registration.
    process.env[RELAY_LIVE_SESSION_TELEPORT_ENABLED_ENV] = 'true';
    const program = new Command().exitOverride();
    registerCodexCommands(program, {
      liveTeleportStartupSwitch: { enabled: false, reason: 'ambient-unset' },
      cwd: () => workspace,
      input: Readable.from([]),
      log: vi.fn(),
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await program.parseAsync(['node', 'relay', 'codex', 'run', 'stay local']);
    } finally {
      stderr.mockRestore();
    }

    expect(mocks.ensureCloudSession).not.toHaveBeenCalled();
    expect(mocks.cloudConstructor).not.toHaveBeenCalled();
    expect(mocks.probeCapability).not.toHaveBeenCalled();
    expect(mocks.cloudClient.prewarm).not.toHaveBeenCalled();
    expect(mocks.cloudClient.status).not.toHaveBeenCalled();
    expect(mocks.cloudClient.acquire).not.toHaveBeenCalled();
    expect(mocks.cloudClient.revoke).not.toHaveBeenCalled();
    expect(mocks.checkpointAndSeal).not.toHaveBeenCalled();
    expect(mocks.resumePersistedLocalMount).not.toHaveBeenCalled();
    expect(mocks.appServer.initialize).toHaveBeenCalledOnce();
    expect(mocks.appServer.startThread).toHaveBeenCalledWith({ cwd: workspaceRoot });
    expect(mocks.appServer.addEnvironment).not.toHaveBeenCalled();
    expect(mocks.appServer.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'stay local',
        execution: { kind: 'local', workspaceRoot },
      })
    );
    expect(fs.existsSync(path.join(stateDir, 'codex-live', 'active.json'))).toBe(true);
  });
});
