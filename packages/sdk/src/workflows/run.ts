import type { AgentRelayOptions } from '../relay.js';
import type { DryRunReport, TrajectoryConfig, WorkflowRunRow } from './types.js';
import { WorkflowRunner, type WorkflowEventListener, type VariableContext } from './runner.js';
import { formatDryRunReport } from './dry-run-format.js';

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

  if (options.onEvent) {
    runner.on(options.onEvent);
  }

  return runner.execute(config, options.workflow, options.vars);
}
