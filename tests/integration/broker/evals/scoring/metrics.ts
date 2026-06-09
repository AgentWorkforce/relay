/**
 * Aggregate per-scenario results into a single MetricSet for a harness.
 */
import type { MetricSet, ScenarioResult } from '../types.js';

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 1;
  return Math.min(1, numerator / denominator);
}

/** Roll up scenario results into the headline metrics for one harness. */
export function aggregateMetrics(results: ScenarioResult[]): MetricSet {
  const total = results.length;
  let sent = 0;
  let expected = 0;
  let phantomCount = 0;
  let totalIntents = 0;
  let wrongChannelReplies = 0;
  let deliveryOkCount = 0;
  let adherenceSum = 0;
  let adherenceCount = 0;
  let scenariosPassed = 0;

  for (const r of results) {
    sent += r.sent;
    expected += r.expected;
    phantomCount += r.phantoms.length;
    totalIntents += r.totalIntents;
    wrongChannelReplies += r.wrongChannelReplies;
    if (r.deliveryOk) deliveryOkCount += 1;
    if (r.protocolAdherence !== null) {
      adherenceSum += r.protocolAdherence;
      adherenceCount += 1;
    }
    if (r.pass) scenariosPassed += 1;
  }

  return {
    messageSentRate: rate(sent, expected),
    phantomRate: totalIntents > 0 ? phantomCount / totalIntents : 0,
    phantomCount,
    protocolAdherence: adherenceCount > 0 ? adherenceSum / adherenceCount : 1,
    deliverySuccessRate: rate(deliveryOkCount, total),
    wrongChannelReplies,
    scenariosPassed,
    scenariosTotal: total,
  };
}
