import type { DryRunReport } from './types.js';

/**
 * Format a DryRunReport as human-readable text for terminal output.
 */
export function formatDryRunReport(report: DryRunReport): string {
  const lines: string[] = [];

  // Header
  lines.push(`Dry Run: ${report.name}`);
  const meta: string[] = [`Pattern: ${report.pattern}`];
  if (report.maxConcurrency !== undefined) {
    meta.push(`Max Concurrency: ${report.maxConcurrency}`);
  }
  lines.push(meta.join(' | '));
  if (report.description) {
    lines.push(report.description);
  }
  lines.push('');

  // Agents
  if (report.agents.length > 0) {
    lines.push(`Agents (${report.agents.length}):`);
    const maxNameLen = Math.max(...report.agents.map((a) => a.name.length));
    const maxCliLen = Math.max(...report.agents.map((a) => a.cli.length));
    for (const agent of report.agents) {
      const stepLabel = agent.stepCount === 1 ? '1 step' : `${agent.stepCount} steps`;
      const cwdInfo = agent.cwd ? ` [cwd: ${agent.cwd}]` : '';
      lines.push(
        `  ${agent.name.padEnd(maxNameLen)}  ${agent.cli.padEnd(maxCliLen)}  ${stepLabel}${cwdInfo}`
      );
    }
    lines.push('');
  }

  // Execution Plan
  if (report.waves.length > 0) {
    lines.push(`Execution Plan (${report.totalSteps} steps, ${report.estimatedWaves} waves):`);
    lines.push('');
    for (const wave of report.waves) {
      for (let i = 0; i < wave.steps.length; i++) {
        const step = wave.steps[i];
        const prefix = i === 0 ? `  Wave ${String(wave.wave).padStart(2)}:` : '          ';
        lines.push(`${prefix}  ${step.name} (${step.agent})`);
      }
    }
    lines.push('');
  }

  // Resource estimation
  if (report.estimatedPeakConcurrency !== undefined) {
    lines.push(`Resource Estimate:`);
    lines.push(`  Peak Concurrency: ${report.estimatedPeakConcurrency} agents`);
    if (report.estimatedTotalAgentSteps !== undefined) {
      lines.push(`  Total Agent Steps: ${report.estimatedTotalAgentSteps}`);
    }
    lines.push('');
  }

  // Validation summary
  if (report.errors.length > 0) {
    lines.push(`Validation: FAIL (${report.errors.length} errors, ${report.warnings.length} warnings)`);
    for (const err of report.errors) {
      lines.push(`  ERROR: ${err}`);
    }
  } else {
    lines.push(`Validation: PASS (0 errors, ${report.warnings.length} warnings)`);
  }

  if (report.warnings.length > 0) {
    for (const warn of report.warnings) {
      lines.push(`  WARNING: ${warn}`);
    }
  }

  return lines.join('\n');
}
