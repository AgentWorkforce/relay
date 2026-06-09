/**
 * Eval runner — executes the scenario × harness matrix against real agent CLIs
 * and writes JSON reports.
 *
 * Usage (compiled):
 *   RELAY_INTEGRATION_REAL_CLI=1 node dist/evals/runner.js [flags]
 *
 * Flags:
 *   --harness=claude,codex   Harnesses to run (default: claude,codex,gemini,grok)
 *   --scenario=01-dm-roundtrip   Run a single scenario by id
 *   --repeat=N               Repeat each scenario N times and merge (default: 1)
 *   --baseline=path.json     Compare against a prior report and fail on regression
 */
import { isCliAvailable } from '../utils/cli-helpers.js';
import { BrokerHarness, checkPrerequisites, uniqueSuffix } from '../utils/broker-harness.js';
import { sleep } from '../utils/cli-helpers.js';
import { SCENARIOS, scenarioById, scenariosByTier } from './scenarios/index.js';
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

interface Flags {
  harnesses: string[];
  scenarioIds?: string[];
  /** 'smoke' | 'realistic' | 'all'. Default 'realistic' (the benchmark). */
  tier: EvalTier | 'all';
  repeat: number;
  baseline?: string;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { harnesses: DEFAULT_HARNESSES, tier: 'realistic', repeat: 1 };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'harness' && value) flags.harnesses = value.split(',').map((s) => s.trim());
    else if (key === 'scenario' && value) flags.scenarioIds = value.split(',').map((s) => s.trim());
    else if (key === 'tier' && (value === 'smoke' || value === 'realistic' || value === 'all')) flags.tier = value;
    else if (key === 'repeat' && value) flags.repeat = Math.max(1, Number(value) || 1);
    else if (key === 'baseline' && value) flags.baseline = value;
  }
  return flags;
}

/** Select scenarios: explicit ids win, else filter by tier. */
function selectScenarios(flags: Flags): EvalScenario[] {
  if (flags.scenarioIds) {
    return flags.scenarioIds.map(scenarioById).filter((s): s is EvalScenario => Boolean(s));
  }
  return flags.tier === 'all' ? SCENARIOS : scenariosByTier(flags.tier);
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
    notes: `${passes}/${n} runs passed` + (first.notes ? ` · ${first.notes}` : ''),
  };
}

/** Run one scenario once against a fresh broker. */
async function runOnce(scenario: EvalScenario, cli: string): Promise<ScenarioResult> {
  const harness = new BrokerHarness({ channels: scenario.channels });
  await harness.start();
  try {
    return await scenario.run({ harness, cli, suffix: uniqueSuffix(), sleep });
  } finally {
    await harness.stop().catch(() => {});
  }
}

async function runHarness(
  cli: string,
  scenarios: EvalScenario[],
  repeat: number,
  startedAt: Date
): Promise<EvalReport> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    if (scenario.harnessFilter && !scenario.harnessFilter.includes(cli)) continue;
    const runs: ScenarioResult[] = [];
    for (let i = 0; i < repeat; i++) {
      process.stdout.write(`  [${cli}] ${scenario.id} (run ${i + 1}/${repeat})… `);
      try {
        const result = await runOnce(scenario, cli);
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
    harness: cli,
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
  console.log(
    `\n${harness}: sent=${(m.messageSentRate * 100).toFixed(0)}% ` +
      `phantom=${(m.phantomRate * 100).toFixed(0)}% (${m.phantomCount}) ` +
      `protocol=${(m.protocolAdherence * 100).toFixed(0)}% ` +
      `delivery=${(m.deliverySuccessRate * 100).toFixed(0)}% ` +
      `wrongChan=${m.wrongChannelReplies} ` +
      `scenarios=${m.scenariosPassed}/${m.scenariosTotal}`
  );
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
    console.error(`No scenario matched (scenario=${flags.scenarioIds?.join(',') ?? '-'}, tier=${flags.tier}).`);
    process.exit(2);
  }
  console.log(`Running ${scenarios.length} scenario(s) [tier=${flags.scenarioIds ? 'explicit' : flags.tier}]`);

  const startedAt = new Date();
  const stamp = isoStamp(startedAt);
  const matrix: MatrixReport = {
    schemaVersion: SCHEMA_VERSION,
    startedAt: startedAt.toISOString(),
    gitSha: gitSha(),
    harnesses: {},
  };

  let anyRegression = false;
  for (const cli of flags.harnesses) {
    if (!isCliAvailable(cli)) {
      console.log(`\n[${cli}] skipped — CLI not found on PATH`);
      continue;
    }
    console.log(`\n=== Harness: ${cli} ===`);
    const report = await runHarness(cli, scenarios, flags.repeat, new Date());
    const file = writeReport(report, stamp);
    const htmlFile = writeReportHtml(report, stamp);
    matrix.harnesses[cli] = report.metrics;
    printMetrics(cli, report.metrics);
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

  process.exit(anyRegression ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
