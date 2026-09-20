import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  buildTargetedPlan,
  changedFilesFromGit,
  loadRelayflowCorpusCases,
  validateTargetedPlan,
} from '../../scripts/verify-features/targeted-pr-plan.mjs';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
let matrix: Record<string, any>;
let manifestText: string;
let corpusCases: Array<{ id: string; timeoutSeconds: number }>;

beforeAll(async () => {
  [matrix, manifestText, corpusCases] = await Promise.all([
    readFile('tests/relayflows/cleanroom/relay.matrix.json', 'utf8').then(JSON.parse),
    readFile('.agentworkforce/features/manifest.yaml', 'utf8'),
    loadRelayflowCorpusCases(),
  ]);
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function plan(changedFiles: string[]) {
  return buildTargetedPlan({ changedFiles, matrix, manifestText, corpusCases });
}

function generatedCommandPayload(command: string): Record<string, any> {
  const match = command.match(/--payload '([A-Za-z0-9_-]+)'$/);
  if (!match) throw new Error(`generated command has no encoded payload: ${command}`);
  return JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
}

describe('targeted Flows v2 PR verification', () => {
  it('selects changes from the merge base instead of changes made only on the base branch', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-targeted-diverged-git-'));
    temporaryDirectories.push(directory);
    const git = async (...args: string[]) =>
      (await execFileAsync('git', args, { cwd: directory, timeout: 30_000 })).stdout.trim();

    await git('init');
    await git('config', 'user.email', 'targeted-flow@example.test');
    await git('config', 'user.name', 'Targeted Flow Fixture');
    await writeFile(path.join(directory, 'common.txt'), 'common\n');
    await git('add', 'common.txt');
    await git('commit', '-m', 'common ancestor');
    const ancestor = await git('rev-parse', 'HEAD');

    await git('checkout', '-b', 'candidate');
    const candidatePath = 'packages/cli/src/cli/lib/formatting.ts';
    await mkdir(path.join(directory, path.dirname(candidatePath)), { recursive: true });
    await writeFile(path.join(directory, candidatePath), 'candidate\n');
    await git('add', candidatePath);
    await git('commit', '-m', 'candidate change');
    const head = await git('rev-parse', 'HEAD');

    await git('checkout', '-b', 'advanced-base', ancestor);
    const baseOnlyPath = 'packages/sdk/src/base-only.ts';
    await mkdir(path.join(directory, path.dirname(baseOnlyPath)), { recursive: true });
    await writeFile(path.join(directory, baseOnlyPath), 'base only\n');
    await git('add', baseOnlyPath);
    await git('commit', '-m', 'base-only change');
    const base = await git('rev-parse', 'HEAD');

    expect(changedFilesFromGit(base, head, { cwd: directory })).toEqual([candidatePath]);
  });

  it('selects only the Fleet contract slice for a fleet command change', () => {
    const result = plan(['packages/cli/src/cli/commands/fleet.ts']);

    expect(result.mode).toBe('targeted');
    expect(result.selectedFeatures).toEqual(
      expect.arrayContaining(['fleet-nodes', 'fleet-nodes-pretty', 'fleet-spawn', 'fleet-release'])
    );
    expect(result.scenarios.map(({ id }: { id: string }) => id)).toEqual([
      'fleet-attach-contracts',
      'fleet-daytona-board-contract',
    ]);
    expect(result.setup.map(({ id }: { id: string }) => id)).toEqual(['build-core']);
    expect(result.scenarios.map(({ id }: { id: string }) => id)).not.toContain('two-node-fleet-e2e');
    expect(result.coverageGaps.map(({ id }: { id: string }) => id)).toContain('fleet-daytona-live-board');
    expect(() => validateTargetedPlan(result)).not.toThrow();
  });

  it('routes a shared formatting change to the table feature without selecting unrelated categories', () => {
    const result = plan(['packages/cli/src/cli/lib/formatting.ts']);

    expect(result.mode).toBe('targeted');
    expect(result.selectedFeatures).toEqual(['fleet-nodes-pretty']);
    expect(result.selectedCategories).toEqual(['fleet']);
    expect(result.unmatchedRuntimeFiles).toEqual([]);
  });

  it('routes a mounted product command to its dedicated contract scenario', () => {
    const result = plan(['packages/cli/src/cli/commands/product-surfaces.ts']);

    expect(result.mode).toBe('targeted');
    expect(result.selectedCategories).toEqual(['product-surfaces']);
    expect(result.scenarios.map(({ id }: { id: string }) => id)).toEqual(['product-surface-contracts']);
    expect(result.setup.map(({ id }: { id: string }) => id)).toEqual(['build-core']);
  });

  it('routes every feature-manifest source location to executable evidence', () => {
    const manifest = parse(manifestText);
    const locations = new Set<string>();
    for (const category of Object.values(manifest.categories) as Array<{ features: any[] }>) {
      for (const feature of category.features) {
        for (const location of String(feature.location)
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)) {
          locations.add(location);
        }
      }
    }

    for (const location of locations) {
      let result;
      try {
        result = plan([location]);
      } catch (error) {
        throw new Error(`${location}: ${error instanceof Error ? error.message : String(error)}`);
      }
      expect(result.mode, location).not.toBe('skip');
      expect(result.scenarios.length, location).toBeGreaterThan(0);
    }
  });

  it('routes files below directory-valued manifest locations', () => {
    const result = plan(['packages/sdk/src/messaging/new-delivery-route.ts']);

    expect(result.mode).toBe('targeted');
    expect(result.unmatchedRuntimeFiles).toEqual([]);
    expect(result.selectedFeatures).toEqual(
      expect.arrayContaining(['sdk-messaging', 'sdk-actions', 'sdk-sessions', 'sdk-delivery'])
    );
    expect(result.scenarios.map(({ id }: { id: string }) => id)).toContain('sdk-harness-contracts');
  });

  it('keeps category evidence eligible when it also declares feature coverage', () => {
    const result = plan(['packages/fleet/src/new-placement-helper.ts']);

    expect(result.mode).toBe('targeted');
    expect(result.selectedCategories).toEqual(['fleet']);
    expect(result.scenarios.map(({ id }: { id: string }) => id)).toEqual([
      'fleet-attach-contracts',
      'fleet-daytona-board-contract',
    ]);
  });

  it('falls back to smoke when a selected category has only a live coverage gap', () => {
    const result = plan(['packages/cli/src/cli/commands/skills.ts']);

    expect(result.mode).toBe('full-smoke');
    expect(result.fallbackReason).toBe('selected features have no targeted executable evidence');
    expect(result.scenarios.length).toBeGreaterThan(0);
    expect(result.coverageGaps.map(({ id }: { id: string }) => id)).toContain('skill-install-provider-e2e');
  });

  it('fails closed to the smoke suite for an unmapped runtime or selector change', () => {
    const unknown = plan(['packages/cli/src/cli/lib/new-runtime-surface.ts']);
    expect(unknown.mode).toBe('full-smoke');
    expect(unknown.unmatchedRuntimeFiles).toEqual(['packages/cli/src/cli/lib/new-runtime-surface.ts']);
    expect(unknown.scenarios.length).toBeGreaterThan(5);

    const self = plan(['scripts/verify-features/targeted-pr-plan.mjs']);
    expect(self.mode).toBe('full-smoke');
    expect(self.unmatchedRuntimeFiles).toEqual([]);
    expect(
      self.scenarios
        .filter(({ relayflowCorpusCase }: { relayflowCorpusCase?: string }) => relayflowCorpusCase)
        .map(({ relayflowCorpusCase }: { relayflowCorpusCase: string }) => relayflowCorpusCase)
    ).toEqual(corpusCases.map(({ id }) => id));
  });

  it('rejects full-smoke plans when the RelayFlow corpus cannot be expanded', () => {
    expect(() =>
      buildTargetedPlan({
        changedFiles: ['scripts/verify-features/targeted-pr-plan.mjs'],
        matrix,
        manifestText,
        corpusCases: [],
      })
    ).toThrow(/selected an empty RelayFlow corpus/);
  });

  it('skips documentation-only changes instead of manufacturing feature coverage', () => {
    const result = plan(['docs/fleet.md', 'CHANGELOG.md']);
    expect(result).toMatchObject({ mode: 'skip', scenarios: [], setup: [] });
  });

  it('rejects a targeted setup id that is not owned by the selected lane', () => {
    const invalid = structuredClone(matrix);
    invalid.lanes
      .find(({ id }: { id: string }) => id === 'fleet-injection-attach')
      .scenarios.find(({ id }: { id: string }) => id === 'fleet-attach-contracts').targetedSetup = [
      'not-a-setup',
    ];
    expect(() =>
      buildTargetedPlan({
        changedFiles: ['packages/cli/src/cli/commands/fleet.ts'],
        matrix: invalid,
        manifestText,
        corpusCases,
      })
    ).toThrow(/unknown fleet-injection-attach setup not-a-setup/);
  });

  it('rejects malformed output and exit gates instead of dropping them', () => {
    const invalid = structuredClone(matrix);
    invalid.lanes
      .find(({ id }: { id: string }) => id === 'fleet-injection-attach')
      .scenarios.find(({ id }: { id: string }) => id === 'fleet-attach-contracts').expectedExitCodes = [];
    expect(() =>
      buildTargetedPlan({
        changedFiles: ['packages/cli/src/cli/commands/fleet.ts'],
        matrix: invalid,
        manifestText,
        corpusCases,
      })
    ).toThrow(/expectedExitCodes must contain exit codes/);
  });

  it('generates a checked, sequential deterministic FlowSpec from the selected plan', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-targeted-pr-'));
    temporaryDirectories.push(directory);
    const planPath = path.join(directory, 'plan.json');
    const specPath = path.join(directory, 'spec.json');
    const selected = plan(['packages/cli/src/cli/lib/formatting.ts']);
    selected.scenarios[0].expectedExitCodes = [7];
    selected.scenarios[0].mustContain = ['expected-marker'];
    selected.scenarios[0].forbidOutput = ['forbidden-marker'];
    await writeFile(planPath, `${JSON.stringify(selected)}\n`);

    await execFileAsync(
      process.execPath,
      [
        '--experimental-strip-types',
        'flows/verify/targeted-pr.spec.ts',
        '--plan',
        planPath,
        '--out',
        specPath,
      ],
      { cwd: process.cwd(), timeout: 30_000 }
    );
    const spec = JSON.parse(await readFile(specPath, 'utf8'));
    expect(spec).toMatchObject({ version: '0.1.0', name: 'relay.verify.targeted-pr' });
    expect(spec.steps.map(({ id }: { id: string }) => id)).toEqual([
      'validate-targeted-plan',
      'setup-fleet-injection-attach-build-core',
      'scenario-fleet-injection-attach-fleet-attach-contracts',
      'scenario-fleet-injection-attach-fleet-daytona-board-contract',
      'targeted-verdict',
    ]);
    for (let index = 1; index < spec.steps.length; index += 1) {
      expect(spec.steps[index].dependsOn).toEqual([spec.steps[index - 1].id]);
    }
    expect(spec.steps[1].command).toContain('scripts/verify-features/targeted-command.mjs');
    const scenarioPayload = generatedCommandPayload(spec.steps[2].command);
    expect(scenarioPayload).toMatchObject({
      expectedExitCodes: [7],
      mustContain: ['expected-marker'],
      forbidOutput: ['forbidden-marker'],
    });
  });

  it('preserves expected exit and output gates in generated command execution', async () => {
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
        argv: [process.execPath, '-e', "console.log('expected-marker'); process.exit(7)"],
        cwd: process.cwd(),
        environment: {},
        timeoutSeconds: 10,
        requiredCommands: ['node'],
        requiredEnvironment: [],
        expectedExitCodes: [7],
        mustContain: ['expected-marker'],
        forbidOutput: ['forbidden-marker'],
      })
    ).toString('base64url');

    const passing = await execFileAsync(
      process.execPath,
      ['scripts/verify-features/targeted-command.mjs', '--payload', payload],
      { cwd: process.cwd(), timeout: 30_000 }
    );
    expect(passing.stdout).toContain('TARGETED_COMMAND_PASS exit=7 required=1 forbidden=1');

    const rejectedPayload = Buffer.from(
      JSON.stringify({
        version: 1,
        argv: [process.execPath, '-e', "console.log('forbidden-marker')"],
        cwd: process.cwd(),
        environment: {},
        timeoutSeconds: 10,
        requiredCommands: [],
        requiredEnvironment: [],
        expectedExitCodes: [0],
        mustContain: [],
        forbidOutput: ['forbidden-marker'],
      })
    ).toString('base64url');
    await expect(
      execFileAsync(
        process.execPath,
        ['scripts/verify-features/targeted-command.mjs', '--payload', rejectedPayload],
        { cwd: process.cwd(), timeout: 30_000 }
      )
    ).rejects.toMatchObject({ stderr: expect.stringContaining('forbidden output: forbidden-marker') });
  });

  it('checks out the requested head for manual workflow dispatch', async () => {
    const workflow = await readFile('.github/workflows/targeted-feature-verification.yml', 'utf8');
    expect(workflow).toContain(
      "ref: ${{ github.event_name == 'workflow_dispatch' && inputs.head_sha || github.sha }}"
    );
  });

  it('expands the broker binary template in a full-smoke spec', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-targeted-pr-broker-'));
    temporaryDirectories.push(directory);
    const planPath = path.join(directory, 'plan.json');
    const specPath = path.join(directory, 'spec.json');
    const selected = plan(['scripts/verify-features/targeted-pr-plan.mjs']);
    await writeFile(planPath, `${JSON.stringify(selected)}\n`);

    await execFileAsync(
      process.execPath,
      [
        '--experimental-strip-types',
        'flows/verify/targeted-pr.spec.ts',
        '--plan',
        planPath,
        '--out',
        specPath,
      ],
      { cwd: process.cwd(), timeout: 30_000 }
    );
    const spec = JSON.parse(await readFile(specPath, 'utf8'));
    const brokerScenario = spec.steps.find(
      ({ id }: { id: string }) => id === 'scenario-broker-agents-broker-process-integration'
    );
    const payload = generatedCommandPayload(brokerScenario.command);
    expect(payload.environment.AGENT_RELAY_BIN).toBe(
      path.join(process.cwd(), 'target', 'release', 'agent-relay-broker')
    );
    expect(JSON.stringify(payload)).not.toContain('{{brokerBinary}}');
    expect(payload.forbidOutput).toEqual(['# SKIP']);
  });
});
