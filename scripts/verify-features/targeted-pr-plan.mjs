#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse } from 'yaml';

const DEFAULT_MATRIX = 'tests/relayflows/cleanroom/relay.matrix.json';
const DEFAULT_MANIFEST = '.agentworkforce/features/manifest.yaml';
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const SHA = /^[0-9a-f]{40}$/;

const SELF_CHECK_PATHS = new Set([
  '.agentworkforce/features/manifest.yaml',
  '.github/workflows/targeted-feature-verification.yml',
  'flows/verify/targeted-pr.spec.ts',
  'scripts/verify-features/targeted-pr-plan.mjs',
  'tests/relayflows/cleanroom/relay.matrix.json',
]);

const INERT_PATHS = [
  /^\.agentworkforce\/trajectories\//,
  /^docs\//,
  /^specs\//,
  /^web\//,
  /(?:^|\/)README\.md$/,
  /\.mdx?$/,
  /^CHANGELOG\.md$/,
  /^LICENSE$/,
];

const SUPPORT_ROUTES = [
  {
    test: (file) => file === 'packages/cli/src/cli/lib/formatting.ts',
    features: ['fleet-nodes-pretty'],
  },
  {
    test: (file) =>
      file === 'packages/cli/src/cli/agent-relay-mcp.ts' ||
      file === 'packages/cli/src/cli/lib/spawn-lifecycle.ts',
    features: ['fleet-spawn'],
  },
  {
    test: (file) => file === 'packages/cli/src/cli/commands/fleet-agent.ts',
    features: ['fleet-spawn', 'fleet-release'],
  },
  {
    test: (file) =>
      file.startsWith('packages/fleet/') ||
      file.startsWith('packages/cli/src/cli/lib/fleet-') ||
      file.startsWith('packages/cli/src/cli/lib/attach-fleet-'),
    categories: ['fleet'],
  },
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function unique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, 'en'));
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function requiredOption(name) {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertCommandSpec(spec, label) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`${label} is invalid`);
  if (!SAFE_ID.test(spec.id ?? '')) throw new Error(`${label}.id is invalid`);
  if (!Array.isArray(spec.command) || spec.command.length === 0) {
    throw new Error(`${label}.command must be non-empty`);
  }
  if (spec.command.some((entry) => typeof entry !== 'string' || !entry)) {
    throw new Error(`${label}.command must contain non-empty strings`);
  }
  if (!Number.isSafeInteger(spec.timeoutSeconds) || spec.timeoutSeconds < 1) {
    throw new Error(`${label}.timeoutSeconds must be positive`);
  }
}

function manifestCatalog(manifestText) {
  const manifest = parse(manifestText);
  const categories = manifest?.categories;
  if (!categories || typeof categories !== 'object' || Array.isArray(categories)) {
    throw new Error('feature manifest categories are invalid');
  }
  const featureById = new Map();
  const locationToFeatures = new Map();
  for (const [category, value] of Object.entries(categories)) {
    if (!Array.isArray(value?.features)) throw new Error(`feature category ${category} is invalid`);
    for (const feature of value.features) {
      if (!SAFE_ID.test(feature?.id ?? '')) throw new Error(`feature id in ${category} is invalid`);
      if (featureById.has(feature.id)) throw new Error(`duplicate feature id ${feature.id}`);
      featureById.set(feature.id, { id: feature.id, category });
      for (const location of String(feature.location ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)) {
        const current = locationToFeatures.get(location) ?? [];
        current.push(feature.id);
        locationToFeatures.set(location, current);
      }
    }
  }
  return { featureById, locationToFeatures };
}

function isInert(file) {
  return INERT_PATHS.some((pattern) => pattern.test(file));
}

function appliesToTargeted(spec) {
  return spec.profiles === undefined || spec.profiles.includes('targeted');
}

function appliesToProfile(spec, profile) {
  return spec.profiles === undefined || spec.profiles.includes(profile);
}

function scenarioMentionsFile(scenario, file) {
  return Array.isArray(scenario.command) && scenario.command.includes(file);
}

function selectedSetup(lane, scenarios, mode, profile) {
  if (mode !== 'targeted') return lane.setup.filter((step) => appliesToProfile(step, profile));
  const executable = scenarios.filter((scenario) => (scenario.kind ?? 'command') === 'command');
  const explicit = executable.filter((scenario) => Array.isArray(scenario.targetedSetup));
  if (explicit.length !== executable.length) return lane.setup.filter(appliesToTargeted);
  const ids = new Set(explicit.flatMap((scenario) => scenario.targetedSetup));
  for (const id of ids) {
    if (!lane.setup.some((step) => step.id === id)) {
      throw new Error(`scenario targetedSetup references unknown ${lane.id} setup ${id}`);
    }
  }
  return lane.setup.filter((step) => ids.has(step.id));
}

