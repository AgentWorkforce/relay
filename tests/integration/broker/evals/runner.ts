/**
 * Eval runner — executes the scenario × harness matrix against real agent CLIs
 * and writes JSON reports.
 *
 * Usage (compiled):
 *   RELAY_INTEGRATION_REAL_CLI=1 node dist/evals/runner.js [flags]
 *
 * Flags:
 *   --harness=claude,codex              Harnesses to run (default: claude,codex,gemini,grok)
 *   --harness=opencode:mimo-v2-flash-free  OpenCode with a specific model (free tier)
 *   --scenario=01-dm-roundtrip          Run a single scenario by id
 *   --tier=smoke|realistic|all          Default: realistic
 *   --group=messaging|lifecycle|all     Scenario group (default: messaging)
 *   --repeat=N                          Repeat each scenario N times (default: 1; use 10 for reliability)
 *   --baseline=path.json                Compare against a prior report; exit 1 on regression
 *
 * Lifecycle eval quick-start (finds minimum onboarding for 10/10 reliability):
 *   RELAY_INTEGRATION_REAL_CLI=1 node dist/evals/runner.js \
 *     --group=lifecycle --repeat=10 --harness=claude
 */
import { isCliAvailable } from '../utils/cli-helpers.js';
import { BrokerHarness, checkPrerequisites, uniqueSuffix } from '../utils/broker-harness.js';
import { sleep } from '../utils/cli-helpers.js';
import { SCENARIOS, LIFECYCLE_EVAL_SCENARIOS, ALL_SCENARIOS, scenarioById, scenariosByTier } from './scenarios/index.js';
import { aggregateMetrics } from './scoring/metrics.js';
import {
  compareReports,
  gitSha,
  isoStamp,
  readReport,
  writeMatrix,
  writeMatrixHtml,
  writeReport,
  writeReportHtml,
} from './report/write.js';
import { SCHEMA_VERSION } from './types.js';
import type { EvalReport, EvalScenario, EvalTier, MatrixReport, MetricSet, ScenarioResult } from './types.js';

const DEFAULT_HARNESSES = ['claude', 'codex', 'gemini', 'grok'];

/** Shorthand aliases for Claude model ids. */
const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
};

/**
 * Parse a harness specifier:
 *   "claude"                    → {cli: "claude"}
 *   "claude:haiku"              → {cli: "claude", model: "claude-haiku-4-5-20251001"}
 *   "claude:sonnet"             → {cli: "claude", model: "claude-sonnet-4-6"}
 *   "opencode:mimo-v2-flash-free" → {cli: "opencode", model: "opencode/mimo-v2-flash-free"}
 */
function parseHarnessSpec(spec: string): { cli: string; model?: string } {
  const colon = spec.indexOf(':');
  if (colon === -1) return { cli: spec };
  const cli = spec.slice(0, colon);
  const modelSuffix = spec.slice(colon + 1);
  if (cli === 'claude') {
    const model = CLAUDE_MODEL_ALIASES[modelSuffix] ?? modelSuffix;
    return { cli, model };
  }
  // Qualify bare model names with their provider prefix (opencode → opencode/…).
  const model = modelSuffix.includes('/') ? modelSuffix : `${cli}/${modelSuffix}`;
  return { cli, model };
}

type ScenarioGroup = 'messaging' | 'lifecycle' | 'all';

interface Flags {
  harnesses: string[];
  scenarioIds?: string[];
  /** 'smoke' | 'realistic' | 'all'. Default 'realistic' (the benchmark). */
  tier: EvalTier | 'all';
  /** Scenario group. Default 'messaging'. */
  group: ScenarioGroup;
  repeat: number;
  baseline?: string;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { harnesses: DEFAULT_HARNESSES, tier: 'realistic', group: 'messaging', repeat: 1 };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'harness' && value) flags.harnesses = value.split(',').map((s) => s.trim());
    else if (key === 'scenario' && value) flags.scenarioIds = value.split(',').map((s) => s.trim());
    else if (key === 'tier' && (value === 'smoke' || value === 'realistic' || value === 'all')) flags.tier = value;
    else if (key === 'group' && (value === 'messaging' || value === 'lifecycle' || value === 'all')) flags.group = value as ScenarioGroup;
    else if (key === 'repeat' && value) flags.repeat = Math.max(1, Number(value) || 1);
    else if (key === 'baseline' && value) flags.baseline = value;
  }
  return flags;
}

/** Select scenarios: explicit ids win, else filter by group + tier. */
function selectScenarios(flags: Flags): EvalScenario[] {
  if (flags.scenarioIds) {
    return flags.scenarioIds.map(scenarioById).filter((s): s is EvalScenario => Boolean(s));
  }
  const pool =
    flags.group === 'lifecycle'
      ? LIFECYCLE_EVAL_SCENARIOS
      : flags.group === 'all'
        ? ALL_SCENARIOS
        : SCENARIOS;
  if (flags.group === 'lifecycle') return pool; // lifecycle scenarios have their own tier structure
  return flags.tier === 'all' ? pool : pool.filter((s) => s.tier === flags.tier);
}

