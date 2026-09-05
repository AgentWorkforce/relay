import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// Dependency-free ESM is also used by the local Relayflow runner.
// @ts-expect-error JavaScript module intentionally has no declaration file.
import {
  bindInspectedSnapshotManifest,
  buildDirectNodeSpawnPlan,
  buildFleetSpawnArgs,
  deriveFleetVerdict,
  executeFleetCommand,
  findExactSentinelMessage,
  findFleetAgentNode,
  loadFleetMatrix,
  loadWorkspaceCredentialFile,
  matchesSandboxFileInspection,
  operationStatus,
  redactFleetEvidence,
  sanitizeFleetArgv,
  summarizeFleetCampaign,
  tryParseJson,
  validateFleetEvidence,
  validateFleetCommandCoverage,
  validateFleetAcceptance,
  validateFleetMatrix,
  validateOperationArgvContract,
  validateRecoveryEvidence,
  validateReview,
  validateSandboxRuntimeAttestation,
  validateSeal,
} from '../../scripts/verify-features/fleet-daytona.mjs';
// @ts-expect-error JavaScript module intentionally has no declaration file.
import { preflightPermissions } from '../../scripts/verify-features/fleet-permissions.mjs';
// @ts-expect-error JavaScript module intentionally has no declaration file.
import {
  collectFleetCliInventory,
  compareFleetCliInventory,
  inventorySha256,
} from '../../scripts/verify-features/fleet-cli-inventory.mjs';

const NONCE = 'a'.repeat(32);
const execFileAsync = promisify(execFile);

function operationRecord(operation: {
  id: string;
  group: string;
  expect: string;
  mustContain?: string;
  argvMustContain?: string[];
}) {
  const commandLeaf = Object.entries(fixtureMatrix.commandSurface).find(([, ids]) =>
    (ids as string[]).includes(operation.id)
  )?.[0];
  return {
    ...operation,
    acceptanceProfile: fixtureMatrix.acceptance.operationProfiles[operation.id],
    status: 'pass',
    startedAt: '2026-09-04T00:00:00.000Z',
    finishedAt: '2026-09-04T00:00:00.001Z',
    monotonicStartNs: '1000',
    monotonicEndNs: '2000',
    durationMs: 0.001,
    argv: commandLeaf
      ? ['agent-relay', ...commandLeaf.split(' '), ...(operation.argvMustContain ?? [])]
      : ['daytona', 'semantic-proof', operation.id],
    exitCode: operation.expect === 'expected-failure' ? 1 : 0,
    timedOut: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...(operation.mustContain ? { stderr: operation.mustContain } : {}),
    ...(operation.expect === 'sentinel' || operation.expect === 'sentinel-and-exit'
      ? { observedSentinel: true }
      : {}),
    ...(operation.expect === 'sentinel-and-exit' ? { observedExit: true } : {}),
    ...(operation.expect === 'stream' ? { observedStream: true } : {}),
  };
}

let fixtureMatrix: {
  minimumCriticalLifecycleTrials: number;
  inventorySha256: string;
  requiredSnapshotRelayVersion: string;
  acceptance: {
    operationProfiles: Record<string, string>;
  };
  commandSurface: Record<string, string[]>;
  operations: Array<{
    id: string;
    group: string;
    expect: string;
    mustContain?: string;
    argvMustContain?: string[];
  }>;
};

function completeEvidence(matrix: {
  minimumCriticalLifecycleTrials: number;
  inventorySha256: string;
  requiredSnapshotRelayVersion: string;
  acceptance: {
    operationProfiles: Record<string, string>;
  };
  commandSurface: Record<string, string[]>;
  operations: Array<{
    id: string;
    group: string;
    expect: string;
    mustContain?: string;
    argvMustContain?: string[];
  }>;
}) {
  fixtureMatrix = matrix;
  const resources = [
    {
      type: 'daytona-sandbox',
      id: '11111111-1111-4111-8111-111111111111',
      role: 'board-node',
      provider: 'daytona',
      nodeId: 'node_a',
      nodeName: `relay-fleetboard-a-${NONCE.slice(0, 16)}`,
      ownership: 'created-by-run',
      cleanupState: 'deleted',
    },
    {
      type: 'daytona-sandbox',
      id: '22222222-2222-4222-8222-222222222222',
      role: 'board-node',
      provider: 'daytona',
      nodeId: 'node_b',
      nodeName: `relay-fleetboard-b-${NONCE.slice(0, 16)}`,
      ownership: 'created-by-run',
      cleanupState: 'absent',
    },
  ];
  const criticalTrials = Array.from({ length: matrix.minimumCriticalLifecycleTrials }, (_, offset) => {
    const node = resources[offset % resources.length];
    const index = offset + 1;
    const slot = offset % 2 === 0 ? 'a' : 'b';
    const agentName = `critical-lifecycle-${slot}-${NONCE.slice(0, 16)}`;
    return {
      index,
      status: 'pass',
      nodeName: node.nodeName,
      nodeId: node.nodeId,
      agentName,
      monotonicStartNs: String(index * 1_000),
      monotonicEndNs: String(index * 1_000 + 1_000),
      durationMs: 0.001,
      preSpawnAgentAbsent: true,
      spawned: true,
      placementConfirmed: true,
      initialSentinelObserved: true,
      initialAckMessageIdHash: (index % 10).toString(16).repeat(64),
      initialAckAgentName: agentName,
      initialAckChannelName: 'general',
      postReadyInjectionAccepted: true,
      injectionMessageIdHash: ((index + 1) % 10).toString(16).repeat(64),
      postReadySentinelObserved: true,
      postReadyAckMessageIdHash: ((index + 2) % 10).toString(16).repeat(64),
      postReadyAckAgentName: agentName,
      postReadyAckChannelName: 'general',
      postReadyReaderConfirmed: true,
      releasedAndAbsent: true,
      spawnArgv: ['agent-relay', 'fleet', 'spawn', 'codex', '--node', node.nodeName],
      spawnExitCode: 0,
      spawnTimedOut: false,
      spawnStdoutBytes: 0,
      spawnStderrBytes: 0,
      spawnOutputTruncated: false,
    };
  });
  return {
    version: 1,
    kind: 'fleet-daytona-board',
    nonce: NONCE,
    product: 'relay',
    provider: 'daytona',
    startedAt: '2026-09-04T00:00:00.000Z',
    finishedAt: '2026-09-04T00:00:01.000Z',
    provenance: {
      sourceCommit: 'f'.repeat(40),
      sourceDirty: false,
      cliSha256: 'a'.repeat(64),
      runnerSha256: 'b'.repeat(64),
      matrixSha256: 'PLACEHOLDER',
      inventorySha256: matrix.inventorySha256,
      cliVersion: matrix.requiredSnapshotRelayVersion,
      daytonaVersion: '0.205.1',
      resolvedWorkspaceId: 'workspace_fixture',
    },
    environment: {
      policyMutationRequested: true,
      policyMutationAuthorized: true,
      policyMutationPerformed: true,
      expectedWorkspaceId: 'workspace_fixture',
      controlPlaneClean: true,
      policyRestoration: { status: 'pass' },
    },
    baseline: {
      agentCount: 0,
      onlineAgentCount: 0,
      fleetNodeCount: 0,
      liveFleetNodeCount: 0,
      sandboxIdHashes: [],
      sandboxNameHashes: [],
      agentNameHashes: [],
      fleetNodeNameHashes: [],
    },
    operations: matrix.operations.map(operationRecord),
    criticalLifecycle: { status: 'pass', trials: criticalTrials },
    resources,
    ownershipIntents: resources.map(({ type, nodeName }) => ({ type, name: nodeName })),
    cleanup: { status: 'pass' },
    verdict: 'GREEN',
  };
}

