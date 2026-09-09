import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import * as ts from 'typescript';

// Dependency-free ESM is also used by the local Relayflow runner.
// @ts-expect-error JavaScript module intentionally has no declaration file.
import {
  assertGreenRunVerdict,
  assertFleetLivePrerequisites,
  bindInspectedSnapshotManifest,
  buildDirectNodeSpawnPlan,
  buildFleetSpawnArgs,
  cleanupDaytonaSandbox,
  buildLocalBrokerOptionProofScript,
  compareDaytonaSandboxBaseline,
  convergeDaytonaSandboxDeletion,
  deriveFleetVerdict,
  dryRunRequested,
  evaluateFleetIdentityReconciliation,
  executeFleetCommand,
  FleetBoard,
  findExactSentinelMessage,
  findFleetAgentNode,
  loadFleetMatrix,
  loadWorkspaceCredentialFile,
  matchesSandboxFileInspection,
  operationStatus,
  parseCliJson,
  ownedBoardNodes,
  isDaytonaDeletionAccepted,
  redactFleetEvidence,
  sanitizeFleetArgv,
  summarizeDaytonaCleanupStates,
  summarizeFleetCampaign,
  tryParseJson,
  validateFleetEvidence,
  validateFleetIdentityReconciliation,
  validateFleetCommandCoverage,
  validateFleetFinalCleanup,
  validateFleetNodesPayload,
  validateFleetOptionCoverage,
  validateFleetStatusPayload,
  validateFleetAcceptance,
  validateFleetMatrix,
  validateOperationArgvContract,
  validateRecoveryEvidence,
  validateReview,
  validateSandboxRuntimeAttestation,
  validateSeal,
} from '../../scripts/verify-features/fleet-daytona.mjs';
// @ts-expect-error JavaScript module intentionally has no declaration file.
import {
  diagnosisAgentNetwork,
  fleetReviewerNetwork,
  MODEL_TRANSPORT_HOSTS,
  preflightPermissions,
} from '../../scripts/verify-features/fleet-permissions.mjs';
// @ts-expect-error JavaScript module intentionally has no declaration file.
import {
  collectFleetCliInventory,
  compareFleetCliInventory,
  inventorySha256,
} from '../../scripts/verify-features/fleet-cli-inventory.mjs';

const NONCE = 'a'.repeat(32);
const SECRET_OPTION_TOKENS = new Set(['--api-key', '--join-ticket', '--token', '--wk', '--workspace-key']);
const execFileAsync = promisify(execFile);

type WorkflowStepDeclaration = {
  dependsOn: string[];
  offset: number;
};