/** Merge repeated runs of one scenario into a single result. */
function mergeRepeats(results: ScenarioResult[]): ScenarioResult {
  const n = results.length;
  const passes = results.filter((r) => r.pass).length;
  const adherence = results.filter((r) => r.protocolAdherence !== null);
  const first = results[0];
  return {
    id: first.id,
    title: first.title,
    pass: passes / n >= 0.5,
    agents: first.agents,
    transcript: first.transcript,
    sent: Math.round(results.reduce((s, r) => s + r.sent, 0) / n),
    expected: first.expected,
    phantoms: results.flatMap((r) => r.phantoms),
    totalIntents: results.reduce((s, r) => s + r.totalIntents, 0),
    protocolAdherence:
      adherence.length > 0
        ? adherence.reduce((s, r) => s + (r.protocolAdherence ?? 0), 0) / adherence.length
        : null,
    wrongChannelReplies: results.reduce((s, r) => s + r.wrongChannelReplies, 0),
    deliveryOk: results.every((r) => r.deliveryOk),
    events: {
      relayInbound: results.reduce((s, r) => s + r.events.relayInbound, 0),
      dropped: results.reduce((s, r) => s + r.events.dropped, 0),
      aclDenied: results.reduce((s, r) => s + r.events.aclDenied, 0),
    },
    spawnCount: results.reduce((s, r) => s + (r.spawnCount ?? 0), 0),
    releaseCount: results.reduce((s, r) => s + (r.releaseCount ?? 0), 0),
    onboarding: first.onboarding,
    notes: `${passes}/${n} runs passed` + (first.notes ? ` · ${first.notes}` : ''),
  };
}

/** Run one scenario once against a fresh broker. */
async function runOnce(scenario: EvalScenario, spec: { cli: string; model?: string }): Promise<ScenarioResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // opencode reads its model from an env var; pass it through to the broker process.
  if (spec.model && spec.cli === 'opencode') env['OPENCODE_MODEL'] = spec.model;

  const harness = new BrokerHarness({ channels: scenario.channels, env });
  await harness.start();
  try {
    // Pass model in context so scenarios can forward it to spawnAgent (e.g. claude:haiku).
    return await scenario.run({ harness, cli: spec.cli, model: spec.model, suffix: uniqueSuffix(), sleep });
  } finally {
    await harness.stop().catch(() => {});
  }
}

async function runHarness(
  spec: { cli: string; model?: string },
  scenarios: EvalScenario[],
  repeat: number,
  startedAt: Date
): Promise<EvalReport> {
  const label = spec.model ? `${spec.cli}:${spec.model.split('/').pop()}` : spec.cli;
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    if (scenario.harnessFilter && !scenario.harnessFilter.includes(spec.cli)) continue;
    const runs: ScenarioResult[] = [];
    for (let i = 0; i < repeat; i++) {
      process.stdout.write(`  [${label}] ${scenario.id} (run ${i + 1}/${repeat})… `);
      try {
        const result = await runOnce(scenario, spec);
        runs.push(result);
        console.log(result.pass ? 'PASS' : 'FAIL');
      } catch (err) {
        console.log(`ERROR: ${(err as Error)?.message ?? err}`);
        runs.push(failedResult(scenario, `error: ${(err as Error)?.message ?? err}`));
      }
    }
    results.push(repeat > 1 ? mergeRepeats(runs) : runs[0]);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    harness: label,
    gitSha: gitSha(),
    env: { realCli: process.env.RELAY_INTEGRATION_REAL_CLI === '1', repeat },
    metrics: aggregateMetrics(results),
    scenarios: results,
  };
}

function failedResult(scenario: EvalScenario, notes: string): ScenarioResult {
  return {
    id: scenario.id,
    title: scenario.title,
    pass: false,
    agents: [],
    transcript: [],
    sent: 0,
    expected: 0,
    phantoms: [],
    totalIntents: 0,
    protocolAdherence: null,
    wrongChannelReplies: 0,
    deliveryOk: false,
    events: { relayInbound: 0, dropped: 0, aclDenied: 0 },
    notes,
  };
}

function printMetrics(harness: string, m: MetricSet): void {
  const lifecycle =
    m.spawnRate !== undefined
      ? ` spawn=${(m.spawnRate * 100).toFixed(0)}% release=${((m.releaseRate ?? 0) * 100).toFixed(0)}%`
      : '';
  console.log(
    `\n${harness}: sent=${(m.messageSentRate * 100).toFixed(0)}% ` +
      `phantom=${(m.phantomRate * 100).toFixed(0)}% (${m.phantomCount}) ` +
      `protocol=${(m.protocolAdherence * 100).toFixed(0)}% ` +
      `delivery=${(m.deliverySuccessRate * 100).toFixed(0)}% ` +
      `wrongChan=${m.wrongChannelReplies}${lifecycle} ` +
      `scenarios=${m.scenariosPassed}/${m.scenariosTotal}`
  );
}

/**
 * Print a reliability matrix for lifecycle scenarios (spawn/release × onboarding variant).
 * Shows pass rate per onboarding variant to identify the minimum effective text.
 */
