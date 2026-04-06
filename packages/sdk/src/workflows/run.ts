import type { AgentRelayOptions } from '../relay.js';
import type { DryRunReport, TrajectoryConfig, WorkflowRunRow } from './types.js';
import { WorkflowRunner, type WorkflowEventListener } from './runner.js';
import { createDefaultEventLogger } from './default-logger.js';
import { formatDryRunReport } from './dry-run-format.js';
import type { VariableContext } from './template-resolver.js';

/**
 * Options for the `runWorkflow` convenience function.
 */
export interface RunWorkflowOptions {
  /** Workflow name within the YAML file. Defaults to the first workflow. */
  workflow?: string;
  /** Template variable substitutions for {{variable}} placeholders. */
  vars?: VariableContext;
  /** Working directory. Defaults to process.cwd(). */
  cwd?: string;
  /** AgentRelay options (all optional — broker starts automatically). */
  relay?: AgentRelayOptions;
  /** Progress callback for workflow events. */
  onEvent?: WorkflowEventListener;
  /** Override trajectory config. Set to false to disable trajectory recording. */
  trajectories?: TrajectoryConfig | false;
  /** Validate and show execution plan without running. */
  dryRun?: boolean;
  /** Resume a failed run by its ID instead of starting fresh. */
  resume?: string;
  /** Skip to a specific step (re-uses cached outputs from earlier steps). */
  startFrom?: string;
  /** Previous run ID whose cached step outputs are used with startFrom. */
  previousRunId?: string;
}

/**
 * Run a workflow from a relay.yaml file with zero configuration.
 *
 * @example
 * ```typescript
 * import { runWorkflow } from "@agent-relay/sdk/workflows";
 *
 * const result = await runWorkflow("workflows/daytona-migration.yaml");
 * console.log(result.status); // "completed" | "failed"
 * ```
 */
export async function runWorkflow(
  yamlPath: string,
  options: RunWorkflowOptions & { dryRun: true }
): Promise<DryRunReport>;
export async function runWorkflow(yamlPath: string, options?: RunWorkflowOptions): Promise<WorkflowRunRow>;
export async function runWorkflow(
  yamlPath: string,
  options: RunWorkflowOptions = {}
): Promise<WorkflowRunRow | DryRunReport> {
  const runner = new WorkflowRunner({
    cwd: options.cwd,
    relay: options.relay,
  });

  const config = await runner.parseYamlFile(yamlPath);

  // Allow programmatic trajectory override
  if (options.trajectories !== undefined) {
    config.trajectories = options.trajectories;
  }

  // Auto-detect DRY_RUN env var so existing scripts get dry-run for free
  const isDryRun = options.dryRun ?? !!process.env.DRY_RUN;

  if (isDryRun) {
    const report = runner.dryRun(config, options.workflow, options.vars);
    console.log(formatDryRunReport(report));
    return report;
  }

  // Attach default console logger so callers get progress output without
  // needing to wire up their own handler.
  runner.on(createDefaultEventLogger('normal'));

  if (options.onEvent) {
    runner.on(options.onEvent);
  }

  // Resume a previous run if requested
  const resumeRunId = options.resume ?? process.env.RESUME_RUN_ID;
  if (resumeRunId) {
    return runner.resume(resumeRunId, options.vars);
  }

  const startFrom = options.startFrom ?? process.env.START_FROM;
  const previousRunId = options.previousRunId ?? process.env.PREVIOUS_RUN_ID;
  const executeOptions = startFrom ? { startFrom, previousRunId } : undefined;

  return runner.execute(config, options.workflow, options.vars, executeOptions);
}