describe('complete Daytona Fleet board', () => {
  it('restricts each model preflight to its provider transport', async () => {
    for (const [provider, host] of [
      ['opencode', 'api.opencode.ai:443'],
      ['codex', 'api.openai.com:443'],
      ['claude', 'api.anthropic.com:443'],
    ]) {
      const policy = preflightPermissions(`preflight-${provider}`);
      expect(policy.network).toEqual({ allow: expect.arrayContaining([host]), deny: ['*'] });
      expect(policy.files).toEqual({ read: [], write: [], deny: ['**'] });
      expect(policy.inherit).toBe(false);
      expect(policy.network.allow).not.toContain('*');
    }
  });

  it('clean-installs and verifies the packed candidate before either Daytona attempt', async () => {
    const source = await readFile('workflows/verify-fleet-daytona.ts', 'utf8');
    const prepare = source.indexOf("wf.step('prepare-clean-installed-candidate'");
    const attemptA = source.indexOf("wf.step('run-daytona-board-attempt-a'");
    expect(prepare).toBeGreaterThan(-1);
    expect(prepare).toBeLessThan(attemptA);
    expect(source).toContain("dependsOn: ['prepare-clean-installed-candidate']");
    expect(source).toContain('VERIFY_FLEET_CANDIDATE_ATTESTATION=');
    expect(source).toContain('VERIFY_FLEET_CLI=');
  });

  it('enumerates the complete Fleet and node-agent command/provider board', async () => {
    const matrix = await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json');

    expect(matrix.operations).toHaveLength(95);
    expect(() => validateFleetAcceptance(matrix)).not.toThrow();
    expect(Object.keys(matrix.acceptance.operationProfiles)).toHaveLength(95);
    expect(matrix.operations.map(({ id }: { id: string }) => id)).toEqual(
      expect.arrayContaining([
        'fleet-config',
        'fleet-enable',
        'fleet-disable',
        'fleet-inherit',
        'fleet-spawn-provider-opencode',
        'node-agent-spawn-codex-auto-a',
        'node-agent-spawn-codex-auto-b',
        'node-agent-spawn-provider-droid',
        'node-agent-spawn-provider-claude-native',
        'node-agent-spawn-provider-opencode-native',
        'node-agent-spawn-provider-pi-native',
        'node-agent-spawn-provider-deepagents-native',
        'node-agent-message-flush',
        'node-workflow-sync',
        'fleet-release-reclaims-owned-sandbox',
        'owned-sandbox-cleanup',
        'daytona-baseline-restored',
      ])
    );
    expect(
      matrix.operations.find(({ id }: { id: string }) => id === 'node-up-already-running')
    ).toMatchObject({ expect: 'success' });
    const runner = await readFile('scripts/verify-features/fleet-daytona.mjs', 'utf8');
    expect(runner).toContain("['claude', 'opencode', 'pi', 'deepagents']");
  });

  it('binds every operation record to an executable acceptance profile', async () => {
    const matrix = await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json');
    const evidence = completeEvidence(matrix);
    evidence.provenance.matrixSha256 = createHash('sha256').update(JSON.stringify(matrix)).digest('hex');
    expect(validateFleetEvidence(evidence, matrix)).toBe(evidence);

    const unbound = structuredClone(evidence);
    unbound.operations[0].acceptanceProfile = 'fleet-read';
    expect(() => validateFleetEvidence(unbound, matrix)).toThrow(/acceptance profile/);

    const missing = structuredClone(matrix);
    delete missing.acceptance.operationProfiles['fleet-status'];
    expect(() => validateFleetAcceptance(missing)).toThrow(/exactly map all 95/);
  });

  it('binds matrix argv contracts to the actual Fleet and direct-node argument builders', async () => {
    const matrix = await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json');
    const definition = (id: string) =>
      matrix.operations.find((operation: { id: string }) => operation.id === id);
    const validate = (id: string, args: string[]) =>
      validateOperationArgvContract(
        { id, argv: ['node', '/candidate/dist/cli/index.js', ...args] },
        definition(id),
        matrix
      );

    validate(
      'fleet-spawn-session-ref',
      buildFleetSpawnArgs({
        provider: 'codex',
        agentName: 'worker',
        task: 'task',
        node: 'node-a',
        sessionRef: 'session-a',
      })
    );
    validate(
      'fleet-spawn-sandbox-scoped-mount',
      buildFleetSpawnArgs({
        provider: 'codex',
        agentName: 'worker',
        task: 'task',
        sandbox: true,
        mountPaths: ['/tests/**'],
      })
    );
    validate(
      'fleet-spawn-provider-claude',
      buildFleetSpawnArgs({ provider: 'claude', agentName: 'worker', task: 'task', node: 'node-a' })
    );
    validate(
      'fleet-spawn-metadata-channel-model-cwd',
      buildFleetSpawnArgs({
        provider: 'codex',
        agentName: 'worker',
        task: 'task',
        node: 'node-a',
        channel: 'proof',
        model: 'gpt-test',
        cwd: '/workspace',
        persona: 'auditor',
        organization: 'AgentWorkforce',
        project: 'relay',
        workstream: 'qualification',
        role: 'worker',
        objective: 'prove metadata',
      })
    );

    const native = buildDirectNodeSpawnPlan('opencode', 'worker', 'READY', { runtime: 'native' });
    validate('node-agent-spawn-provider-opencode-native', native.args);
    const taskExit = buildDirectNodeSpawnPlan('codex', 'worker', 'READY', {
      spawnMode: 'task-exit',
    });
    validate('node-agent-spawn-task-exit', taskExit.args);
  });

  it('proves root, scoped, and disabled Relayfile mounts with exact marker bytes', async () => {
    const [scopeBytes, rootBytes, runner] = await Promise.all([
      readFile('tests/relayflows/cleanroom/relayfile-scope-marker.txt'),
      readFile('tests/relayflows/relayfile-root-marker.txt'),
      readFile('scripts/verify-features/fleet-daytona.mjs', 'utf8'),
    ]);
    const scope = {
      exists: true,
      bytes: scopeBytes.length,
      sha256: createHash('sha256').update(scopeBytes).digest('hex'),
    };
    const root = {
      exists: true,
      bytes: rootBytes.length,
      sha256: createHash('sha256').update(rootBytes).digest('hex'),
    };
    expect(matchesSandboxFileInspection({ exitCode: 0, payload: scope }, scope)).toBe(true);
    expect(matchesSandboxFileInspection({ exitCode: 0, payload: root }, root)).toBe(true);
    expect(matchesSandboxFileInspection({ exitCode: 0, payload: { exists: false } }, { exists: false })).toBe(
      true
    );
    expect(matchesSandboxFileInspection({ exitCode: 0, payload: scope }, { ...scope, bytes: 1 })).toBe(false);
    expect(runner).toContain(
      'mountProof: { scope: present(scopeMarkerBytes), rootOnly: present(rootOnlyMarkerBytes) }'
    );
    expect(runner).toContain('mountProof: { scope: present(scopeMarkerBytes), rootOnly: absent }');
    expect(runner).toContain('mountProof: { scope: absent, rootOnly: absent }');
  });

  it('builds direct node spawn argv without unresolved lexical state', () => {
    const codex = buildDirectNodeSpawnPlan('codex', 'worker-a', 'SENTINEL', {
      runtime: 'native',
      channel: 'verification',
      cwd: '/home/daytona',
      model: 'gpt-test',
    });
    expect(codex.commandName).toBe('spawn');
    expect(codex.expectedModel).toBe('gpt-test');
    expect(codex.args).toEqual(
      expect.arrayContaining([
        '--task',
        expect.stringContaining('channel verification'),
        '--runtime',
        'native',
        '--cwd',
        '/home/daytona',
        '--model',
        'gpt-test',
      ])
    );
    const claude = buildDirectNodeSpawnPlan('claude', 'worker-b', 'CLAUDE_SENTINEL');
    expect(claude.expectedModel).toBeUndefined();
    expect(claude.args).not.toContain('--model');
    expect(claude.args.join(' ')).toContain('channel general');
  });

  it('derives exact command, option, argument, and hidden-surface coverage from the built CLI', async () => {
    const [matrix, expected] = await Promise.all([
      loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json'),
      readFile('tests/relayflows/cleanroom/fleet-cli-inventory.json', 'utf8').then(JSON.parse),
    ]);
    const actual = await collectFleetCliInventory('packages/cli/dist/cli/index.js');
    expect(compareFleetCliInventory(actual, expected)).toBe(actual);
    expect(inventorySha256(actual)).toBe(matrix.inventorySha256);
    expect(() => validateFleetCommandCoverage(matrix, actual)).not.toThrow();
    expect(actual.commands.find(({ path }: { path: string }) => path === 'fleet serve')).toMatchObject({
      hidden: true,
      leaf: true,
    });
    expect(
      actual.commands
        .find(({ path }: { path: string }) => path === 'node up')
        ?.options.find(({ flags }: { flags: string }) => flags === '--background-child')
    ).toMatchObject({ hidden: true });

    const missingCommand = structuredClone(expected);
    missingCommand.commands = missingCommand.commands.filter(
      ({ path }: { path: string }) => path !== 'fleet nodes'
    );
    expect(() => compareFleetCliInventory(actual, missingCommand)).toThrow('inventory changed');

    const changedOption = structuredClone(expected);
    changedOption.commands.find(({ path }: { path: string }) => path === 'fleet spawn').options.pop();
    expect(() => compareFleetCliInventory(actual, changedOption)).toThrow('inventory changed');
  });

  it('rejects duplicate operations and an incomplete provider board', async () => {
    const matrix = await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json');
    const duplicate = structuredClone(matrix);
    duplicate.operations.push(structuredClone(duplicate.operations[0]));
    expect(() => validateFleetMatrix(duplicate)).toThrow(/duplicate operation/);

    const wrongCount = structuredClone(matrix);
    wrongCount.operations.pop();
    expect(() => validateFleetMatrix(wrongCount)).toThrow(/exactly 95/);

    const incomplete = structuredClone(matrix);
    incomplete.operations = incomplete.operations.filter(
      ({ id }: { id: string }) => id !== 'fleet-spawn-provider-gemini'
    );
    incomplete.operations.push({ id: 'unmapped-replacement', group: 'fixture', expect: 'success' });
    expect(() => validateFleetMatrix(incomplete)).toThrow(/must exactly map all 95 operations/);
  });

  it('redacts credentials from argv and bounded evidence text', () => {
    const token = 'rk_live_0123456789abcdef';
    const previousAccess = process.env.CLOUD_API_ACCESS_TOKEN;
    const previousRefresh = process.env.CLOUD_API_REFRESH_TOKEN;
    try {
      process.env.CLOUD_API_ACCESS_TOKEN = 'opaque-cloud-access-secret';
      process.env.CLOUD_API_REFRESH_TOKEN = 'opaque-cloud-refresh-secret';
      expect(sanitizeFleetArgv(['agent-relay', 'fleet', 'nodes', '--workspace-key', token])).toEqual([
        'agent-relay',
        'fleet',
        'nodes',
        '--workspace-key',
        '[REDACTED]',
      ]);
      expect(sanitizeFleetArgv(['agent-relay', '--token=at_live_secretvalue'])).toEqual([
        'agent-relay',
        '--token=[REDACTED]',
      ]);
      expect(redactFleetEvidence(`Authorization: Bearer ${token}`)).not.toContain(token);
      const bareOutput = redactFleetEvidence('opaque-cloud-access-secret\nopaque-cloud-refresh-secret');
      expect(bareOutput).not.toContain('opaque-cloud-access-secret');
      expect(bareOutput).not.toContain('opaque-cloud-refresh-secret');
    } finally {
      if (previousAccess === undefined) delete process.env.CLOUD_API_ACCESS_TOKEN;
      else process.env.CLOUD_API_ACCESS_TOKEN = previousAccess;
      if (previousRefresh === undefined) delete process.env.CLOUD_API_REFRESH_TOKEN;
      else process.env.CLOUD_API_REFRESH_TOKEN = previousRefresh;
    }
  });

  it('marks oversized command output as truncated instead of parsing a misleading tail', async () => {
    const result = await executeFleetCommand(
      [process.execPath, '-e', "process.stdout.write('x'.repeat(4096))"],
      { maxCaptureBytes: 64 }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdoutBytes).toBe(4096);
    expect(result.stdoutTruncated).toBe(true);
    expect(result._rawStdout).toHaveLength(64);
  });

  it('marks evidence as truncated when parsing retained more output than reviewers can inspect', async () => {
    const result = await executeFleetCommand(
      [process.execPath, '-e', "process.stdout.write('x'.repeat(32768))"],
      { maxCaptureBytes: 64 * 1024 }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdoutCaptureTruncated).toBe(false);
    expect(result.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16 * 1024);
  });

  it('delivers staged stdin bytes so interactive mode semantics can be proven', async () => {
    const result = await executeFleetCommand([process.execPath, '-e', 'process.stdin.pipe(process.stdout)'], {
      stdin: [
        { data: 'first', delayMs: 5, end: false },
        { data: '-second', delayMs: 10, end: true },
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdinBytes).toBe(12);
    expect(result.stdinWriteError).toBeUndefined();
    expect(result._rawStdout).toBe('first-second');
  });

  it('does not treat arbitrary nonzero exits as an allowed timeout', () => {
    for (const expectType of ['stream', 'sentinel']) {
      const definition = { expect: expectType, allowTimeout: true };
      expect(
        operationStatus(definition, {
          exitCode: 1,
          timedOut: false,
          observedStream: true,
          observedSentinel: true,
        })
      ).toBe('fail');
      expect(
        operationStatus(definition, {
          exitCode: null,
          timedOut: true,
          observedStream: true,
          observedSentinel: true,
        })
      ).toBe('pass');
    }
  });

  it('keeps the independently computed snapshot manifest digest authoritative', () => {
    expect(
      bindInspectedSnapshotManifest({
        sha256: 'a'.repeat(64),
        manifest: { sha256: 'b'.repeat(64), snapshot: { name: 'candidate' } },
      }).sha256
    ).toBe('a'.repeat(64));
  });

  it('requires the actual Daytona CLI and broker bytes to match the clean-installed candidate', () => {
    const expected = {
      cliSha256: 'a'.repeat(64),
      cliVersion: 'agent-relay v11.10.4-candidate.1',
      brokerSha256: 'b'.repeat(64),
      brokerBytes: 123,
      packageVersion: '11.10.4-candidate.1',
      platform: 'linux',
      arch: 'x64',
    };
    const runtime = {
      platform: 'linux',
      arch: 'x64',
      cliPath: '/opt/agent-relay/node_modules/agent-relay/dist/cli/index.js',
      cliSha256: expected.cliSha256,
      cliVersion: expected.cliVersion,
      brokerPath: '/opt/agent-relay/node_modules/@agent-relay/broker-linux-x64/bin/agent-relay-broker',
      brokerSha256: expected.brokerSha256,
      brokerBytes: expected.brokerBytes,
      brokerMode: '755',
      brokerVersion: `agent-relay-broker ${expected.packageVersion}`,
    };
    expect(validateSandboxRuntimeAttestation(runtime, expected)).toBe(runtime);
    expect(() =>
      validateSandboxRuntimeAttestation({ ...runtime, cliSha256: 'c'.repeat(64) }, expected)
    ).toThrow(/cliSha256/);
    expect(() =>
      validateSandboxRuntimeAttestation({ ...runtime, brokerSha256: 'd'.repeat(64) }, expected)
    ).toThrow(/brokerSha256/);
    expect(() =>
      validateSandboxRuntimeAttestation({ ...runtime, cliPath: '/tmp/copied-index.js' }, expected)
    ).toThrow(/installed candidate packages/);
  });

  it('accepts only an exact sender-bound agent acknowledgement', () => {
    const messages = [
      { id: 'msg-wrong', agentName: 'other-agent', channelName: 'general', text: 'ACK' },
      { id: 'msg-substring', agentName: 'worker', channelName: 'general', text: 'ACK plus noise' },
      { id: 'msg-exact', agentName: 'worker', channelName: 'general', text: 'ACK' },
    ];
    expect(findExactSentinelMessage(messages, 'ACK', 'worker')).toEqual(messages[2]);
    expect(findExactSentinelMessage(messages.slice(0, 2), 'ACK', 'worker')).toBeUndefined();
  });

  it('accepts targeted placement only from an exact per-node Fleet row', () => {
    const inventory = {
      perNode: [{ name: 'worker', node: 'sandbox-node-a' }],
      unplacedRoster: [{ name: 'other-worker', node: '(unplaced)' }],
    };
    expect(findFleetAgentNode(inventory, 'worker')).toBe('sandbox-node-a');
    expect(findFleetAgentNode(inventory, 'other-worker')).toBeUndefined();
    expect(
      findFleetAgentNode({ perNode: [{ name: 'worker-copy', node: 'sandbox-node-b' }] }, 'worker')
    ).toBeUndefined();
  });

  it('loads workspace credentials only from a private bounded file and binds the expected workspace', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fleet-credential-test-'));
    const file = path.join(directory, 'workspace.json');
    const previous = {
      file: process.env.VERIFY_FLEET_WORKSPACE_KEY_FILE,
      expected: process.env.VERIFY_FLEET_EXPECTED_WORKSPACE_ID,
      expectedRelay: process.env.VERIFY_FLEET_EXPECTED_RELAY_WORKSPACE_ID,
      key: process.env.RELAY_WORKSPACE_KEY,
      base: process.env.RELAY_BASE_URL,
      cloudApiUrl: process.env.CLOUD_API_URL,
      cloudAccess: process.env.CLOUD_API_ACCESS_TOKEN,
      cloudRefresh: process.env.CLOUD_API_REFRESH_TOKEN,
      cloudAccessExpiry: process.env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT,
      cloudRefreshExpiry: process.env.CLOUD_API_REFRESH_TOKEN_EXPIRES_AT,
      minimumLifetime: process.env.VERIFY_FLEET_MIN_CREDENTIAL_LIFETIME_SECONDS,
    };
    try {
      await writeFile(
        file,
        JSON.stringify({
          version: 1,
          workspaceId: '11111111-1111-4111-8111-111111111111',
          relayWorkspaceId: 'rw_1234abcd',
          expiresAt: '2099-01-02T00:00:00.000Z',
          cloud: {
            apiUrl: 'https://cloud.example.test',
            accessToken: 'cloud-access-private-value',
            refreshToken: 'cloud-refresh-private-value',
            accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
            refreshTokenExpiresAt: '2099-01-02T00:00:00.000Z',
          },
          relay: {
            workspaceKey: 'rk_test_private_value',
            baseUrl: 'https://relay.example.test',
          },
        }),
        { mode: 0o600 }
      );
      process.env.VERIFY_FLEET_WORKSPACE_KEY_FILE = file;
      delete process.env.VERIFY_FLEET_EXPECTED_WORKSPACE_ID;
      await loadWorkspaceCredentialFile();
      expect(process.env.VERIFY_FLEET_EXPECTED_WORKSPACE_ID).toBe('11111111-1111-4111-8111-111111111111');
      expect(process.env.VERIFY_FLEET_EXPECTED_RELAY_WORKSPACE_ID).toBe('rw_1234abcd');
      expect(process.env.RELAY_WORKSPACE_KEY).toBe('rk_test_private_value');
      expect(process.env.CLOUD_API_URL).toBe('https://cloud.example.test');
      expect(process.env.CLOUD_API_ACCESS_TOKEN).toBe('cloud-access-private-value');

      const insecureCredential = JSON.parse(await readFile(file, 'utf8'));
      insecureCredential.relay.baseUrl = 'http://relay.example.test';
      await writeFile(file, JSON.stringify(insecureCredential), { mode: 0o600 });
      await expect(loadWorkspaceCredentialFile()).rejects.toThrow(/invalid API URL/);

      process.env.VERIFY_FLEET_MIN_CREDENTIAL_LIFETIME_SECONDS = '86400';
      await writeFile(
        file,
        JSON.stringify({
          version: 1,
          workspaceId: '11111111-1111-4111-8111-111111111111',
          relayWorkspaceId: 'rw_1234abcd',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          cloud: {
            apiUrl: 'https://cloud.example.test',
            accessToken: 'cloud-access-private-value',
            refreshToken: 'cloud-refresh-private-value',
            accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            refreshTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
          relay: {
            workspaceKey: 'rk_test_private_value',
            baseUrl: 'https://relay.example.test',
          },
        })
      );
      await expect(loadWorkspaceCredentialFile()).rejects.toThrow(/lifetime is too short/);

      await chmod(file, 0o644);
      await expect(loadWorkspaceCredentialFile()).rejects.toThrow(/private regular file/);

      await chmod(file, 0o600);
      const link = path.join(directory, 'workspace-link.json');
      await symlink(file, link);
      process.env.VERIFY_FLEET_WORKSPACE_KEY_FILE = link;
      await expect(loadWorkspaceCredentialFile()).rejects.toThrow(/symbolic link/);
    } finally {
      for (const [key, value] of Object.entries({
        VERIFY_FLEET_WORKSPACE_KEY_FILE: previous.file,
        VERIFY_FLEET_EXPECTED_WORKSPACE_ID: previous.expected,
        VERIFY_FLEET_EXPECTED_RELAY_WORKSPACE_ID: previous.expectedRelay,
        RELAY_WORKSPACE_KEY: previous.key,
        RELAY_BASE_URL: previous.base,
        CLOUD_API_URL: previous.cloudApiUrl,
        CLOUD_API_ACCESS_TOKEN: previous.cloudAccess,
        CLOUD_API_REFRESH_TOKEN: previous.cloudRefresh,
        CLOUD_API_ACCESS_TOKEN_EXPIRES_AT: previous.cloudAccessExpiry,
        CLOUD_API_REFRESH_TOKEN_EXPIRES_AT: previous.cloudRefreshExpiry,
        VERIFY_FLEET_MIN_CREDENTIAL_LIFETIME_SECONDS: previous.minimumLifetime,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts exact two-node provenance, monotonic timings, and exact cleanup', async () => {
    const matrix = await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json');
    const evidence = completeEvidence(matrix);
    evidence.provenance.matrixSha256 = await import('node:crypto').then(({ createHash }) =>
      createHash('sha256').update(JSON.stringify(matrix)).digest('hex')
    );

    expect(validateFleetEvidence(evidence, matrix)).toBe(evidence);

    const dirty = structuredClone(evidence);
    dirty.provenance.sourceDirty = true;
    expect(() => validateFleetEvidence(dirty, matrix)).toThrow(/clean source tree/);

    const ambientIdentity = structuredClone(evidence);
    ambientIdentity.baseline.agentCount = 1;
    ambientIdentity.baseline.agentNameHashes = ['9'.repeat(64)];
    expect(() => validateFleetEvidence(ambientIdentity, matrix)).toThrow(/agentCount must be zero/);

    const ambientNode = structuredClone(evidence);
    ambientNode.baseline.fleetNodeCount = 1;
    ambientNode.baseline.fleetNodeNameHashes = ['8'.repeat(64)];
    expect(() => validateFleetEvidence(ambientNode, matrix)).toThrow(/fleetNodeCount must be zero/);

    const shortLifecycle = structuredClone(evidence);
    shortLifecycle.criticalLifecycle.trials.pop();
    expect(() => validateFleetEvidence(shortLifecycle, matrix)).toThrow(/exactly 5 trials/);

    const forgedAck = structuredClone(evidence);
    forgedAck.criticalLifecycle.trials[0].initialAckAgentName = 'different-agent';
    expect(() => validateFleetEvidence(forgedAck, matrix)).toThrow(/status is inconsistent/);

    const staleIdentity = structuredClone(evidence);
    staleIdentity.criticalLifecycle.trials[2].preSpawnAgentAbsent = false;
    expect(() => validateFleetEvidence(staleIdentity, matrix)).toThrow(/status is inconsistent/);

    const wrongCommand = structuredClone(evidence);
    const fleetNodes = wrongCommand.operations.find(({ id }) => id === 'fleet-nodes-name');
    fleetNodes.argv = ['agent-relay', 'fleet', 'status', '--name'];
    expect(() => validateFleetEvidence(wrongCommand, matrix)).toThrow(/command leaf fleet nodes/);

    const missingFlag = structuredClone(evidence);
    const filteredNodes = missingFlag.operations.find(({ id }) => id === 'fleet-nodes-name');
    filteredNodes.argv = ['agent-relay', 'fleet', 'nodes'];
    expect(() => validateFleetEvidence(missingFlag, matrix)).toThrow(/required token --name/);
  });

  it('binds release qualification evidence to the exact candidate snapshot manifest', async () => {
    const matrix = await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json');
    const evidence = completeEvidence(matrix);
    evidence.provenance.matrixSha256 = await import('node:crypto').then(({ createHash }) =>
      createHash('sha256').update(JSON.stringify(matrix)).digest('hex')
    );
    evidence.environment.releaseQualificationRequested = true;
    evidence.environment.expectedSnapshotId = 'snap_qualified_deadbeef';
    evidence.environment.expectedSnapshotName = 'relay-candidate-11.10.3-rc.1-deadbeef';
    evidence.environment.expectedSnapshotManifestSha256 = 'c'.repeat(64);
    evidence.environment.expectedRelayVersion = '11.10.3-rc.1';
    evidence.environment.expectedRelayWorkspaceId = 'rw_1234abcd';
    evidence.provenance.cliVersion = 'agent-relay v11.10.3-rc.1';
    Object.assign(evidence.provenance, {
      candidateCleanInstall: true,
      candidateInstallAttestationSha256: 'd'.repeat(64),
      candidateInstallSourceSha: evidence.provenance.sourceCommit,
      candidateInstallVersion: evidence.environment.expectedRelayVersion,
      candidateInstallPlatform: 'linux',
      candidateInstallArch: 'x64',
      candidateInstallBrokerSha256: 'e'.repeat(64),
      candidateInstallBrokerBytes: 123,
    });
    evidence.resources.forEach((resource) => {
      Object.assign(resource, {
        observedSnapshotId: evidence.environment.expectedSnapshotId,
        relayWorkspaceId: evidence.environment.expectedRelayWorkspaceId,
        snapshot: evidence.environment.expectedSnapshotName,
        snapshotManifest: {
          sha256: evidence.environment.expectedSnapshotManifestSha256,
          snapshot: { name: evidence.environment.expectedSnapshotName, mode: 'candidate' },
          promotion: { ssmWrite: false, selectorWrite: false, deploy: false },
          packages: { '@agent-relay/sdk': evidence.environment.expectedRelayVersion },
        },
        runtimeAttestation: {
          platform: evidence.provenance.candidateInstallPlatform,
          arch: evidence.provenance.candidateInstallArch,
          cliPath: '/opt/agent-relay/node_modules/agent-relay/dist/cli/index.js',
          cliSha256: evidence.provenance.cliSha256,
          cliVersion: evidence.provenance.cliVersion,
          brokerPath: '/opt/agent-relay/node_modules/@agent-relay/broker-linux-x64/bin/agent-relay-broker',
          brokerSha256: evidence.provenance.candidateInstallBrokerSha256,
          brokerBytes: evidence.provenance.candidateInstallBrokerBytes,
          brokerMode: '755',
          brokerVersion: `agent-relay-broker ${evidence.provenance.candidateInstallVersion}`,
        },
      });
    });

    expect(validateFleetEvidence(evidence, matrix)).toBe(evidence);

    const sourceBuild = structuredClone(evidence);
    sourceBuild.provenance.candidateCleanInstall = false;
    expect(() => validateFleetEvidence(sourceBuild, matrix)).toThrow(/clean-installed Relay candidate/);

    const stale = structuredClone(evidence);
    stale.resources[0].snapshotManifest.sha256 = 'd'.repeat(64);
    expect(() => validateFleetEvidence(stale, matrix)).toThrow(/manifest digest/);

    const nameOnly = structuredClone(evidence);
    nameOnly.resources[0].observedSnapshotId = null;
    expect(() => validateFleetEvidence(nameOnly, matrix)).toThrow(/immutable snapshot id/);
  });

  it('rejects reused node identity, dirty cleanup, non-monotonic time, and secret argv', async () => {
    const matrix = await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json');
    const base = completeEvidence(matrix);
    base.provenance.matrixSha256 = await import('node:crypto').then(({ createHash }) =>
      createHash('sha256').update(JSON.stringify(matrix)).digest('hex')
    );
    base.resources[1].nodeId = 'same';
    base.resources[0].nodeId = 'same';
    expect(() => validateFleetEvidence(structuredClone(base), matrix)).toThrow(/node ids are not unique/);

    const dirty = structuredClone(base);
    dirty.resources[1].nodeId = 'different';
    dirty.resources[1].cleanupState = 'owned';
    expect(() => validateFleetEvidence(dirty, matrix)).toThrow(/was not cleaned up/);

    const timing = structuredClone(base);
    timing.resources[1].nodeId = 'different';
    timing.operations[0].monotonicEndNs = '999';
    expect(() => validateFleetEvidence(timing, matrix)).toThrow(/non-monotonic/);

    const leaked = structuredClone(base);
    leaked.resources[1].nodeId = 'different';
    leaked.operations[0].argv = ['agent-relay', '--token', 'at_live_secretvalue'];
    expect(() => validateFleetEvidence(leaked, matrix)).toThrow(/unredacted credential argument/);
  });

  it('keeps product defects red and safety-gated shared mutations yellow', () => {
    expect(deriveFleetVerdict([{ status: 'fail' }], { status: 'pass' })).toBe('RED');
    expect(deriveFleetVerdict([{ group: 'cleanup', status: 'fail' }], { status: 'fail' })).toBe(
      'INFRA_BLOCKED'
    );
    expect(deriveFleetVerdict([{ status: 'safety-skipped' }], { status: 'pass' })).toBe('YELLOW');
    expect(deriveFleetVerdict([{ status: 'pass' }], { status: 'fail' })).toBe('INFRA_BLOCKED');
  });

  it('parses a complete JSON document before a trailing update banner', () => {
    expect(tryParseJson('prefix\n{"runId":"local_1","nested":{"text":"} ok"}}\nUPDATE')).toEqual({
      runId: 'local_1',
      nested: { text: '} ok' },
    });
  });

  it('rejects recovery cleanup targets not derived from the exact nonce', async () => {
    const matrix = await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json');
    const evidence = completeEvidence(matrix);
    expect(validateRecoveryEvidence(evidence, matrix, NONCE)).toBe(evidence);

    const malicious = structuredClone(evidence);
    malicious.resources.push({
      type: 'relay-agent',
      id: 'unrelated-user-agent',
      ownership: 'created-by-run',
      cleanupState: 'owned',
    });
    malicious.ownershipIntents.push({ type: 'relay-agent', name: 'unrelated-user-agent' });
    expect(() => validateRecoveryEvidence(malicious, matrix, NONCE)).toThrow(/not authorized/);
  });

  it('binds valid reviews to the exact immutable evidence seal', () => {
    const digests = {
      evidenceSha256: 'a'.repeat(64),
      matrixSha256: 'b'.repeat(64),
      runnerSha256: 'c'.repeat(64),
    };
    const seal = {
      version: 1,
      kind: 'fleet-daytona-evidence-seal',
      nonce: NONCE,
      ...digests,
      createdAt: '2026-09-04T00:00:01.000Z',
    };
    expect(validateSeal(seal, NONCE, digests)).toBe(seal);

    const review = {
      version: 1,
      role: 'final-codex-review',
      kind: 'review',
      ...digests,
      verdict: 'COMPREHENSIVELY_SATISFIED',
      whyPassed: 'All matrix operations and cleanup evidence were inspected.',
      endToEndWiringVerified: 'The sealed evidence connects the board to exact resources.',
      deterministicEvidence: ['95 exact operation records'],
      remainingRisks: ['Product RED is permitted as truthful evidence.'],
      findings: [],
    };
    expect(validateReview(review, review.role, review.kind, seal)).toBe(review);

    const swapped = structuredClone(review);
    swapped.evidenceSha256 = 'd'.repeat(64);
    expect(() => validateReview(swapped, swapped.role, swapped.kind, seal)).toThrow(/evidenceSha256/);

    const falselySatisfied = structuredClone(review);
    falselySatisfied.findings.push({
      findingId: 'open-integrity-gap',
      severity: 'high',
      file: 'evidence.json',
      issue: 'The record is incomplete.',
      fixRequired: 'Repair the verifier.',
      testRequired: 'Add deterministic coverage.',
      evidence: 'One operation is missing.',
      status: 'open',
    });
    expect(() =>
      validateReview(falselySatisfied, falselySatisfied.role, falselySatisfied.kind, seal)
    ).toThrow(/cannot contain open findings/);
  });

  it('classifies mixed repeated outcomes as flaky and rejects sandbox reuse', async () => {
    const matrix = await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json');
    const first = completeEvidence(matrix);
    first.provenance.matrixSha256 = await import('node:crypto').then(({ createHash }) =>
      createHash('sha256').update(JSON.stringify(matrix)).digest('hex')
    );
    const second = structuredClone(first);
    second.nonce = 'b'.repeat(32);
    second.provenance.resolvedWorkspaceId = 'workspace_fixture_b';
    second.environment.expectedWorkspaceId = 'workspace_fixture_b';
    second.resources.forEach((resource: { nodeName: string }) => {
      resource.nodeName = resource.nodeName.replace(NONCE.slice(0, 16), second.nonce.slice(0, 16));
    });
    second.ownershipIntents.forEach((intent: { name: string }) => {
      intent.name = intent.name.replace(NONCE.slice(0, 16), second.nonce.slice(0, 16));
    });
    second.resources[0].id = '33333333-3333-4333-8333-333333333333';
    second.resources[0].nodeId = 'node_c';
    second.resources[1].id = '44444444-4444-4444-8444-444444444444';
    second.resources[1].nodeId = 'node_d';
    second.criticalLifecycle.trials.forEach((trial: Record<string, unknown>, offset: number) => {
      const resource = second.resources[offset % second.resources.length];
      trial.nodeName = resource.nodeName;
      trial.nodeId = resource.nodeId;
      trial.agentName = `critical-lifecycle-${offset % 2 === 0 ? 'a' : 'b'}-${second.nonce.slice(0, 16)}`;
      trial.initialAckAgentName = trial.agentName;
      trial.postReadyAckAgentName = trial.agentName;
      trial.spawnArgv = ['agent-relay', 'fleet', 'spawn', 'codex', '--node', resource.nodeName];
    });

    const green = summarizeFleetCampaign(
      [
        { nonce: first.nonce, evidence: first, evidenceSha256: 'a'.repeat(64) },
        { nonce: second.nonce, evidence: second, evidenceSha256: 'b'.repeat(64) },
      ],
      matrix
    );
    expect(green.verdict).toBe('GREEN');
    expect(
      green.operations.every(
        ({ classification }: { classification: string }) => classification === 'stable-pass'
      )
    ).toBe(true);

    second.operations[0].status = 'fail';
    second.operations[0].exitCode = 1;
    second.verdict = 'RED';
    const red = summarizeFleetCampaign(
      [
        { nonce: first.nonce, evidence: first, evidenceSha256: 'a'.repeat(64) },
        { nonce: second.nonce, evidence: second, evidenceSha256: 'b'.repeat(64) },
      ],
      matrix
    );
    expect(red.verdict).toBe('RED');
    expect(red.operations[0].classification).toBe('flaky');

    const differentRunner = structuredClone(second);
    differentRunner.provenance.runnerSha256 = 'd'.repeat(64);
    expect(() =>
      summarizeFleetCampaign(
        [
          { nonce: first.nonce, evidence: first, evidenceSha256: 'a'.repeat(64) },
          { nonce: differentRunner.nonce, evidence: differentRunner, evidenceSha256: 'b'.repeat(64) },
        ],
        matrix
      )
    ).toThrow(/different runnerSha256/);

    const dirty = structuredClone(second);
    dirty.provenance.sourceDirty = true;
    expect(() =>
      summarizeFleetCampaign(
        [
          { nonce: first.nonce, evidence: first, evidenceSha256: 'a'.repeat(64) },
          { nonce: dirty.nonce, evidence: dirty, evidenceSha256: 'b'.repeat(64) },
        ],
        matrix
      )
    ).toThrow(/clean source tree/);

    const reusedWorkspace = structuredClone(second);
    reusedWorkspace.provenance.resolvedWorkspaceId = first.provenance.resolvedWorkspaceId;
    reusedWorkspace.environment.expectedWorkspaceId = first.provenance.resolvedWorkspaceId;
    expect(() =>
      summarizeFleetCampaign(
        [
          { nonce: first.nonce, evidence: first, evidenceSha256: 'a'.repeat(64) },
          {
            nonce: reusedWorkspace.nonce,
            evidence: reusedWorkspace,
            evidenceSha256: 'b'.repeat(64),
          },
        ],
        matrix
      )
    ).toThrow(/workspace .* was reused/);

    second.resources[0].id = first.resources[0].id;
    expect(() =>
      summarizeFleetCampaign(
        [
          { nonce: first.nonce, evidence: first, evidenceSha256: 'a'.repeat(64) },
          { nonce: second.nonce, evidence: second, evidenceSha256: 'b'.repeat(64) },
        ],
        matrix
      )
    ).toThrow(/reused across attempts/);
  });

  it('binds a campaign gate to both attempt seals and rejects later attempt mutation', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'relay-fleet-campaign-'));
    try {
      const matrix = structuredClone(
        await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json')
      );
      matrix.artifactRoot = path.join(temporary, 'artifacts');
      const matrixPath = path.join(temporary, 'matrix.json');
      await writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);
      await writeFile(
        path.join(temporary, matrix.inventoryFile),
        await readFile('tests/relayflows/cleanroom/fleet-cli-inventory.json')
      );
      const matrixDigest = createHash('sha256').update(JSON.stringify(matrix)).digest('hex');
      const attemptNonces = ['campaign-test-a', 'campaign-test-b'];

      for (const [index, nonce] of attemptNonces.entries()) {
        const evidence = completeEvidence(matrix);
        evidence.nonce = nonce;
        evidence.provenance.resolvedWorkspaceId = `workspace_fixture_${index}`;
        evidence.environment.expectedWorkspaceId = `workspace_fixture_${index}`;
        evidence.provenance.matrixSha256 = matrixDigest;
        evidence.resources.forEach((resource: { id: string; nodeName: string }, resourceIndex: number) => {
          resource.id = `${index + 1}${resourceIndex + 1}111111-1111-4111-8111-111111111111`;
          resource.nodeName = resource.nodeName.replace(NONCE.slice(0, 16), nonce.slice(0, 16));
        });
        evidence.ownershipIntents.forEach((intent: { name: string }) => {
          intent.name = intent.name.replace(NONCE.slice(0, 16), nonce.slice(0, 16));
        });
        evidence.criticalLifecycle.trials.forEach((trial: Record<string, unknown>, trialIndex: number) => {
          const resource = evidence.resources[trialIndex % evidence.resources.length];
          trial.nodeName = resource.nodeName;
          trial.nodeId = resource.nodeId;
          trial.agentName = `critical-lifecycle-${trialIndex % 2 === 0 ? 'a' : 'b'}-${nonce.slice(0, 16)}`;
          trial.initialAckAgentName = trial.agentName;
          trial.postReadyAckAgentName = trial.agentName;
          trial.spawnArgv = ['agent-relay', 'fleet', 'spawn', 'codex', '--node', resource.nodeName];
        });
        const attemptDir = path.join(matrix.artifactRoot, nonce);
        await mkdir(attemptDir, { recursive: true });
        await writeFile(path.join(attemptDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
        await execFileAsync(process.execPath, [
          'scripts/verify-features/fleet-daytona.mjs',
          'gate',
          '--matrix',
          matrixPath,
          '--nonce',
          nonce,
        ]);
      }

      await execFileAsync(process.execPath, [
        'scripts/verify-features/fleet-daytona.mjs',
        'aggregate',
        '--matrix',
        matrixPath,
        '--nonce',
        'campaign-test',
        '--attempts',
        attemptNonces.join(','),
      ]);
      await expect(
        execFileAsync(process.execPath, [
          'scripts/verify-features/fleet-daytona.mjs',
          'gate-campaign',
          '--matrix',
          matrixPath,
          '--nonce',
          'campaign-test',
        ])
      ).resolves.toBeDefined();

      const attemptPath = path.join(matrix.artifactRoot, attemptNonces[0], 'evidence.json');
      const mutated = JSON.parse(await readFile(attemptPath, 'utf8'));
      mutated.finishedAt = '2026-09-04T00:00:02.000Z';
      await writeFile(attemptPath, `${JSON.stringify(mutated, null, 2)}\n`);
      await expect(
        execFileAsync(process.execPath, [
          'scripts/verify-features/fleet-daytona.mjs',
          'gate-campaign',
          '--matrix',
          matrixPath,
          '--nonce',
          'campaign-test',
        ])
      ).rejects.toThrow(/sealed evidenceSha256 no longer matches/);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