function printLifecycleMatrix(allReports: Array<{ harness: string; report: EvalReport }>): void {
  console.log('\n── Lifecycle reliability matrix (spawn / release, by onboarding variant) ──');
  console.log('Variant     | Scenario                    | ' + allReports.map((r) => r.harness.padEnd(8)).join(' | '));
  console.log('-'.repeat(40 + allReports.length * 11));

  // Group scenarios by their base id (without the :variant suffix).
  const bases = new Map<string, Map<string, Map<string, ScenarioResult>>>();
  for (const { harness, report } of allReports) {
    for (const sc of report.scenarios) {
      if (!sc.onboarding) continue;
      const colonIdx = sc.id.lastIndexOf(':');
      const base = colonIdx >= 0 ? sc.id.slice(0, colonIdx) : sc.id;
      if (!bases.has(base)) bases.set(base, new Map());
      const byVariant = bases.get(base)!;
      if (!byVariant.has(sc.onboarding)) byVariant.set(sc.onboarding, new Map());
      byVariant.get(sc.onboarding)!.set(harness, sc);
    }
  }

  const variants = ['bare', 'one-liner', 'brief', 'skill'];
  for (const [base, byVariant] of bases) {
    for (const variant of variants) {
      const row = byVariant.get(variant);
      if (!row) continue;
      const cols = allReports.map(({ harness }) => {
        const sc = row.get(harness);
        if (!sc) return '  —     ';
        return (sc.pass ? 'PASS' : 'FAIL').padEnd(8);
      });
      const label = `${variant.padEnd(11)} | ${base.padEnd(27)} | `;
      console.log(label + cols.join(' | '));
    }
    console.log('');
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  if (process.env.RELAY_INTEGRATION_REAL_CLI !== '1') {
    console.error('Refusing to run: set RELAY_INTEGRATION_REAL_CLI=1 to run real-CLI evals.');
    process.exit(2);
  }
  const prereq = checkPrerequisites();
  if (prereq) {
    console.error(`Prerequisite missing: ${prereq}`);
    process.exit(2);
  }

  const scenarios = selectScenarios(flags);
  if (scenarios.length === 0) {
    console.error(`No scenario matched (scenario=${flags.scenarioIds?.join(',') ?? '-'}, tier=${flags.tier}, group=${flags.group}).`);
    process.exit(2);
  }

  const isLifecycle = flags.group === 'lifecycle';
  console.log(
    `Running ${scenarios.length} scenario(s) [group=${flags.group}, tier=${flags.scenarioIds ? 'explicit' : flags.tier}, repeat=${flags.repeat}]`
  );
  if (isLifecycle && flags.repeat < 5) {
    console.warn('Tip: use --repeat=10 to measure reliability rates accurately.');
  }

  const startedAt = new Date();
  const stamp = isoStamp(startedAt);
  const matrix: MatrixReport = {
    schemaVersion: SCHEMA_VERSION,
    startedAt: startedAt.toISOString(),
    gitSha: gitSha(),
    harnesses: {},
  };

  const allReports: Array<{ harness: string; report: EvalReport }> = [];
  let anyRegression = false;

  for (const harnessSpec of flags.harnesses) {
    const spec = parseHarnessSpec(harnessSpec);
    if (!isCliAvailable(spec.cli)) {
      console.log(`\n[${harnessSpec}] skipped — CLI not found on PATH`);
      continue;
    }
    const label = spec.model ? `${spec.cli}:${spec.model.split('/').pop()}` : spec.cli;
    console.log(`\n=== Harness: ${label} ===`);
    const report = await runHarness(spec, scenarios, flags.repeat, new Date());
    const file = writeReport(report, stamp);
    const htmlFile = writeReportHtml(report, stamp);
    matrix.harnesses[label] = report.metrics;
    allReports.push({ harness: label, report });
    printMetrics(label, report.metrics);
    console.log(`  report → ${file}`);
    console.log(`  html   → ${htmlFile}`);

    if (flags.baseline) {
      try {
        const deltas = compareReports(readReport(flags.baseline), report);
        const regressions = deltas.filter((d) => d.regression);
        for (const d of regressions) {
          console.log(`  ⚠ regression: ${d.metric} ${d.baseline} → ${d.current} (${d.delta > 0 ? '+' : ''}${d.delta.toFixed(3)})`);
        }
        if (regressions.length > 0) anyRegression = true;
      } catch (err) {
        console.error(`  baseline compare failed: ${(err as Error)?.message ?? err}`);
      }
    }
  }

  if (Object.keys(matrix.harnesses).length > 1 || flags.harnesses.length > 1) {
    const matrixFile = writeMatrix(matrix, stamp);
    const matrixHtml = writeMatrixHtml(matrix, stamp);
    console.log(`\nmatrix → ${matrixFile}`);
    console.log(`matrix html → ${matrixHtml}`);
  }

  if (isLifecycle && allReports.length > 0) {
    printLifecycleMatrix(allReports);
  }

  process.exit(anyRegression ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
