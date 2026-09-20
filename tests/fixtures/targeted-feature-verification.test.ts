import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { buildTargetedPlan, validateTargetedPlan } from '../../scripts/verify-features/targeted-pr-plan.mjs';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
let matrix: Record<string, any>;
let manifestText: string;

beforeAll(async () => {
  [matrix, manifestText] = await Promise.all([
    readFile('tests/relayflows/cleanroom/relay.matrix.json', 'utf8').then(JSON.parse),
    readFile('.agentworkforce/features/manifest.yaml', 'utf8'),
  ]);
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function plan(changedFiles: string[]) {
  return buildTargetedPlan({ changedFiles, matrix, manifestText });
}

describe('targeted Flows v2 PR verification', () => {
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
      })
    ).toThrow(/unknown fleet-injection-attach setup not-a-setup/);
  });

  it('generates a checked, sequential deterministic FlowSpec from the selected plan', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-targeted-pr-'));
    temporaryDirectories.push(directory);
    const planPath = path.join(directory, 'plan.json');
    const specPath = path.join(directory, 'spec.json');
    const selected = plan(['packages/cli/src/cli/lib/formatting.ts']);
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
    expect(brokerScenario.command).toContain(
      path.join(process.cwd(), 'target', 'release', 'agent-relay-broker')
    );
    expect(brokerScenario.command).not.toContain('{{brokerBinary}}');
  });
});
