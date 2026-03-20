import chalk from 'chalk';
import type { WorkflowEvent, WorkflowEventListener } from './runner.js';

export type LogLevel = 'verbose' | 'normal' | 'quiet' | false;

const noop: WorkflowEventListener = () => {};

/**
 * Create a default event logger that writes workflow progress to the console.
 *
 * @param level - Log verbosity: "verbose" | "normal" (default) | "quiet" | false (no-op)
 */
export function createDefaultEventLogger(level: LogLevel = 'normal'): WorkflowEventListener {
  if (level === false) return noop;

  return (event: WorkflowEvent) => {
    switch (event.type) {
      // ── Run lifecycle ──
      case 'run:started':
        if (level !== 'quiet') {
          console.log(chalk.cyan(`[workflow] run ${event.runId.slice(0, 8)}...`));
        }
        break;

      case 'run:completed':
        console.log(chalk.green(`[workflow] completed`));
        break;

      case 'run:failed':
        console.log(chalk.red(`[workflow] FAILED: ${event.error}`));
        break;

      case 'run:cancelled':
        if (level !== 'quiet') {
          console.log(chalk.yellow(`[workflow] cancelled`));
        }
        break;

      // ── Step lifecycle ──
      case 'step:started':
        if (level !== 'quiet') {
          console.log(chalk.blue(`  ● ${event.stepName} — started`));
        }
        break;

      case 'step:completed':
        if (level !== 'quiet') {
          console.log(chalk.green(`  ✓ ${event.stepName} — completed`));
        }
        break;

      case 'step:failed':
        console.log(chalk.red(`  ✗ ${event.stepName} — FAILED: ${event.error}`));
        break;

      case 'step:skipped':
        if (level !== 'quiet') {
          console.log(chalk.gray(`  ○ ${event.stepName} — skipped`));
        }
        break;

      case 'step:retrying':
        if (level !== 'quiet') {
          console.log(chalk.yellow(`  ↻ ${event.stepName} — retrying (attempt ${event.attempt})`));
        }
        break;

      case 'step:nudged':
        if (level !== 'quiet') {
          console.log(chalk.yellow(`  ⚡ ${event.stepName} — nudged (${event.nudgeCount})`));
        }
        break;

      case 'step:agent-report': {
        if (level !== 'quiet') {
          const r = event.report;
          const parts: string[] = [];
          if (r.model) parts.push(r.model);
          if (r.cost != null) parts.push(`$${r.cost.toFixed(2)}`);
          if (r.tokens) parts.push(`${r.tokens.input}+${r.tokens.output} tokens`);
          parts.push(`${r.errors.length} errors`);
          console.log(chalk.dim(`  📊 ${event.stepName} — ${parts.join(' · ')}`));
        }
        break;
      }

      // ── Broker-level events (verbose only) ──
      case 'broker:event':
        if (level === 'verbose') {
          console.log(chalk.dim(`  [broker] ${JSON.stringify(event.event)}`));
        }
        break;

      // ── Other events (verbose only) ──
      case 'step:owner-assigned':
        if (level === 'verbose') {
          console.log(chalk.dim(`  ${event.stepName} — owner: ${event.ownerName}, specialist: ${event.specialistName}`));
        }
        break;

      case 'step:review-completed':
        if (level === 'verbose') {
          console.log(chalk.dim(`  ${event.stepName} — review: ${event.decision} by ${event.reviewerName}`));
        }
        break;

      case 'step:owner-timeout':
        if (level !== 'quiet') {
          console.log(chalk.yellow(`  ⏱ ${event.stepName} — owner timeout (${event.ownerName})`));
        }
        break;

      case 'step:force-released':
        if (level === 'verbose') {
          console.log(chalk.dim(`  ${event.stepName} — force-released`));
        }
        break;
    }
  };
}
