import type { AgentRelayOptions } from '../relay.js';
import type { WorkflowRunRow } from './types.js';
import { WorkflowRunner, type WorkflowEventListener, type VariableContext } from './runner.js';

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
}

/**
 * Run a workflow from a relay.yaml file with zero configuration.
 *
 * @example
 * ```typescript
 * import { runWorkflow } from "@agent-relay/broker-sdk/workflows";
 *
 * const result = await runWorkflow("workflows/daytona-migration.yaml");
 * console.log(result.status); // "completed" | "failed"
 * ```
 */
export async function runWorkflow(
  yamlPath: string,
  options: RunWorkflowOptions = {},
): Promise<WorkflowRunRow> {
  const runner = new WorkflowRunner({
    cwd: options.cwd,
    relay: options.relay,
  });

  if (options.onEvent) {
    runner.on(options.onEvent);
  }

  const config = await runner.parseYamlFile(yamlPath);
  return runner.execute(config, options.workflow, options.vars);
}