function workflowStepDeclarations(source: string): Map<string, WorkflowStepDeclaration> {
  const sourceFile = ts.createSourceFile(
    'workflow.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const steps = new Map<string, WorkflowStepDeclaration>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(sourceFile) === 'wf' &&
      node.expression.name.text === 'step' &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      ts.isObjectLiteralExpression(node.arguments[1])
    ) {
      const dependsOnProperty = node.arguments[1].properties.find(
        (property): property is ts.PropertyAssignment =>
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
          property.name.text === 'dependsOn'
      );
      const initializer = dependsOnProperty?.initializer;
      const dependsOn =
        initializer && ts.isArrayLiteralExpression(initializer)
          ? initializer.elements.map((element) =>
              ts.isStringLiteralLike(element) ? element.text : element.getText(sourceFile)
            )
          : [];
      steps.set(node.arguments[0].text, { dependsOn, offset: node.getStart(sourceFile) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return steps;
}

function fleetIdentityProof(
  phase: 'live' | 'roster-only' | 'absent',
  nodeName: string,
  agentName: string,
  peerName?: string
) {
  const liveNames = [...(peerName ? [peerName] : []), ...(phase === 'live' ? [agentName] : [])].sort();
  const unplacedNames = phase === 'roster-only' ? [agentName] : [];
  return evaluateFleetIdentityReconciliation({
    phase,
    nodeName,
    agentName,
    nodesPayload: {
      nodes: [
        {
          name: nodeName,
          status: 'online',
          live: true,
          handlersLive: true,
          activeAgents: liveNames.length,
          capabilities: [{ name: 'relay:live-agents:v1', metadata: { names: liveNames } }],
        },
      ],
    },
    targetedPayload: { perNode: liveNames.map((name) => ({ name, node: nodeName })), errors: [] },
    allPayload: {
      perNode: liveNames.map((name) => ({ name, node: nodeName })),
      unplacedRoster: unplacedNames.map((name) => ({ name })),
      errors: [],
    },
    directAgents: liveNames.map((name) => ({ name })),
    rosterPresent: phase !== 'absent',
    commandErrors: [],
  });
}

function rebindFleetIdentityProofs(
  operations: Array<{ id: string; fleetIdentityReconciliation?: Record<string, unknown> }>,
  nonce: string
) {
  const short = nonce.slice(0, 16);
  const targeted = operations.find(({ id }) => id === 'fleet-agent-list-node');
  if (targeted) {
    targeted.fleetIdentityReconciliation = {
      live: fleetIdentityProof('live', `relay-fleetboard-a-${short}`, `relay-fleetboard-a-initial-${short}`),
    };
  }
  const release = operations.find(({ id }) => id === 'fleet-release');
  if (release) {
    const nodeName = `relay-fleetboard-a-${short}`;
    const agentName = `fleet-spawn-node-${short}`;
    const peerName = `relay-fleetboard-a-initial-${short}`;
    release.fleetIdentityReconciliation = {
      live: fleetIdentityProof('live', nodeName, agentName, peerName),
      postRelease: fleetIdentityProof('roster-only', nodeName, agentName, peerName),
      postDelete: fleetIdentityProof('absent', nodeName, agentName, peerName),
    };
  }
  const deleteRelease = operations.find(({ id }) => id === 'fleet-release-delete-agent');
  if (deleteRelease) {
    const nodeName = `relay-fleetboard-b-${short}`;
    const agentName = `fleet-spawn-target-node-alias-${short}`;
    const peerName = `relay-fleetboard-b-initial-${short}`;
    deleteRelease.fleetIdentityReconciliation = {
      live: fleetIdentityProof('live', nodeName, agentName, peerName),
      postRelease: fleetIdentityProof('absent', nodeName, agentName, peerName),
    };
  }
}

function operationRecord(operation: {
  id: string;
  group: string;
  expect: string;
  mustContain?: string;
  argvMustContain?: string[];
}) {
  const commandLeaves = Object.entries(fixtureMatrix.commandSurface)
    .filter(([, ids]) => (ids as string[]).includes(operation.id))
    .map(([commandLeaf]) => commandLeaf);
  const fleetProvider = operation.id.match(
    /^fleet-spawn-provider-(claude|codex|gemini|aider|goose|grok|opencode)$/
  )?.[1];
  const nodeProvider = operation.id.match(
    /^node-agent-spawn-provider-(claude|codex|gemini|aider|goose|grok|opencode|droid|cursor|pi|deepagents)(?:-native)?$/
  )?.[1];
  const fleetPlacement = operation.id.startsWith('fleet-spawn-') && !operation.id.includes('reject');
  const identityLane =
    fleetPlacement ||
    nodeProvider !== undefined ||
    (operation.group === 'node-agent-spawn' && operation.expect !== 'sentinel-and-exit');
  const derivedObservation = /^initial-task-sentinel-[ab]$/.test(operation.id);
  const argv = commandLeaves.length
    ? [
        ...commandLeaves.flatMap((commandLeaf) => ['agent-relay', ...commandLeaf.split(' ')]),
        ...(operation.argvMustContain ?? []),
      ]
    : ['daytona', 'semantic-proof', operation.id];
  for (const entries of Object.values(fixtureMatrix.optionCoverage ?? {})) {
    for (const entry of entries) {
      if (
        entry.status !== 'supported' ||
        entry.operationId !== operation.id ||
        !entry.option.startsWith('--') ||
        entry.takesValue === false
      ) {
        continue;
      }
      const index = argv.indexOf(entry.argvToken ?? entry.option);
      if (index >= 0 && (argv[index + 1] === undefined || argv[index + 1].startsWith('--'))) {
        argv.splice(index + 1, 0, SECRET_OPTION_TOKENS.has(entry.option) ? '[REDACTED]' : 'fixture-value');
      }
    }
  }
  return {
    ...operation,
    acceptanceProfile: fixtureMatrix.acceptance.operationProfiles[operation.id],
    status: 'pass',
    startedAt: '2026-09-04T00:00:00.000Z',
    finishedAt: '2026-09-04T00:00:00.001Z',
    monotonicStartNs: '1000',
    monotonicEndNs: '2000',
    durationMs: 0.001,
    argv,
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
    executionKind: derivedObservation ? 'derived-observation' : 'command',
    ...(derivedObservation
      ? { derivedObservation: true, derivedFrom: `provision-node-${operation.id.slice(-1)}` }
      : {}),
    ...(identityLane
      ? {
          observedAgentName: `${operation.id}-${NONCE.slice(0, 16)}`,
          observedProvider: fleetProvider ?? nodeProvider ?? 'codex',
          observedRuntime:
            (operation.group === 'node-agent-provider' || operation.group === 'node-agent-spawn') &&
            operation.id.endsWith('-native')
              ? 'native'
              : 'pty',
          observedIdentitySource: 'node-agent-list',
        }
      : {}),
    ...(['fleet-spawn-reject-droid', 'fleet-spawn-reject-unavailable-provider'].includes(operation.id)
      ? {
          partialCreationProof: {
            targetName:
              (operation.id === 'fleet-spawn-reject-droid'
                ? 'fleet-spawn-provider-droid'
                : 'fleet-spawn-unavailable-provider') + `-${NONCE.slice(0, 16)}`,
            before: {
              agentNames: [],
              fleetNodeKeys: [],
              sandboxIds: [],
              sandboxKeys: [],
              workerProcesses: [],
            },
            after: {
              agentNames: [],
              fleetNodeKeys: [],
              sandboxIds: [],
              sandboxKeys: [],
              workerProcesses: [],
            },
          },
        }
      : {}),
    ...(operation.id === 'fleet-release-reclaims-owned-sandbox'
      ? {
          sandboxReleaseProof: {
            sandboxId: '11111111-1111-4111-8111-111111111111',
            sandboxName: `relay-fleetboard-a-${NONCE.slice(0, 16)}`,
            nodeId: 'node_a',
            workerName: `fleet-spawn-sandbox-scoped-mount-${NONCE.slice(0, 16)}`,
            ownership: 'created-by-run',
            ownershipNonce: NONCE,
            sandboxPresentBeforeRelease: true,
            workerPresentBeforeRelease: true,
            workerProcessAbsent: true,
            workerIdentityAbsent: true,
            sandboxAbsent: true,
          },
        }
      : {}),
    ...(operation.id === 'fleet-agent-list-node'
      ? {
          fleetIdentityReconciliation: {
            live: fleetIdentityProof(
              'live',
              `relay-fleetboard-a-${NONCE.slice(0, 16)}`,
              `relay-fleetboard-a-initial-${NONCE.slice(0, 16)}`
            ),
          },
        }
      : {}),
    ...(operation.id === 'fleet-release'
      ? {
          fleetIdentityReconciliation: {
            live: fleetIdentityProof(
              'live',
              `relay-fleetboard-a-${NONCE.slice(0, 16)}`,
              `fleet-spawn-node-${NONCE.slice(0, 16)}`,
              `relay-fleetboard-a-initial-${NONCE.slice(0, 16)}`
            ),
            postRelease: fleetIdentityProof(
              'roster-only',
              `relay-fleetboard-a-${NONCE.slice(0, 16)}`,
              `fleet-spawn-node-${NONCE.slice(0, 16)}`,
              `relay-fleetboard-a-initial-${NONCE.slice(0, 16)}`
            ),
            postDelete: fleetIdentityProof(
              'absent',
              `relay-fleetboard-a-${NONCE.slice(0, 16)}`,
              `fleet-spawn-node-${NONCE.slice(0, 16)}`,
              `relay-fleetboard-a-initial-${NONCE.slice(0, 16)}`
            ),
          },
        }
      : {}),
    ...(operation.id === 'fleet-release-delete-agent'
      ? {
          fleetIdentityReconciliation: {
            live: fleetIdentityProof(
              'live',
              `relay-fleetboard-b-${NONCE.slice(0, 16)}`,
              `fleet-spawn-target-node-alias-${NONCE.slice(0, 16)}`,
              `relay-fleetboard-b-initial-${NONCE.slice(0, 16)}`
            ),
            postRelease: fleetIdentityProof(
              'absent',
              `relay-fleetboard-b-${NONCE.slice(0, 16)}`,
              `fleet-spawn-target-node-alias-${NONCE.slice(0, 16)}`,
              `relay-fleetboard-b-initial-${NONCE.slice(0, 16)}`
            ),
          },
        }
      : {}),
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
  optionCoverage: Record<
    string,
    Array<{
      option: string;
      argvToken?: string;
      status: string;
      operationId?: string;
      takesValue?: boolean;
    }>
  >;
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
  optionCoverage: Record<
    string,
    Array<{
      option: string;
      argvToken?: string;
      status: string;
      operationId?: string;
      takesValue?: boolean;
    }>
  >;
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
    {
      type: 'relay-agent',
      id: `fleet-spawn-sandbox-scoped-mount-${NONCE.slice(0, 16)}`,
      role: 'worker',
      nodeName: '',
      ownership: 'created-by-run',
      cleanupState: 'absent',
      sandboxId: '11111111-1111-4111-8111-111111111111',
      sandboxNodeId: 'node_a',
      sandboxNodeName: `relay-fleetboard-a-${NONCE.slice(0, 16)}`,
    },
  ];
  const boardResources = resources.filter(({ type }) => type === 'daytona-sandbox');
  const criticalTrials = Array.from({ length: matrix.minimumCriticalLifecycleTrials }, (_, offset) => {
    const node = boardResources[offset % boardResources.length];
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
    ownershipIntents: [
      ...resources
        .filter(({ type }) => type === 'daytona-sandbox')
        .map(({ type, nodeName }) => ({ type, name: nodeName, nonce: NONCE })),
      {
        type: 'relay-agent',
        name: `fleet-spawn-sandbox-scoped-mount-${NONCE.slice(0, 16)}`,
        nonce: NONCE,
      },
    ],
    cleanup: {
      status: 'pass',
      finalBoard: {
        pass: true,
        processInventoryComplete: true,
        processInventoryEmpty: true,
        processInventoriesCoverNodes: true,
        processInventoriesCoverOnlineNodes: true,
        ownedNodeRecordsAbsent: true,
        fleetNodeRecordsAbsent: true,
        processInventoryErrors: [],
        processInventoryNodeNames: [],
        ownedNodeNames: [],
      },
    },
    verdict: 'GREEN',
  };
}

describe('complete Daytona Fleet board', () => {
  it('parses the pretty-printed CLI receipt amid unrelated JSON logs', () => {
    const receipt = parseCliJson(
      '[info] {"level":"debug"}\n' +
        JSON.stringify(
          {
            name: 'worker',
            status: 'applied',
            requestId: 'request-1',
            effectiveModel: 'openai/gpt-5.4',
          },
          null,
          2
        ) +
        '\n[done] {"level":"debug"}'
    );
    expect(receipt).toMatchObject({ status: 'applied', requestId: 'request-1' });
  });

  it('restricts every Fleet reviewer and diagnosis agent to its model provider transport', () => {
    const expectedProviders = {
      opencode: [
        ['fleet', 'cheap-supervisor'],
        ['diagnosis', 'cloud-specialist'],
        ['diagnosis', 'relayfile-specialist'],
        ['diagnosis', 'data-plane-specialist'],
      ],
      codex: [
        ['fleet', 'analysis-repair'],
        ['fleet', 'final-codex-review'],
        ['diagnosis', 'codex-reviewer'],
        ['diagnosis', 'codex-fixer'],
        ['diagnosis', 'fresh-codex-signoff'],
      ],
      claude: [
        ['fleet', 'final-claude-review'],
        ['diagnosis', 'lead'],
        ['diagnosis', 'claude-reviewer'],
        ['diagnosis', 'claude-fixer'],
        ['diagnosis', 'fresh-claude-signoff'],
      ],
    } as const;

    for (const [provider, agents] of Object.entries(expectedProviders)) {
      for (const [workflow, agent] of agents) {
        const network = workflow === 'fleet' ? fleetReviewerNetwork(agent) : diagnosisAgentNetwork(agent);
        expect(network).toEqual({
          allow: MODEL_TRANSPORT_HOSTS[provider],
          deny: ['*'],
        });
        expect(network.allow).not.toContain('*');
        for (const [otherProvider, otherHosts] of Object.entries(MODEL_TRANSPORT_HOSTS)) {
          if (otherProvider === provider) continue;
          for (const otherHost of otherHosts) expect(network.allow).not.toContain(otherHost);
        }
      }
    }

    expect(() => fleetReviewerNetwork('unknown-reviewer')).toThrow(/unknown Fleet reviewer/);
    expect(() => diagnosisAgentNetwork('unknown-diagnosis-agent')).toThrow(/unknown diagnosis agent/);
  });

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
      for (const [otherProvider, otherHosts] of Object.entries(MODEL_TRANSPORT_HOSTS)) {
        if (otherProvider === provider) continue;
        expect(policy.network.allow).not.toEqual(expect.arrayContaining(otherHosts));
        for (const otherHost of otherHosts) expect(policy.network.allow).not.toContain(otherHost);
      }
    }
  });

  it('clean-installs and verifies the packed candidate before either Daytona attempt', async () => {
    const source = await readFile('workflows/verify-fleet-daytona.ts', 'utf8');
    const steps = workflowStepDeclarations(source);
    const installDeps = steps.get('install-dependencies');
    const build = steps.get('build-current-cli');
    const installNpm = steps.get('install-candidate-npm');
    const stageBroker = steps.get('stage-current-platform-broker');
    const prepare = steps.get('prepare-clean-installed-candidate');
    const inventory = steps.get('verify-candidate-cli-inventory');
    const attemptA = steps.get('run-daytona-board-attempt-a');
    expect(installDeps).toBeDefined();
    expect(build).toBeDefined();
    expect(installNpm).toBeDefined();
    expect(stageBroker).toBeDefined();
    expect(prepare).toBeDefined();
    expect(inventory).toBeDefined();
    expect(attemptA).toBeDefined();
    expect(build!.offset).toBeGreaterThan(installDeps!.offset);
    expect(installNpm!.offset).toBeGreaterThan(build!.offset);
    expect(stageBroker!.offset).toBeGreaterThan(installNpm!.offset);
    expect(prepare!.offset).toBeGreaterThan(stageBroker!.offset);
    expect(inventory!.offset).toBeGreaterThan(prepare!.offset);
    expect(attemptA!.offset).toBeGreaterThan(inventory!.offset);
    // install-dependencies runs a script-free `npm ci` so build-current-cli never builds
    // against a sandbox snapshot's stale pre-baked node_modules.
    expect(installDeps!.dependsOn).toEqual(['validate-catalog']);
    expect(source).toMatch(/wf\.step\('install-dependencies'[\s\S]*?command:\s*'npm ci --ignore-scripts'/);
    expect(build!.dependsOn).toEqual(['install-dependencies']);
    expect(installNpm!.dependsOn).toEqual(['build-current-cli']);
    expect(stageBroker!.dependsOn).toEqual(['install-candidate-npm']);
    expect(prepare!.dependsOn).toEqual(['candidatePreparationDependency']);
    expect(inventory!.dependsOn).toEqual(['prepare-clean-installed-candidate']);
    expect(attemptA!.dependsOn).toEqual(['seal-trusted-fleet-inputs']);
    expect(source).toMatch(/if\s*\(\s*!CONFIGURED_CANDIDATE_CLI\s*\)/);
    expect(source).toMatch(/let\s+candidatePreparationDependency\s*=\s*['"]build-current-cli['"]/);
    expect(installNpm!.offset).toBeGreaterThan(build!.offset);
    expect(source).toMatch(/npm\s+install\s+--global\s+npm@\$\{REQUIRED_NPM_VERSION\}/);
    expect(source).toMatch(/test\s+"\$\(npm --version\)"\s*=\s*"\$\{REQUIRED_NPM_VERSION\}"/);
    expect(source).toMatch(/candidatePreparationDependency\s*=\s*["']stage-current-platform-broker["']/);
    expect(source).toMatch(/relay-candidate-install\.mjs\s+stage-source-broker/);
    expect(source).toContain('VERIFY_FLEET_CANDIDATE_ATTESTATION=');
    expect(source).toContain('VERIFY_FLEET_CLI=');
  });

  it('uses the exact effective Codex model for preflight and both reviewers', async () => {
    const source = await readFile('workflows/verify-fleet-daytona.ts', 'utf8');

    expect(source).toContain(
      'process.env.VERIFY_FLEET_CODEX_MODEL?.trim() || CodexModels.GPT_5_1_CODEX_MINI'
    );
    for (const role of ['analysis-repair', 'final-codex-review', 'preflight-codex']) {
      expect(source).toMatch(new RegExp(`wf\\.agent\\('${role}'[\\s\\S]*?model: FLEET_CODEX_MODEL`));
    }
  });

  it('enumerates the complete Fleet and node-agent command/provider board', async () => {
    const matrix = await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json');

    expect(matrix.operations).toHaveLength(108);
    expect(() => validateFleetAcceptance(matrix)).not.toThrow();
    expect(Object.keys(matrix.acceptance.operationProfiles)).toHaveLength(108);
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
        'node-agent-set-model-app-server-a',
        'node-agent-set-model-app-server-b',
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
    expect(Object.keys(matrix.optionCoverage)).toEqual(
      expect.arrayContaining([
        'fleet spawn',
        'fleet serve',
        'node agent new',
        'node agent attach',
        'node agent message hold',
        'node agent message flush',
        'node agent message auto',
      ])
    );
  });

  it('enforces material option coverage with explicit unsupported and skipped contracts', async () => {
    const matrix = await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json');
    const inventory = await readFile('tests/relayflows/cleanroom/fleet-cli-inventory.json', 'utf8').then(
      JSON.parse
    );
    expect(() => validateFleetOptionCoverage(matrix, inventory)).not.toThrow();
    const missing = structuredClone(matrix);
    missing.optionCoverage['node agent attach'] = missing.optionCoverage['node agent attach'].filter(
      ({ option }: { option: string }) => option !== '--ssh-host'
    );
    expect(() => validateFleetOptionCoverage(missing, inventory)).toThrow(/every material option/);
    const extraLeaf = structuredClone(matrix);
    extraLeaf.optionCoverage['fleet synthetic-leaf'] = [];
    expect(() => validateFleetOptionCoverage(extraLeaf, inventory)).toThrow(
      /every public Fleet and node-agent leaf/
    );
    const dishonest = structuredClone(matrix);
    dishonest.optionCoverage['node agent attach'].find(
      ({ option }: { option: string }) => option === '--ssh-host'
    ).status = 'unsupported';
    delete dishonest.optionCoverage['node agent attach'].find(
      ({ option }: { option: string }) => option === '--ssh-host'
    ).reason;
    expect(() => validateFleetOptionCoverage(dishonest, inventory)).toThrow(/requires a reason/);
    const unexecuted = structuredClone(matrix);
    unexecuted.operations.find(({ id }: { id: string }) => id === 'node-agent-new-view').argvMustContain = [
      '--mode',
      'view',
    ];
    expect(() => validateFleetOptionCoverage(unexecuted, inventory)).toThrow(
      /supported option node agent new --(?:channels|runtime) is not required/
    );
    const unboundVariant = structuredClone(matrix);
    unboundVariant.operations.find(
      ({ id }: { id: string }) => id === 'fleet-spawn-sandbox-root-mount'
    ).argvMustContain = unboundVariant.operations
      .find(({ id }: { id: string }) => id === 'fleet-spawn-sandbox-root-mount')
      .argvMustContain.filter((token: string) => token !== 'daytona');
    expect(() => validateFleetOptionCoverage(unboundVariant, inventory)).toThrow(
      /supported variant fleet spawn --sandbox-provider=daytona is not required/
    );

    const newDefinition = matrix.operations.find(({ id }: { id: string }) => id === 'node-agent-new-view');
    expect(() =>
      validateOperationArgvContract(
        {
          id: 'node-agent-new-view',
          argv: ['agent-relay', 'node', 'agent', 'new', 'codex', '--mode', 'view'],
        },
        newDefinition,
        matrix
      )
    ).toThrow(/missing required token --runtime|did not execute supported option --runtime/);

    const sandboxDefinition = matrix.operations.find(
      ({ id }: { id: string }) => id === 'fleet-spawn-sandbox-root-mount'
    );
    const variantDefinition = {
      ...sandboxDefinition,
      argvMustContain: sandboxDefinition.argvMustContain.filter((token: string) => token !== 'daytona'),
    };
    expect(() =>
      validateOperationArgvContract(
        {
          id: sandboxDefinition.id,
          argv: [
            'agent-relay',
            'fleet',
            'spawn',
            'codex',
            '--sandbox',
            '--sandbox-provider',
            'e2b',
            '--sandbox-snapshot',
            'fixture',
            '--sandbox-snapshot-manifest-sha256',
            'a'.repeat(64),
          ],
        },
        variantDefinition,
        matrix
      )
    ).toThrow(/did not execute supported variant --sandbox-provider=daytona/);
  });

  it('requires every command invocation and exact runtime variant for multi-command evidence', async () => {
    const matrix = await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json');
    const evidence = completeEvidence(matrix);
    const operation = evidence.operations.find(
      ({ id }: { id: string }) => id === 'node-agent-set-model-app-server-a'
    );
    const definition = matrix.operations.find(
      ({ id }: { id: string }) => id === 'node-agent-set-model-app-server-a'
    );
    expect(() => validateOperationArgvContract(operation, definition, matrix)).not.toThrow();

    const missingSetModel = structuredClone(operation);
    const setModelOffset = missingSetModel.argv.findIndex(
      (token: string, index: number, argv: string[]) =>
        token === 'agent-relay' && argv.slice(index + 1, index + 4).join(' ') === 'node agent set-model'
    );
    missingSetModel.argv.splice(setModelOffset, 4);
    expect(() => validateOperationArgvContract(missingSetModel, definition, matrix)).toThrow(
      /does not invoke command leaf node agent set-model/
    );

    const headlessOperation = evidence.operations.find(
      ({ id }: { id: string }) => id === 'node-agent-new-reject-headless'
    );
    const headlessDefinition = matrix.operations.find(
      ({ id }: { id: string }) => id === 'node-agent-new-reject-headless'
    );
    const wrongRuntime = structuredClone(headlessOperation);
    wrongRuntime.argv[wrongRuntime.argv.indexOf('--runtime') + 1] = 'pty';
    const variantOnlyDefinition = {
      ...headlessDefinition,
      argvMustContain: headlessDefinition.argvMustContain.filter((token: string) => token !== 'headless'),
    };
    expect(() => validateOperationArgvContract(wrongRuntime, variantOnlyDefinition, matrix)).toThrow(
      /did not execute (?:un)?supported variant --runtime=headless/
    );
  });

  it('fails closed for non-green runs and makes DRY_RUN a runner-level no-op', async () => {
    expect(assertGreenRunVerdict({ verdict: 'GREEN' })).toEqual({ verdict: 'GREEN' });
    expect(() => assertGreenRunVerdict({ verdict: 'RED' })).toThrow(/Fleet Daytona run verdict is RED/);
    expect(() => assertGreenRunVerdict({})).toThrow(/verdict is missing/);
    expect(dryRunRequested({ DRY_RUN: 'true' })).toBe(true);
    expect(dryRunRequested({ DRY_RUN: '1' })).toBe(true);
    expect(dryRunRequested({ DRY_RUN: 'false' })).toBe(false);

    const result = await execFileAsync(
      process.execPath,
      ['scripts/verify-features/fleet-daytona.mjs', 'run'],
      {
        cwd: path.resolve('.'),
        env: { ...process.env, DRY_RUN: 'true' },
      }
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('FLEET_DAYTONA_DRY_RUN_NOOP command=run\n');
  });

  it('generates a bounded local-broker option proof that redacts the explicit API key', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fleet-local-broker-proof-'));
    const scriptPath = path.join(directory, 'proof.cjs');
    try {
      const script = buildLocalBrokerOptionProofScript();
      await writeFile(scriptPath, script);
      await expect(execFileAsync(process.execPath, ['--check', scriptPath])).resolves.toMatchObject({
        stderr: '',
      });
      expect(script).toContain("value === connection.api_key ? '[REDACTED]' : value");
      expect(script).toContain('delete env[key]');
      expect(script).toContain('AbortSignal.timeout(2_000)');
      expect(script).toContain('execution.stdoutBytes > 2 * 1024 * 1024');
      expect(script).toContain('execution.stderrBytes > 2 * 1024 * 1024');
      expect(script).not.toContain('result.api_key');
      expect(script).not.toContain('result.connection');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('requires explicit immutable snapshot qualification inputs for live runs', () => {
    expect(() => assertFleetLivePrerequisites({})).toThrow(
      /VERIFY_FLEET_RELEASE_QUALIFICATION=1.*immutable snapshot inputs/
    );
    expect(() => assertFleetLivePrerequisites({ VERIFY_FLEET_RELEASE_QUALIFICATION: '1' })).toThrow(
      /VERIFY_FLEET_SNAPSHOT_ID/
    );
    expect(() =>
      assertFleetLivePrerequisites({
        VERIFY_FLEET_RELEASE_QUALIFICATION: '1',
        VERIFY_FLEET_SNAPSHOT_ID: 'snap_candidate_1666',
        VERIFY_FLEET_SNAPSHOT_NAME: 'relay-candidate-11.10.3',
        VERIFY_FLEET_SNAPSHOT_MANIFEST_SHA256: 'not-a-digest',
      })
    ).toThrow(/VERIFY_FLEET_SNAPSHOT_MANIFEST_SHA256/);
    expect(() =>
      assertFleetLivePrerequisites({
        VERIFY_FLEET_RELEASE_QUALIFICATION: '1',
        VERIFY_FLEET_SNAPSHOT_ID: 'snap_candidate_1666',
        VERIFY_FLEET_SNAPSHOT_NAME: 'relay-candidate-11.10.3',
        VERIFY_FLEET_SNAPSHOT_MANIFEST_SHA256: 'a'.repeat(64),
        VERIFY_FLEET_EXPECTED_RELAY_VERSION: '11.10.3',
      })
    ).not.toThrow();
  });

  it('fails the default live runner before workspace access when qualification is not configured', async () => {
    const env = { ...process.env };
    for (const key of [
      'DRY_RUN',
      'VERIFY_FLEET_RELEASE_QUALIFICATION',
      'VERIFY_FLEET_SNAPSHOT_ID',
      'VERIFY_FLEET_SNAPSHOT_NAME',
      'VERIFY_FLEET_SNAPSHOT_MANIFEST_SHA256',
      'VERIFY_FLEET_EXPECTED_RELAY_VERSION',
    ]) {
      delete env[key];
    }
    await expect(
      execFileAsync(
        process.execPath,
        ['scripts/verify-features/fleet-daytona.mjs', 'run', '--nonce', 'live-prerequisite-test'],
        { cwd: path.resolve('.'), env }
      )
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('VERIFY_FLEET_RELEASE_QUALIFICATION=1'),
    });
  });

  it('fails closed on malformed list/status payloads and final board leaks', () => {
    expect(() =>
      validateFleetNodesPayload({ nodes: [{ name: 'node-a', status: 'online', activeAgents: -1 }] })
    ).toThrow(/activeAgents/);
    expect(() =>
      validateFleetStatusPayload({ broker: { running: true }, node: { available: true } }, 'node-a')
    ).toThrow(/wrong node/);
    expect(
      validateFleetFinalCleanup({
        brokerNodes: [],
        brokerAgents: [],
        workspaceAgents: [],
        processAgents: [],
        processInventories: [],
        processInventoryComplete: true,
        processInventoryErrors: [],
      })
    ).toMatchObject({
      pass: true,
      brokerNodeCount: 0,
      ownedNodeRecordsAbsent: true,
      fleetNodeRecordsAbsent: true,
      processInventoriesCoverNodes: true,
    });
    expect(
      validateFleetFinalCleanup({
        brokerNodes: [{ name: 'node-a', status: 'online', live: true, handlersLive: true }],
        brokerAgents: [],
        workspaceAgents: [],
        processAgents: [],
        processInventories: [],
        processInventoryComplete: true,
        processInventoryErrors: [],
      }).pass
    ).toBe(false);
    for (const status of ['offline', 'stale']) {
      expect(
        validateFleetFinalCleanup({
          brokerNodes: [{ name: 'owned-node', status, live: false, handlersLive: false }],
          brokerAgents: [],
          workspaceAgents: [],
          processAgents: [],
          processInventories: [],
          processInventoryComplete: true,
          processInventoryErrors: [],
          ownedNodeNames: ['owned-node'],
        }),
        `an ${status} owned Fleet node record must not pass final cleanup`
      ).toMatchObject({
        pass: false,
        ownedNodeRecordsAbsent: false,
        fleetNodeRecordsAbsent: false,
        processInventoriesCoverNodes: false,
      });
    }
    expect(
      validateFleetFinalCleanup({
        brokerNodes: [{ name: 'node-a', status: 'online', live: true, handlersLive: true }],
        brokerAgents: [{ name: 'leaked' }],
        workspaceAgents: [],
        processAgents: [],
      }).pass
    ).toBe(false);
    expect(
      validateFleetFinalCleanup({
        brokerNodes: null,
        brokerAgents: null,
        workspaceAgents: [],
        processAgents: [],
      }).pass
    ).toBe(false);
    expect(
      validateFleetFinalCleanup({
        brokerNodes: [{ name: 'node-a', status: 'offline' }],
        brokerAgents: null,
        workspaceAgents: [],
        processAgents: [],
      }).pass
    ).toBe(false);
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
    expect(() => validateFleetAcceptance(missing)).toThrow(
      /exactly map all 108|exactly map every matrix operation/
    );
  });

  it('fails closed when Fleet qualification evidence loses creation, identity, or release binding', async () => {
    const matrix = await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json');
    const evidence = completeEvidence(matrix);
    evidence.provenance.matrixSha256 = createHash('sha256').update(JSON.stringify(matrix)).digest('hex');

    const partialCreation = structuredClone(evidence);
    partialCreation.operations
      .find(({ id }) => id === 'fleet-spawn-reject-droid')
      .partialCreationProof.after.agentNames.push('fleet-spawn-provider-droid-aaaaaaaaaaaaaaaa');
    expect(() => validateFleetEvidence(partialCreation, matrix)).toThrow(/no agent, worker process/);

    const forgedIdentity = structuredClone(evidence);
    forgedIdentity.operations.find(({ id }) => id === 'fleet-spawn-provider-claude').observedProvider =
      'codex';
    expect(() => validateFleetEvidence(forgedIdentity, matrix)).toThrow(
      /actual spawned agent provider\/runtime/
    );

    const swappedProvision = structuredClone(evidence);
    swappedProvision.operations.find(({ id }) => id === 'initial-task-sentinel-a').derivedFrom =
      'provision-node-b';
    expect(() => validateFleetEvidence(swappedProvision, matrix)).toThrow(
      /exact provision-node-a command execution/
    );

    const targetedContradiction = structuredClone(evidence);
    targetedContradiction.operations.find(
      ({ id }) => id === 'fleet-agent-list-node'
    ).fleetIdentityReconciliation.live.targetedNames = [];
    expect(() => validateFleetEvidence(targetedContradiction, matrix)).toThrow(
      /Fleet identity reconciliation did not prove/
    );

    const releaseStillPlaced = structuredClone(evidence);
    const releaseProof = releaseStillPlaced.operations.find(({ id }) => id === 'fleet-release')
      .fleetIdentityReconciliation.postRelease;
    releaseProof.heartbeatNames.push(`fleet-spawn-node-${NONCE.slice(0, 16)}`);
    releaseProof.heartbeatNames.sort();
    expect(() => validateFleetEvidence(releaseStillPlaced, matrix)).toThrow(
      /Fleet identity reconciliation did not prove/
    );

    const nameOnlyRelease = structuredClone(evidence);
    nameOnlyRelease.operations.find(
      ({ id }) => id === 'fleet-release-reclaims-owned-sandbox'
    ).sandboxReleaseProof.sandboxAbsent = false;
    expect(() => validateFleetEvidence(nameOnlyRelease, matrix)).toThrow(/exact owned sandbox/);
  });

  it('inspects every owned board node even when scheduling has tainted one', () => {
    const nodeA = { id: 'sandbox-a', nodeName: 'node-a' };
    const nodeB = { id: 'sandbox-b', nodeName: 'node-b' };
    expect(ownedBoardNodes([nodeA, nodeB])).toEqual([nodeA, nodeB]);
    expect(ownedBoardNodes([nodeA, null, { id: '', nodeName: 'missing' }, nodeB])).toEqual([nodeA, nodeB]);
  });

  it('requires the complete final Daytona identity sets to equal the baseline', () => {
    const baselineSandbox = { id: 'sandbox-before', name: 'ambient-before' };
    const baseline = {
      count: 1,
      sandboxIdHashes: [createHash('sha256').update(baselineSandbox.id).digest('hex')],
      sandboxNameHashes: [createHash('sha256').update(baselineSandbox.name).digest('hex')],
    };
    expect(compareDaytonaSandboxBaseline(baseline, [baselineSandbox])).toMatchObject({
      restored: true,
      countMatches: true,
      unexpectedIdHashes: [],
      unexpectedNameHashes: [],
    });

    const unexpected = { id: 'sandbox-created-with-unexpected-name', name: 'provider-generated' };
    expect(compareDaytonaSandboxBaseline(baseline, [baselineSandbox, unexpected])).toMatchObject({
      restored: false,
      countMatches: false,
      unexpectedIdHashes: [createHash('sha256').update(unexpected.id).digest('hex')],
      unexpectedNameHashes: [createHash('sha256').update(unexpected.name).digest('hex')],
    });
  });

  it('classifies accepted Daytona deletion tombstones without treating them as runnable leaks', async () => {
    const destroying = {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'relay-fleetboard-a-test',
      state: 'destroying',
      desiredState: 'destroyed',
    };
    expect(isDaytonaDeletionAccepted(destroying)).toBe(true);
    expect(
      compareDaytonaSandboxBaseline({ count: 0, sandboxIdHashes: [], sandboxNameHashes: [] }, [destroying])
    ).toMatchObject({ restored: true, countMatches: true });

    for (const state of ['started', 'stopped', 'error']) {
      const unexpected = { ...destroying, state, desiredState: 'destroyed' };
      expect(isDaytonaDeletionAccepted(unexpected)).toBe(false);
      expect(
        compareDaytonaSandboxBaseline({ count: 0, sandboxIdHashes: [], sandboxNameHashes: [] }, [unexpected])
      ).toMatchObject({ restored: false, countMatches: false });
    }
    for (const state of ['destroying', 'destroyed']) {
      const contradictory = { ...destroying, state, desiredState: 'running' };
      expect(isDaytonaDeletionAccepted(contradictory)).toBe(false);
      expect(
        compareDaytonaSandboxBaseline({ count: 0, sandboxIdHashes: [], sandboxNameHashes: [] }, [
          contradictory,
        ])
      ).toMatchObject({ restored: false, countMatches: false });
    }
    expect(isDaytonaDeletionAccepted({ ...destroying, state: 'destroyed', desiredState: 'destroyed' })).toBe(
      true
    );
  });

  it('proves deterministic Daytona deletion convergence evidence for every provider outcome', async () => {
    const sandbox = {
      id: '44444444-4444-4444-8444-444444444444',
      state: 'destroying',
      desiredState: 'destroyed',
    };
    const absent = await convergeDaytonaSandboxDeletion({
      deleteResult: { exitCode: 0 },
      listSandbox: async () => undefined,
      slaMs: 11,
      pollIntervalMs: 5,
      sleep: async () => undefined,
    });
    expect(absent).toMatchObject({ cleanupState: 'absent', converged: true, polls: 0 });

    let acceptedNow = 0;
    const acceptedStates = [sandbox, undefined];
    const accepted = await convergeDaytonaSandboxDeletion({
      deleteResult: { exitCode: 0 },
      listSandbox: async () => acceptedStates.shift(),
      now: () => acceptedNow,
      sleep: async (milliseconds) => {
        acceptedNow += milliseconds;
      },
      slaMs: 10,
      pollIntervalMs: 5,
    });
    expect(accepted).toMatchObject({
      cleanupState: 'absent',
      converged: true,
      accepted: true,
      acceptedState: 'deletion-accepted',
      polls: 1,
    });
    expect(accepted.observations[0]).toMatchObject({ presence: 'deletion-accepted' });

    let stuckNow = 0;
    const stuck = await convergeDaytonaSandboxDeletion({
      deleteResult: { exitCode: 0 },
      listSandbox: async () => sandbox,
      now: () => stuckNow,
      sleep: async (milliseconds) => {
        stuckNow += milliseconds;
      },
      slaMs: 11,
      pollIntervalMs: 5,
    });
    expect(stuck).toMatchObject({ cleanupState: 'deletion-not-converged', converged: false, accepted: true });
    expect(stuck.polls).toBe(2);

    const failed = await convergeDaytonaSandboxDeletion({
      deleteResult: { exitCode: 1 },
      listSandbox: async () => ({ ...sandbox, state: 'started', desiredState: 'running' }),
      slaMs: 10,
      pollIntervalMs: 5,
      sleep: async () => undefined,
    });
    expect(failed).toMatchObject({ cleanupState: 'delete-failed', converged: false, polls: 0 });

    const activeDespiteDesiredDestroy = await convergeDaytonaSandboxDeletion({
      deleteResult: { exitCode: 0 },
      listSandbox: async () => ({ ...sandbox, state: 'started', desiredState: 'destroyed' }),
      slaMs: 0,
      pollIntervalMs: 5,
      sleep: async () => undefined,
    });
    expect(activeDespiteDesiredDestroy).toMatchObject({
      cleanupState: 'leaked',
      converged: false,
      accepted: false,
    });
  });

  it('bounds a never-resolving Daytona inspection and records a distinct verification failure', async () => {
    let timerCalls = 0;
    const inspection = await convergeDaytonaSandboxDeletion({
      deleteResult: { exitCode: 0 },
      listSandbox: () => new Promise(() => undefined),
      slaMs: 10,
      pollIntervalMs: 5,
      setTimeoutFn: (callback) => {
        timerCalls += 1;
        callback();
        return timerCalls;
      },
      clearTimeoutFn: () => undefined,
    });
    expect(inspection).toMatchObject({
      cleanupState: 'inspection-failed',
      converged: false,
      polls: 0,
    });
    expect(inspection.inspectionFailure).toMatch(/timed out|inspection deadline/);
    expect(timerCalls).toBe(1);
  });

  it('bounds a never-resolving delete callback inside the cleanup primitive', async () => {
    let observedTimeoutMs = null;
    const resource = {
      id: '99999999-9999-4999-8999-999999999999',
      cleanupState: 'owned',
    };
    const deletion = await cleanupDaytonaSandbox({
      resource,
      persistState: async () => undefined,
      issueDelete: ({ timeoutMs }: { timeoutMs: number }) => {
        observedTimeoutMs = timeoutMs;
        return new Promise(() => undefined);
      },
      listSandbox: async () => undefined,
      now: () => 0,
      cleanupSlaMs: 25,
      setTimeoutFn: (callback) => {
        callback();
        return 1;
      },
      clearTimeoutFn: () => undefined,
    });
    expect(deletion).toMatchObject({
      cleanupState: 'delete-timeout',
      attemptType: 'daytona-delete-timeout',
      deleteIssued: true,
      converged: false,
    });
    expect(observedTimeoutMs).toBe(25);
    expect(resource.cleanupState).toBe('delete-timeout');
  });

  it('classifies the production-shaped timed-out delete result and preserves stronger provider truth', async () => {
    const timedOutDelete = async () => ({ exitCode: null, timedOut: true });
    const activeResource = {
      id: 'abababab-abab-4bab-8bab-abababababab',
      cleanupState: 'owned',
    };
    const active = await cleanupDaytonaSandbox({
      resource: activeResource,
      persistState: async () => undefined,
      issueDelete: timedOutDelete,
      listSandbox: async () => ({ id: activeResource.id, state: 'started', desiredState: 'running' }),
      now: () => 0,
      cleanupSlaMs: 25,
      slaMs: 0,
      sleep: async () => undefined,
    });
    expect(active).toMatchObject({
      cleanupState: 'delete-timeout',
      attemptType: 'daytona-delete-timeout',
      timedOut: true,
      deleteIssued: true,
      converged: false,
    });
    expect(activeResource.cleanupOutcome).toMatchObject({ timedOut: true, converged: false });

    const absentResource = {
      id: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
      cleanupState: 'owned',
    };
    const absent = await cleanupDaytonaSandbox({
      resource: absentResource,
      persistState: async () => undefined,
      issueDelete: timedOutDelete,
      listSandbox: async () => undefined,
      now: () => 0,
      cleanupSlaMs: 25,
      slaMs: 0,
      sleep: async () => undefined,
    });
    expect(absent).toMatchObject({
      cleanupState: 'absent',
      attemptType: 'daytona-delete-timeout',
      timedOut: true,
      deleteIssued: true,
      converged: true,
    });

    const acceptedResource = {
      id: 'efefefef-efef-4fef-8fef-efefefefefef',
      cleanupState: 'owned',
    };
    let acceptedNow = 0;
    const acceptedTombstone = {
      id: acceptedResource.id,
      state: 'destroying',
      desiredState: 'destroyed',
    };
    const acceptedStates = [
      { id: acceptedResource.id, state: 'started', desiredState: 'running' },
      acceptedTombstone,
    ];
    const accepted = await cleanupDaytonaSandbox({
      resource: acceptedResource,
      persistState: async () => undefined,
      issueDelete: timedOutDelete,
      listSandbox: async () => acceptedStates.shift() ?? acceptedTombstone,
      now: () => acceptedNow,
      cleanupSlaMs: 25,
      slaMs: 11,
      pollIntervalMs: 5,
      sleep: async (milliseconds) => {
        acceptedNow += milliseconds;
      },
    });
    expect(accepted).toMatchObject({
      cleanupState: 'deletion-not-converged',
      attemptType: 'daytona-delete-timeout',
      timedOut: true,
      deleteIssued: true,
      accepted: true,
      converged: false,
    });

    const inspectionFailedResource = {
      id: '12121212-1212-4212-8212-121212121212',
      cleanupState: 'owned',
    };
    const inspectionFailed = await cleanupDaytonaSandbox({
      resource: inspectionFailedResource,
      persistState: async () => undefined,
      issueDelete: timedOutDelete,
      listSandbox: () => new Promise(() => undefined),
      now: () => 0,
      cleanupSlaMs: 25,
      slaMs: 10,
      setTimeoutFn: (callback) => {
        callback();
        return 1;
      },
      clearTimeoutFn: () => undefined,
    });
    expect(inspectionFailed).toMatchObject({
      cleanupState: 'inspection-failed',
      attemptType: 'daytona-delete-timeout',
      timedOut: true,
      converged: false,
    });
    expect(inspectionFailedResource.cleanupOutcome).toMatchObject({ timedOut: true, converged: false });
  });

  it('fails closed when a prior leaked resource is absent from the final provider list', () => {
    expect(
      summarizeDaytonaCleanupStates([
        {
          type: 'daytona-sandbox',
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          cleanupState: 'leaked',
        },
      ])
    ).toMatchObject({ leakedSandboxIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] });
  });

  it('resumes cleanup observation without issuing a second Daytona delete', async () => {
    const resource = {
      id: '66666666-6666-4666-8666-666666666666',
      cleanupState: 'owned',
    };
    let deleteCalls = 0;
    const persistStates: string[] = [];
    const deleteOnce = async () => {
      deleteCalls += 1;
      return { exitCode: 0 };
    };
    const first = await cleanupDaytonaSandbox({
      resource,
      issueDelete: deleteOnce,
      persistState: async () => persistStates.push(resource.cleanupState),
      listSandbox: async () => ({ state: 'destroying', desiredState: 'destroyed' }),
      now: () => 0,
      sleep: async () => undefined,
      slaMs: 0,
      pollIntervalMs: 5,
    });
    expect(first).toMatchObject({
      resumed: false,
      deleteIssued: true,
      attemptType: 'daytona-delete',
      cleanupState: 'deletion-not-converged',
    });
    expect(deleteCalls).toBe(1);
    expect(persistStates).toEqual(['deletion-requested']);

    const second = await cleanupDaytonaSandbox({
      resource,
      issueDelete: deleteOnce,
      listSandbox: async () => undefined,
      slaMs: 10,
      pollIntervalMs: 5,
      sleep: async () => undefined,
    });
    expect(second).toMatchObject({
      resumed: true,
      deleteIssued: false,
      attemptType: 'daytona-delete-observation',
      cleanupState: 'absent',
    });
    expect(deleteCalls).toBe(1);

    const alreadyAccepted = {
      id: '88888888-8888-4888-8888-888888888888',
      cleanupState: 'deletion-accepted',
    };
    const resumedAccepted = await cleanupDaytonaSandbox({
      resource: alreadyAccepted,
      issueDelete: async () => {
        throw new Error('delete must not be reissued for accepted state');
      },
      listSandbox: async () => undefined,
      slaMs: 10,
      pollIntervalMs: 5,
      sleep: async () => undefined,
    });
    expect(resumedAccepted).toMatchObject({
      resumed: true,
      deleteIssued: false,
      attemptType: 'daytona-delete-observation',
      cleanupState: 'absent',
    });
  });

  it('records inspection failures separately from ownership refusal', async () => {
    const resource = {
      id: '77777777-7777-4777-8777-777777777777',
      cleanupState: 'owned',
    };
    let timerCalls = 0;
    const failure = await cleanupDaytonaSandbox({
      resource,
      issueDelete: async () => ({ exitCode: 0 }),
      listSandbox: () => new Promise(() => undefined),
      slaMs: 10,
      pollIntervalMs: 5,
      setTimeoutFn: (callback) => {
        timerCalls += 1;
        if (timerCalls > 1) callback();
        return timerCalls;
      },
      clearTimeoutFn: () => undefined,
    });
    expect(failure).toMatchObject({
      cleanupState: 'inspection-failed',
      attemptType: 'daytona-delete-inspection-failed',
      deleteIssued: true,
    });
    expect(resource.cleanupState).toBe('inspection-failed');
  });

  it('rejects an unauthorized Daytona cleanup target in final recovery evidence', async () => {
    const matrix = await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json');
    const evidence = completeEvidence(matrix);
    const unauthorized = structuredClone(evidence);
    unauthorized.resources.push({
      type: 'daytona-sandbox',
      id: '55555555-5555-4555-8555-555555555555',
      provider: 'daytona',
      nodeName: 'unrelated-sandbox',
      ownership: 'created-by-run',
      cleanupState: 'absent',
    });
    unauthorized.ownershipIntents.push({ type: 'daytona-sandbox', name: 'unrelated-sandbox', nonce: NONCE });
    expect(() => validateRecoveryEvidence(unauthorized, matrix, NONCE)).toThrow(
      /not authorized for recovery cleanup/
    );
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
        sandboxName: 'sandbox-scoped',
        mountPaths: ['/tests/**'],
      })
    );
    const rootMountArgs = buildFleetSpawnArgs(
      {
        provider: 'codex',
        agentName: 'worker',
        task: 'task',
        sandbox: true,
        snapshotRequired: true,
      },
      {
        expectedSnapshotId: 'snap_candidate_1666',
        expectedSnapshotManifestSha256: 'a'.repeat(64),
      }
    );
    validate('fleet-spawn-sandbox-root-mount', rootMountArgs);
    expect(rootMountArgs).toEqual(
      expect.arrayContaining([
        '--sandbox-snapshot',
        'snap_candidate_1666',
        '--sandbox-snapshot-manifest-sha256',
        'a'.repeat(64),
      ])
    );
    expect(() =>
      buildFleetSpawnArgs({
        provider: 'codex',
        agentName: 'worker',
        task: 'task',
        sandbox: true,
        snapshotRequired: true,
      })
    ).toThrow(/requires VERIFY_FLEET_SNAPSHOT_ID/);
    expect(
      buildFleetSpawnArgs({
        provider: 'codex',
        agentName: 'worker',
        task: 'task',
        sandbox: true,
        sandboxProvider: 'e2b',
      })
    ).toEqual(expect.arrayContaining(['--sandbox', '--sandbox-provider', 'e2b']));
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

  it('treats PTY model mutation as an explicit unsupported receipt', async () => {
    const runner = await readFile('scripts/verify-features/fleet-daytona.mjs', 'utf8');
    const operation = (
      await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json')
    ).operations.find(({ id }: { id: string }) => id === 'node-agent-set-model');
    expect(operation).toMatchObject({ expect: 'success', argvMustContain: ['--json'] });
    expect(runner).toContain("payload?.status === 'unsupported'");
    expect(runner).toContain('runtime=pty');
    expect(runner).toContain('payload?.applied === false');
    expect(runner).toContain('payload?.accepted === false');
  });

  it('runs positive model receipts through a typed AppServer lane on both nodes', async () => {
    const runner = await readFile('scripts/verify-features/fleet-daytona.mjs', 'utf8');
    const matrix = await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json');
    expect(matrix.operations.map(({ id }: { id: string }) => id)).toEqual(
      expect.arrayContaining(['node-agent-set-model-app-server-a', 'node-agent-set-model-app-server-b'])
    );
    expect(runner).toContain("'--runtime',");
    expect(runner).toContain("'headless',");
    expect(runner).toContain("'--protocol',");
    expect(runner).toContain("'opencode',");
    expect(runner).toContain("'node', 'agent', 'set-model'");
    expect(runner).toContain('OpenCode session confirmation');
    expect(runner).toContain('cleanupErrors');
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

  // Collecting the inventory imports the real built CLI bootstrap (the full
  // commander program with every command module) inside the test process;
  // that cold import alone exceeds the default 5s budget on a loaded machine,
  // so this test carries its own scoped timeout.
  it('derives exact command, option, argument, and hidden-surface coverage from the built CLI', async () => {
      const [matrix, expected] = await Promise.all([
        loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json'),
        readFile('tests/relayflows/cleanroom/fleet-cli-inventory.json', 'utf8').then(JSON.parse),
      ]);
      const actual = await collectFleetCliInventory('packages/cli/dist/cli/index.js');
      expect(compareFleetCliInventory(actual, expected)).toBe(actual);
      expect(inventorySha256(actual)).toBe(matrix.inventorySha256);
      expect(() => validateFleetCommandCoverage(matrix, actual)).not.toThrow();
    // This board re-covers `node agent set-model` through its two AppServer
    // operations, so nothing is deferred. The coverage probe instead drops
    // a covered command leaf from the surface: exact coverage must fail.
    const uncoveredCommand = structuredClone(matrix);
    delete uncoveredCommand.commandSurface['node agent set-model'];
    delete uncoveredCommand.multiCommandOperations['node-agent-set-model-app-server-a'];
    delete uncoveredCommand.multiCommandOperations['node-agent-set-model-app-server-b'];
    expect(() => validateFleetCommandCoverage(uncoveredCommand, actual)).toThrow(
      /commandSurface must exactly cover every candidate/
    );
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
  }, 30_000);

  it('rejects duplicate operations and an incomplete provider board', async () => {
    const matrix = await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json');
    const duplicate = structuredClone(matrix);
    duplicate.operations.push(structuredClone(duplicate.operations[0]));
    duplicate.operationCount = duplicate.operations.length;
    expect(() => validateFleetMatrix(duplicate)).toThrow(/duplicate operation/);

    const wrongCount = structuredClone(matrix);
    wrongCount.operations.pop();
    expect(() => validateFleetMatrix(wrongCount)).toThrow(/operationCount/);

    const incomplete = structuredClone(matrix);
    incomplete.operations = incomplete.operations.filter(
      ({ id }: { id: string }) => id !== 'fleet-spawn-provider-gemini'
    );
    incomplete.operations.push({ id: 'unmapped-replacement', group: 'fixture', expect: 'success' });
    expect(() => validateFleetMatrix(incomplete)).toThrow(
      /must exactly map every matrix operation|must exactly map all 108 operations/
    );
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

  it('routes candidate API fetches through the broker without exposing upstream credentials', async () => {
    let requestBody = '';
    const server = createServer((request, response) => {
      request.on('data', (chunk) => {
        requestBody += chunk;
      });
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('broker test server did not bind');
    const brokerUrl = `http://127.0.0.1:${address.port}`;
    try {
      await execFileAsync(process.execPath, ['-e', "await fetch('https://cloud.example.test/api/v1/ping')"], {
        env: {
          PATH: process.env.PATH,
          NODE_OPTIONS: `--import=${path.resolve('scripts/verify-features/candidate-credential-broker-client.mjs')}`,
          RELAY_FLEET_BROKER_URL: brokerUrl,
          RELAY_FLEET_BROKER_CAPABILITY: 'test-capability',
          RELAY_FLEET_CLOUD_ORIGIN: 'https://cloud.example.test',
          RELAY_FLEET_RELAY_ORIGIN: 'https://relay.example.test',
        },
      });
      const forwarded = JSON.parse(requestBody);
      expect(forwarded.target).toBe('https://cloud.example.test/api/v1/ping');
      expect(forwarded.headers.authorization).toBeUndefined();
      expect(forwarded.headers.cookie).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('redacts configured credentials at every nonempty length boundary', () => {
    const previousNodeToken = process.env.RELAY_NODE_TOKEN;
    const previousWorkspaceKey = process.env.RELAY_WORKSPACE_KEY;
    try {
      process.env.RELAY_NODE_TOKEN = 'q';
      process.env.RELAY_WORKSPACE_KEY = 'seven77';
      const redacted = redactFleetEvidence('q\nseven77\n12345678', ['12345678']);
      expect(redacted).not.toContain('q');
      expect(redacted).not.toContain('seven77');
      expect(redacted).not.toContain('12345678');
      expect(redacted.match(/\[REDACTED_SECRET\]/g)).toHaveLength(3);
    } finally {
      if (previousNodeToken === undefined) delete process.env.RELAY_NODE_TOKEN;
      else process.env.RELAY_NODE_TOKEN = previousNodeToken;
      if (previousWorkspaceKey === undefined) delete process.env.RELAY_WORKSPACE_KEY;
      else process.env.RELAY_WORKSPACE_KEY = previousWorkspaceKey;
    }
  });

  it('redacts every canonical live-credential prefix, not just at_/nt_/rk_/wk_', () => {
    // These prefixes are the same set packages/cli/src/cli/lib/redact.ts's
    // SECRET_PREFIX masks for display. A prior version of the local fallback
    // regex here only covered at_/nt_/rk_/wk_ and silently let br_ (broker
    // API key), rjt_live_, ot_live_, cld_at_, rth_at_, and ocl_node_enr_
    // shaped credentials straight through into recorded evidence.
    const bodies = ['0123456789abcdef', 'deadBEEF12345678'];
    for (const prefix of [
      'rk_live_',
      'rjt_live_',
      'at_live_',
      'nt_live_',
      'ot_live_',
      'cld_at_',
      'rth_at_',
      'ocl_node_enr_',
      'br_',
    ]) {
      for (const body of bodies) {
        const token = `${prefix}${body}`;
        const redacted = redactFleetEvidence(`credential=${token} in output`);
        expect(redacted, `expected ${token} to be redacted`).not.toContain(token);
        expect(redacted).toContain('[REDACTED_TOKEN]');
      }
    }
  });

  it('redacts GitHub tokens by their real underscore separator, not a hyphen', () => {
    // GitHub PAT/app-token prefixes (ghp_, gho_, ghu_, ghr_, ghs_,
    // github_pat_) are underscore-separated. A prior version of the local
    // fallback regex here required a hyphen after the prefix (gh[opurs]-),
    // which never matches a real GitHub token and was silently inert.
    for (const token of [
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'gho_abcdefghijklmnopqrstuvwxyz0123456789',
      'ghu_abcdefghijklmnopqrstuvwxyz0123456789',
      'ghr_abcdefghijklmnopqrstuvwxyz0123456789',
      'ghs_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz',
    ]) {
      const redacted = redactFleetEvidence(`Authorization: token ${token}`);
      expect(redacted, `expected ${token} to be redacted`).not.toContain(token);
      expect(redacted).toContain('[REDACTED_TOKEN]');
    }
    // A hyphenated look-alike must not be treated as a match either way; it
    // simply is not a GitHub token shape and is left to the generic
    // key=value redaction pass if it appears next to a credential label.
    expect(redactFleetEvidence('ghp-not-a-real-github-token-shape')).toContain(
      'ghp-not-a-real-github-token-shape'
    );
    // Neighboring provider-key shapes that were already correctly handled
    // (hyphen-separated) must keep working after narrowing the GitHub branch.
    for (const token of ['sk-proj-0123456789abcdefghijklmnop', 'sk-ant-0123456789abcdefghijklmnop']) {
      const redacted = redactFleetEvidence(`key=${token}`);
      expect(redacted).not.toContain(token);
      expect(redacted).toContain('[REDACTED_TOKEN]');
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

  it('validates evidence output limits in UTF-8 bytes, not UTF-16 code units', async () => {
    const matrix = await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json');
    const evidence = completeEvidence(matrix);
    evidence.provenance.matrixSha256 = createHash('sha256').update(JSON.stringify(matrix)).digest('hex');
    evidence.operations[0].stdout = '中'.repeat(6_000);
    expect(Buffer.byteLength(evidence.operations[0].stdout)).toBeGreaterThan(16 * 1024);
    expect(() => validateFleetEvidence(evidence, matrix)).toThrow(/output exceeds the evidence bound/);
  });

  it('returns a timeout result when an escaped descendant retains the output pipes', async () => {
    let escapedPid: number | undefined;
    let cleanupError: unknown;
    const startedAt = Date.now();
    try {
      const script = [
        "const { spawn } = require('node:child_process');",
        `const child = spawn(${JSON.stringify(process.execPath)}, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: ['ignore', 1, 2] });`,
        "process.stdout.write(String(child.pid) + '\\n');",
        'child.unref();',
      ].join('\n');
      const result = await executeFleetCommand([process.execPath, '-e', script], { timeoutMs: 100 });
      escapedPid = Number(result._rawStdout.trim());

      expect(result.timedOut).toBe(true);
      expect(result.durationMs).toBeLessThan(3_000);
      expect(Number.isSafeInteger(escapedPid)).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally {
      if (escapedPid && Number.isSafeInteger(escapedPid)) {
        try {
          process.kill(escapedPid, 'SIGKILL');
        } catch (error: any) {
          if (error?.code !== 'ESRCH') cleanupError = error;
        }
      }
    }
    expect(cleanupError).toBeUndefined();
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

  it('fails Fleet identity reconciliation when a targeted read contradicts live node metadata', () => {
    const nodeName = `relay-fleetboard-a-${NONCE.slice(0, 16)}`;
    const agentName = `relay-fleetboard-a-initial-${NONCE.slice(0, 16)}`;
    const valid = fleetIdentityProof('live', nodeName, agentName);
    expect(valid.pass).toBe(true);
    expect(validateFleetIdentityReconciliation(valid, { phase: 'live', nodeName, agentName })).toBe(valid);

    const targetedEmpty = evaluateFleetIdentityReconciliation({
      phase: 'live',
      nodeName,
      agentName,
      nodesPayload: {
        nodes: [
          {
            name: nodeName,
            status: 'online',
            live: true,
            handlersLive: true,
            activeAgents: 1,
            capabilities: [{ name: 'relay:live-agents:v1', metadata: { names: [agentName] } }],
          },
        ],
      },
      targetedPayload: { perNode: [], errors: [] },
      allPayload: {
        perNode: [{ name: agentName, node: nodeName }],
        unplacedRoster: [],
        errors: [],
      },
      directAgents: [{ name: agentName }],
      rosterPresent: true,
      commandErrors: [],
    });
    expect(targetedEmpty).toMatchObject({
      pass: false,
      activeAgents: 1,
      heartbeatNames: [agentName],
      targetedNames: [],
      allNodeNames: [agentName],
      directNames: [agentName],
      rosterPresent: true,
    });
    expect(() =>
      validateFleetIdentityReconciliation(targetedEmpty, { phase: 'live', nodeName, agentName })
    ).toThrow(/did not prove/);
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
    evidence.provenance.matrixSha256 = createHash('sha256').update(JSON.stringify(matrix)).digest('hex');

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
    evidence.provenance.matrixSha256 = createHash('sha256').update(JSON.stringify(matrix)).digest('hex');
    evidence.environment.releaseQualificationRequested = true;
    evidence.environment.expectedSnapshotId = 'snap_qualified_deadbeef';
    evidence.environment.expectedSnapshotName = 'relay-candidate-11.10.3-rc.1-deadbeef';
    evidence.environment.expectedSnapshotManifestSha256 = 'c'.repeat(64);
    evidence.environment.expectedRelayVersion = '11.10.3-rc.1';
    evidence.environment.expectedRelaySha = '9'.repeat(40);
    evidence.environment.expectedRelayWorkspaceId = 'rw_1234abcd';
    evidence.provenance.cliVersion = 'agent-relay v11.10.3-rc.1';
    Object.assign(evidence.provenance, {
      candidateCleanInstall: true,
      candidateInstallAttestationSha256: 'd'.repeat(64),
      candidateInstallSourceSha: evidence.environment.expectedRelaySha,
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
    const releaseProof = evidence.operations.find(
      ({ id }) => id === 'fleet-release-reclaims-owned-sandbox'
    ).sandboxReleaseProof;
    Object.assign(releaseProof, {
      cloudWorkspaceId: evidence.resources[0].cloudWorkspaceId,
      relayWorkspaceId: evidence.resources[0].relayWorkspaceId,
    });

    expect(validateFleetEvidence(evidence, matrix)).toBe(evidence);

    const sourceBuild = structuredClone(evidence);
    sourceBuild.provenance.candidateCleanInstall = false;
    expect(() => validateFleetEvidence(sourceBuild, matrix)).toThrow(/clean-installed Relay candidate/);

    const trustedCheckoutInsteadOfCandidate = structuredClone(evidence);
    trustedCheckoutInsteadOfCandidate.provenance.candidateInstallSourceSha =
      trustedCheckoutInsteadOfCandidate.provenance.sourceCommit;
    expect(() => validateFleetEvidence(trustedCheckoutInsteadOfCandidate, matrix)).toThrow(
      /source-bound clean-installed Relay candidate/
    );

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
    // Mutate only a private clone for the uniqueness probe: later probes must
    // keep node_a's real identity so the scoped-mount worker stays bound to
    // its owned sandbox under the exact-identity validator.
    const reused = structuredClone(base);
    reused.resources[1].nodeId = 'same';
    reused.resources[0].nodeId = 'same';
    expect(() => validateFleetEvidence(reused, matrix)).toThrow(/node ids are not unique/);

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

    // A credential shaped like a broker API key (br_...) or a GitHub-style
    // token, sitting outside the argv-specific --token/--api-key check (e.g.
    // surfaced through a recorded summary line), must still be caught by the
    // generic serialized-evidence scan. This is the "independent" second
    // layer FLEET_ACCEPTANCE_AUDIT.md describes; it previously shared the
    // same incomplete prefix set as the primary redactor and let br_/gh*_
    // shaped tokens straight through.
    for (const token of ['br_0123456789abcdef', 'rjt_live_0123456789abcdef', 'ghp_0123456789abcdefghij']) {
      const brokerKeyLeak = structuredClone(base);
      brokerKeyLeak.resources[1].nodeId = 'different';
      brokerKeyLeak.operations[0].summary = `${brokerKeyLeak.operations[0].summary ?? ''} token=${token}`;
      expect(() => validateFleetEvidence(brokerKeyLeak, matrix), `expected ${token} to fail closed`).toThrow(
        /unredacted token/
      );
    }

    const hiddenReleaseFailure = structuredClone(base);
    hiddenReleaseFailure.resources[1].nodeId = 'different';
    hiddenReleaseFailure.cleanup.attempts = [
      { type: 'fleet-release-support', target: 'worker-a', exitCode: 1 },
    ];
    expect(() => validateFleetEvidence(hiddenReleaseFailure, matrix)).toThrow(
      /cleanup cannot pass after release failure/
    );
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

  it('binds valid reviews to the exact immutable evidence seal', async () => {
    const matrix = await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json');
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
      deterministicEvidence: [`${matrix.operations.length} exact operation records`],
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
    first.provenance.matrixSha256 = createHash('sha256').update(JSON.stringify(matrix)).digest('hex');
    const second = structuredClone(first);
    second.nonce = 'b'.repeat(32);
    second.provenance.resolvedWorkspaceId = 'workspace_fixture_b';
    second.environment.expectedWorkspaceId = 'workspace_fixture_b';
    second.resources.forEach((resource: { nodeName: string }) => {
      resource.nodeName = resource.nodeName.replace(NONCE.slice(0, 16), second.nonce.slice(0, 16));
    });
    second.ownershipIntents.forEach((intent: { type: string; name: string }) => {
      intent.nonce = second.nonce;
      if (intent.type === 'relay-agent') {
        intent.name = `fleet-spawn-sandbox-scoped-mount-${second.nonce.slice(0, 16)}`;
      } else {
        intent.name = intent.name.replace(NONCE.slice(0, 16), second.nonce.slice(0, 16));
      }
    });
    second.operations.forEach(
      (operation: { observedAgentName?: string; partialCreationProof?: { targetName?: string } }) => {
        if (operation.observedAgentName) {
          operation.observedAgentName = operation.observedAgentName.replace(
            NONCE.slice(0, 16),
            second.nonce.slice(0, 16)
          );
        }
        if (operation.partialCreationProof?.targetName) {
          operation.partialCreationProof.targetName = operation.partialCreationProof.targetName.replace(
            NONCE.slice(0, 16),
            second.nonce.slice(0, 16)
          );
        }
      }
    );
    rebindFleetIdentityProofs(second.operations, second.nonce);
    second.resources[0].id = '33333333-3333-4333-8333-333333333333';
    second.resources[0].nodeId = 'node_c';
    second.resources[1].id = '44444444-4444-4444-8444-444444444444';
    second.resources[1].nodeId = 'node_d';
    const secondWorker = second.resources.find(
      (resource: { type: string }) => resource.type === 'relay-agent'
    );
    secondWorker.id = `fleet-spawn-sandbox-scoped-mount-${second.nonce.slice(0, 16)}`;
    Object.assign(secondWorker, {
      sandboxId: second.resources[0].id,
      sandboxNodeId: second.resources[0].nodeId,
      sandboxNodeName: second.resources[0].nodeName,
    });
    Object.assign(
      second.operations.find(({ id }: { id: string }) => id === 'fleet-release-reclaims-owned-sandbox')
        .sandboxReleaseProof,
      {
        sandboxId: second.resources[0].id,
        sandboxName: second.resources[0].nodeName,
        nodeId: second.resources[0].nodeId,
        workerName: secondWorker.id,
        ownershipNonce: second.nonce,
      }
    );
    second.criticalLifecycle.trials.forEach((trial: Record<string, unknown>, offset: number) => {
      const resource = second.resources.filter(({ type }) => type === 'daytona-sandbox')[offset % 2];
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
    // Derived from the matrix so the expectation cannot drift from the board
    // again: the two initial-task sentinels are derived observations, every
    // other operation is an independent command execution.
    expect(green.operationTotals).toEqual({
      matrixOperationCount: matrix.operations.length,
      independentCommandExecutionCount: matrix.operations.length - 2,
      derivedObservationCount: 2,
      derivedObservationIds: ['initial-task-sentinel-a', 'initial-task-sentinel-b'],
    });
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
    const reusedWorker = second.resources.find(({ type }) => type === 'relay-agent');
    reusedWorker.sandboxId = second.resources[0].id;
    reusedWorker.sandboxNodeId = second.resources[0].nodeId;
    reusedWorker.sandboxNodeName = second.resources[0].nodeName;
    const reusedReleaseProof = second.operations.find(
      ({ id }) => id === 'fleet-release-reclaims-owned-sandbox'
    ).sandboxReleaseProof;
    reusedReleaseProof.sandboxId = second.resources[0].id;
    reusedReleaseProof.sandboxName = second.resources[0].nodeName;
    reusedReleaseProof.nodeId = second.resources[0].nodeId;
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

  // This test exercises the real gate CLI end-to-end: five `node
  // scripts/verify-features/fleet-daytona.mjs` subprocess invocations (two
  // attempt gates, aggregate, and two campaign-gate runs). The gates are
  // deterministic file/hash validators with no internal waits, so the cost is
  // subprocess startup, not an intentional delay — the default 5s test budget
  // cannot cover five cold node processes. Keep the budget scoped to this
  // test instead of inflating the global Vitest timeout.
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
        evidence.resources.forEach(
          (resource: { id: string; nodeName: string; type: string }, resourceIndex: number) => {
            resource.id =
              resource.type === 'daytona-sandbox'
                ? `${index + 1}${resourceIndex + 1}111111-1111-4111-8111-111111111111`
                : `fleet-spawn-sandbox-scoped-mount-${nonce.slice(0, 16)}`;
            resource.nodeName = resource.nodeName.replace(NONCE.slice(0, 16), nonce.slice(0, 16));
          }
        );
        evidence.operations.forEach(
          (operation: {
            id: string;
            observedAgentName?: string;
            partialCreationProof?: { targetName?: string };
          }) => {
            if (operation.observedAgentName) {
              operation.observedAgentName = operation.observedAgentName.replace(
                NONCE.slice(0, 16),
                nonce.slice(0, 16)
              );
            }
            if (operation.partialCreationProof?.targetName) {
              operation.partialCreationProof.targetName = operation.partialCreationProof.targetName.replace(
                NONCE.slice(0, 16),
                nonce.slice(0, 16)
              );
            }
          }
        );
        rebindFleetIdentityProofs(evidence.operations, nonce);
        const campaignWorker = evidence.resources.find(
          (resource: { type: string }) => resource.type === 'relay-agent'
        );
        Object.assign(campaignWorker, {
          sandboxId: evidence.resources[0].id,
          sandboxNodeId: evidence.resources[0].nodeId,
          sandboxNodeName: evidence.resources[0].nodeName,
        });
        const releaseProof = evidence.operations.find(
          (operation: { id: string }) => operation.id === 'fleet-release-reclaims-owned-sandbox'
        ).sandboxReleaseProof;
        Object.assign(releaseProof, {
          sandboxId: evidence.resources[0].id,
          sandboxName: evidence.resources[0].nodeName,
          nodeId: evidence.resources[0].nodeId,
          workerName: campaignWorker.id,
          ownershipNonce: nonce,
        });
        evidence.ownershipIntents.forEach((intent: { type: string; name: string }) => {
          intent.nonce = nonce;
          intent.name =
            intent.type === 'relay-agent'
              ? campaignWorker.id
              : intent.name.replace(NONCE.slice(0, 16), nonce.slice(0, 16));
        });
        evidence.criticalLifecycle.trials.forEach((trial: Record<string, unknown>, trialIndex: number) => {
          const resource = evidence.resources.filter(({ type }) => type === 'daytona-sandbox')[
            trialIndex % 2
          ];
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
  }, 60_000);

  it('redacts a credential whose prefix falls in the dropped output prefix (RED-1 adversarial)', async () => {
    // MAX_CAPTURE_BYTES = 16 * 1024 internally.
    const MAX_CAPTURE = 16 * 1024;
    const secretBody = 'dead1234dead1234dead1234'; // 24 chars — distinctive
    const secret = 'rk_live_' + secretBody; // 32 chars total
    // Place the secret across the default 16 KiB raw-capture boundary. The
    // raw tail therefore contains only its suffix, which used to bypass the
    // token regex after truncation.
    const prefixLen = 100;
    const totalBytes = MAX_CAPTURE + prefixLen + 20;
    const suffixLen = totalBytes - prefixLen - secret.length;
    const script = `process.stdout.write('${'x'.repeat(prefixLen)}' + ${JSON.stringify(secret)} + 'x'.repeat(${suffixLen}))`;
    const result = await executeFleetCommand([process.execPath, '-e', script]);
    // Raw capture still has the full secret — sanity check.
    expect(result._rawStdout).toContain('dead1234');
    // Redaction must happen before the 16 KiB bounded public evidence tail is
    // selected; neither the dropped prefix nor retained suffix may leak.
    expect(result.stdout).not.toContain('dead1234');
    expect(result.stdout).not.toContain('rk_live_');
    expect(result.stdout).toContain('[REDACTED_TOKEN]');
  });

  it('does not checkpoint a credential suffix when a raw stderr tail becomes an error (RED-6 adversarial)', async () => {
    const matrix = await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json');
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'fleet-error-redaction-'));
    const binDir = await mkdtemp(path.join(os.tmpdir(), 'fleet-error-command-'));
    // Preserve the adversarial Stripe-prefix shape without committing a
    // live-key-shaped literal that repository push protection must reject.
    const token = ['rk', 'live', 'deadbeefdead1234'].join('_');
    const prefixLen = 100;
    const totalBytes = 16 * 1024 + prefixLen + 20;
    const suffixLen = totalBytes - prefixLen - token.length;
    const daytona = path.join(binDir, 'daytona');
    const previousPath = process.env.PATH;
    try {
      await writeFile(
        daytona,
        `#!/usr/bin/env node\nprocess.stderr.write('x'.repeat(${prefixLen}) + ${JSON.stringify(token)} + 'x'.repeat(${suffixLen})); process.exit(7);\n`
      );
      await chmod(daytona, 0o755);
      process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ''}`;
      const board = new FleetBoard(matrix, 'fleet-error-redaction-test', artifactDir);
      await board.record('fleet-status', () => board.listDaytona());
      const evidence = await readFile(path.join(artifactDir, 'evidence.json'), 'utf8');
      expect(evidence).not.toContain('dead1234');
      expect(evidence).not.toContain('rk_live_');
      expect(evidence).toContain('[REDACTED_TOKEN]');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(artifactDir, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it('preserves UTF-8 and the byte bound when output splits multibyte characters per byte', async () => {
    const expected = 'α🙂中 café — résumé\n';
    const bytes = [...Buffer.from(expected)];
    const script = [
      `const bytes = Buffer.from(${JSON.stringify(bytes)});`,
      'let index = 0;',
      'const write = () => { if (index < bytes.length) { process.stdout.write(bytes.subarray(index, index + 1)); index += 1; setImmediate(write); } };',
      'write();',
    ].join('');
    const result = await executeFleetCommand([process.execPath, '-e', script]);
    expect(result.stdout).toBe(expected);
    expect(Buffer.byteLength(result.stdout)).toBe(bytes.length);
  });

  it('keeps multibyte output within the 16 KiB evidence bound', async () => {
    // The previous test already exercises decoder correctness with one-byte
    // chunks. Emit this larger payload in one write so suite-wide CPU pressure
    // cannot turn the evidence-bound assertion into a scheduler benchmark.
    const script = "process.stdout.write('中'.repeat(12_000))";
    const result = await executeFleetCommand([process.execPath, '-e', script]);
    expect(result.stdoutBytes).toBe(Buffer.byteLength('中'.repeat(12_000)));
    expect(result.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16 * 1024);
  });

  it('redacts split stdout and stderr credentials across the bounded stream boundary (RED-5 adversarial)', async () => {
    const maxCapture = 16 * 1024;
    const cases = [
      { token: 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz', extraSecrets: [] },
      { token: 'rk_live_0123456789abcdef', extraSecrets: [] },
      { token: 'opaque-split-secret', extraSecrets: ['opaque-split-secret'] },
      {
        token: `${'x'.repeat(100)}tail-secret`,
        extraSecrets: [`${'x'.repeat(100)}tail-secret`],
      },
    ];
    for (const { token, extraSecrets } of cases) {
      for (const tokenStart of [maxCapture - 127, maxCapture - 1, maxCapture, maxCapture + 1]) {
        const chunks = [
          'x'.repeat(tokenStart),
          token.slice(0, Math.max(1, Math.floor(token.length / 2))),
          token.slice(Math.max(1, Math.floor(token.length / 2))),
          'y'.repeat(127),
        ];
        const script = [
          'const stdout = process.stdout;',
          'const stderr = process.stderr;',
          `const chunks = ${JSON.stringify(chunks)};`,
          'let index = 0;',
          'const write = () => { if (index < chunks.length) { stdout.write(chunks[index]); stderr.write(chunks[index]); index += 1; setImmediate(write); } };',
          'write();',
        ].join('');
        const result = await executeFleetCommand([process.execPath, '-e', script], { extraSecrets });
        for (const stream of [result.stdout, result.stderr]) {
          expect(stream).not.toContain(token);
          if (extraSecrets.length === 0) {
            expect(stream).not.toContain(token.slice(token.indexOf('_') + 1));
          }
          expect(stream).toContain(extraSecrets.length === 0 ? '[REDACTED_TOKEN]' : '[REDACTED_SECRET]');
        }
      }
    }
  });

  it('catches credentials embedded adjacent to leading word characters (RED-2 adversarial)', () => {
    // Before fix: \b at start prevents matching when a credential immediately
    // follows a word character, e.g. 'prefixrk_live_ABCDEF12'.
    const cases: Array<[string, string]> = [
      ['prefix', 'rk_live_0123456789abcdef'],
      ['x', 'br_0123456789abcdef'],
      ['key', 'ghp_abcdefghijklmnopqrstuvwxyz0'],
      ['api', 'at_live_0123456789abcdef'],
      ['oauth', 'rjt_live_0123456789abcdef'],
    ];
    for (const [prefix, token] of cases) {
      const adjacent = prefix + token;
      const redacted = redactFleetEvidence(adjacent);
      expect(redacted, `expected ${token} to be redacted when adjacent to '${prefix}'`).not.toContain(token);
      // The body must also be absent (not just the prefixed form)
      const bodyStart = token.indexOf('_', token.indexOf('_') + 1) + 1;
      const body = token.slice(bodyStart);
      expect(redacted, `expected body of ${token} to be absent`).not.toContain(body);
    }
    // Non-credential shapes must not be caught (no false positives)
    expect(redactFleetEvidence('ghp-not-a-real-github-token-shape')).toContain(
      'ghp-not-a-real-github-token-shape'
    );
  });

  it('requires both pre-release existence and post-release absence in the reclaim proof (RED-3 adversarial)', async () => {
    const matrix = await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json');
    const evidence = completeEvidence(matrix);
    evidence.provenance.matrixSha256 = createHash('sha256').update(JSON.stringify(matrix)).digest('hex');

    // Baseline: complete proof passes
    expect(() => validateFleetEvidence(evidence, matrix)).not.toThrow();

    const releaseOp = (ev: ReturnType<typeof completeEvidence>) =>
      ev.operations.find(({ id }: { id: string }) => id === 'fleet-release-reclaims-owned-sandbox')
        .sandboxReleaseProof;

    // Missing sandboxPresentBeforeRelease must fail
    const missingSandboxPre = structuredClone(evidence);
    delete releaseOp(missingSandboxPre).sandboxPresentBeforeRelease;
    expect(() => validateFleetEvidence(missingSandboxPre, matrix)).toThrow(/exact owned sandbox/);

    // sandboxPresentBeforeRelease: false must fail
    const sandboxNotPre = structuredClone(evidence);
    releaseOp(sandboxNotPre).sandboxPresentBeforeRelease = false;
    expect(() => validateFleetEvidence(sandboxNotPre, matrix)).toThrow(/exact owned sandbox/);

    // Missing workerPresentBeforeRelease must fail
    const missingWorkerPre = structuredClone(evidence);
    delete releaseOp(missingWorkerPre).workerPresentBeforeRelease;
    expect(() => validateFleetEvidence(missingWorkerPre, matrix)).toThrow(/exact owned sandbox/);

    // workerPresentBeforeRelease: false must fail
    const workerNotPre = structuredClone(evidence);
    releaseOp(workerNotPre).workerPresentBeforeRelease = false;
    expect(() => validateFleetEvidence(workerNotPre, matrix)).toThrow(/exact owned sandbox/);
  });

  it('preserves checkpoint JSON when a secret value equals a JSON reserved word (RED-4 adversarial)', async () => {
    const previousNodeToken = process.env.RELAY_NODE_TOKEN;
    const previousWorkspaceKey = process.env.RELAY_WORKSPACE_KEY;
    try {
      // Set a secret env var to a JSON-reserved literal
      process.env.RELAY_NODE_TOKEN = 'false';
      process.env.RELAY_WORKSPACE_KEY = 'null';
      const json = JSON.stringify(
        { status: true, enabled: false, missing: null, data: 'example-value' },
        null,
        2
      );
      const redacted = redactFleetEvidence(json);
      // Must still be valid JSON after redaction
      expect(() => JSON.parse(redacted)).not.toThrow();
      const parsed = JSON.parse(redacted);
      // JSON boolean/null literals must be preserved
      expect(parsed.enabled).toBe(false);
      expect(parsed.status).toBe(true);
      expect(parsed.missing).toBeNull();
      // Confirm the leak scanner is still fail-closed: a real credential-shaped
      // token in the evidence must still trigger the unredacted-token check.
      const matrix = await loadFleetMatrix('tests/relayflows/cleanroom/fleet-daytona.matrix.json');
      const evidence = completeEvidence(matrix);
      evidence.provenance.matrixSha256 = createHash('sha256').update(JSON.stringify(matrix)).digest('hex');
      const leakyEvidence = structuredClone(evidence);
      leakyEvidence.resources[1].nodeId = 'different';
      leakyEvidence.operations[0].summary = 'credential=br_0123456789abcdef';
      expect(() => validateFleetEvidence(leakyEvidence, matrix)).toThrow(/unredacted token/);
    } finally {
      if (previousNodeToken === undefined) delete process.env.RELAY_NODE_TOKEN;
      else process.env.RELAY_NODE_TOKEN = previousNodeToken;
      if (previousWorkspaceKey === undefined) delete process.env.RELAY_WORKSPACE_KEY;
      else process.env.RELAY_WORKSPACE_KEY = previousWorkspaceKey;
    }
  });
});