export function buildTargetedPlan({ changedFiles, matrix, manifestText, matrixBytes, manifestBytes }) {
  const files = unique(
    changedFiles
      .map((file) => String(file).replaceAll('\\', '/'))
      .filter((file) => file && !path.isAbsolute(file))
  );
  if (files.length === 0) throw new Error('changed-file set must not be empty');
  const { featureById, locationToFeatures } = manifestCatalog(manifestText);
  const selectedFeatures = new Set();
  const selectedCategories = new Set();
  const directScenarioIds = new Set();
  const unmatchedRuntimeFiles = [];
  let selfCheckChanged = false;

  for (const file of files) {
    if (SELF_CHECK_PATHS.has(file)) {
      selfCheckChanged = true;
      continue;
    }
    let matched = false;
    for (const feature of locationToFeatures.get(file) ?? []) {
      selectedFeatures.add(feature);
      selectedCategories.add(featureById.get(feature).category);
      matched = true;
    }
    for (const route of SUPPORT_ROUTES) {
      if (!route.test(file)) continue;
      matched = true;
      for (const feature of route.features ?? []) {
        if (!featureById.has(feature)) throw new Error(`support route references unknown feature ${feature}`);
        selectedFeatures.add(feature);
        selectedCategories.add(featureById.get(feature).category);
      }
      for (const category of route.categories ?? []) selectedCategories.add(category);
    }
    for (const lane of matrix.lanes ?? []) {
      for (const scenario of lane.scenarios ?? []) {
        if (scenarioMentionsFile(scenario, file)) {
          directScenarioIds.add(scenario.id);
          for (const category of scenario.coversCategories ?? lane.featureCategories ?? []) {
            selectedCategories.add(category);
          }
          matched = true;
        }
      }
    }
    if (!matched && !isInert(file) && !file.startsWith('tests/')) unmatchedRuntimeFiles.push(file);
  }

  const targeted = selectedFeatures.size > 0 || selectedCategories.size > 0 || directScenarioIds.size > 0;
  let mode =
    selfCheckChanged || unmatchedRuntimeFiles.length > 0 ? 'full-smoke' : targeted ? 'targeted' : 'skip';
  const smokeLanes = new Set(matrix.profiles?.smoke?.lanes ?? []);
  if (mode === 'full-smoke' && smokeLanes.size === 0) throw new Error('matrix has no smoke profile lanes');
  let fallbackReason = null;

  const collectPlanSteps = (selectionMode) => {
    const setup = [];
    const scenarios = [];
    const coverageGaps = [];
    for (const lane of matrix.lanes ?? []) {
      const laneScenarios = (lane.scenarios ?? []).filter((scenario) => {
        if (selectionMode === 'skip') return false;
        if (selectionMode === 'full-smoke')
          return smokeLanes.has(lane.id) && appliesToProfile(scenario, 'smoke');
        if (!appliesToTargeted(scenario)) return false;
        if (directScenarioIds.has(scenario.id)) return true;
        if ((scenario.coversFeatures ?? []).some((feature) => selectedFeatures.has(feature))) return true;
        return (
          (scenario.coversFeatures ?? []).length === 0 &&
          (scenario.coversCategories ?? []).some((category) => selectedCategories.has(category))
        );
      });
      if (laneScenarios.length === 0) continue;
      for (const step of selectedSetup(lane, laneScenarios, selectionMode, 'smoke')) {
        assertCommandSpec(step, `setup ${lane.id}/${step.id}`);
        setup.push({ ...step, laneId: lane.id });
      }
      for (const scenario of laneScenarios) {
        if ((scenario.kind ?? 'command') === 'coverage-gap') {
          coverageGaps.push({ id: scenario.id, laneId: lane.id, reason: scenario.reason });
          continue;
        }
        if ((scenario.kind ?? 'command') !== 'command') continue;
        assertCommandSpec(scenario, `scenario ${lane.id}/${scenario.id}`);
        scenarios.push({ ...scenario, laneId: lane.id });
      }
    }
    return { setup, scenarios, coverageGaps };
  };

  let { setup, scenarios, coverageGaps } = collectPlanSteps(mode);
  if (mode === 'targeted' && scenarios.length === 0) {
    const targetedCoverageGaps = coverageGaps;
    mode = 'full-smoke';
    fallbackReason = 'selected features have no targeted executable evidence';
    ({ setup, scenarios, coverageGaps } = collectPlanSteps(mode));
    coverageGaps = [...targetedCoverageGaps, ...coverageGaps].filter(
      (gap, index, gaps) =>
        gaps.findIndex((candidate) => candidate.id === gap.id && candidate.laneId === gap.laneId) === index
    );
  }

  if (mode !== 'skip' && scenarios.length === 0) {
    throw new Error(`targeted selection produced no executable scenarios for mode ${mode}`);
  }
  return {
    version: 1,
    kind: 'relay-targeted-pr-plan',
    mode,
    fallbackReason,
    changedFiles: files,
    selectedFeatures: unique([...selectedFeatures]),
    selectedCategories: unique([...selectedCategories]),
    directScenarioIds: unique([...directScenarioIds]),
    unmatchedRuntimeFiles: unique(unmatchedRuntimeFiles),
    setup,
    scenarios,
    coverageGaps,
    assumptions: ['npm dependencies are installed before the generated flow runs'],
    environmentDefaults: matrix.environmentDefaults ?? {},
    isolatedEnvironment: matrix.isolatedEnvironment ?? {},
    provenance: {
      matrixSha256: sha256(matrixBytes ?? Buffer.from(JSON.stringify(matrix))),
      manifestSha256: sha256(manifestBytes ?? Buffer.from(manifestText)),
    },
  };
}

export function validateTargetedPlan(plan) {
  if (plan?.version !== 1 || plan?.kind !== 'relay-targeted-pr-plan') {
    throw new Error('targeted plan identity is invalid');
  }
  if (!['skip', 'targeted', 'full-smoke'].includes(plan.mode))
    throw new Error('targeted plan mode is invalid');
  for (const key of [
    'changedFiles',
    'selectedFeatures',
    'selectedCategories',
    'unmatchedRuntimeFiles',
    'setup',
    'scenarios',
  ]) {
    if (!Array.isArray(plan[key])) throw new Error(`targeted plan ${key} must be an array`);
  }
  for (const [index, spec] of [...plan.setup, ...plan.scenarios].entries()) {
    assertCommandSpec(spec, `targeted plan command[${index}]`);
    if (!SAFE_ID.test(spec.laneId ?? ''))
      throw new Error(`targeted plan command[${index}].laneId is invalid`);
  }
  if (plan.mode !== 'skip' && plan.scenarios.length === 0) throw new Error('non-skip plan has no scenarios');
  for (const [name, value] of Object.entries(plan.environmentDefaults ?? {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || typeof value !== 'string') {
      throw new Error(`targeted plan environment default ${name} is invalid`);
    }
  }
  for (const [name, value] of Object.entries(plan.isolatedEnvironment ?? {})) {
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(name) ||
      typeof value !== 'string' ||
      path.isAbsolute(value) ||
      value.includes('..')
    ) {
      throw new Error(`targeted plan isolated environment ${name} is invalid`);
    }
  }
  return plan;
}

function changedFilesFromGit(base, head) {
  if (!SHA.test(base) || !SHA.test(head))
    throw new Error('--base and --head must be full lowercase Git SHAs');
  const result = spawnSync('git', ['diff', '--name-status', '-z', base, head], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git diff failed: ${(result.stderr ?? '').trim()}`);
  const fields = result.stdout.split('\0').filter(Boolean);
  const files = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (/^[RC]/.test(status)) {
      files.push(fields[index++], fields[index++]);
    } else {
      files.push(fields[index++]);
    }
  }
  return files.filter(Boolean);
}

export async function main() {
  const command = process.argv[2];
  if (command === 'validate') {
    validateTargetedPlan(JSON.parse(await readFile(requiredOption('--plan'), 'utf8')));
    console.log('TARGETED_PR_PLAN_VALID');
    return;
  }
  if (command !== 'plan') throw new Error('usage: targeted-pr-plan.mjs plan|validate');
  const matrixPath = option('--matrix', DEFAULT_MATRIX);
  const manifestPath = option('--manifest', DEFAULT_MANIFEST);
  const output = requiredOption('--output');
  const [matrixBytes, manifestBytes] = await Promise.all([readFile(matrixPath), readFile(manifestPath)]);
  const filesJson = option('--files-json');
  const changedFiles = filesJson
    ? JSON.parse(await readFile(filesJson, 'utf8'))
    : changedFilesFromGit(requiredOption('--base'), requiredOption('--head'));
  if (!Array.isArray(changedFiles)) throw new Error('--files-json must contain an array');
  const plan = buildTargetedPlan({
    changedFiles,
    matrix: JSON.parse(matrixBytes.toString('utf8')),
    manifestText: manifestBytes.toString('utf8'),
    matrixBytes,
    manifestBytes,
  });
  validateTargetedPlan(plan);
  await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'w' });
  console.log(
    `TARGETED_PR_PLAN mode=${plan.mode} features=${plan.selectedFeatures.join(',') || 'none'} scenarios=${plan.scenarios.map(({ id }) => id).join(',') || 'none'}`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
