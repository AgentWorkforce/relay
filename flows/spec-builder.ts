/**
 * A v1-shaped builder that emits a Relayflows v2 `FlowSpec`.
 *
 * The remaining v1 flows are mostly large, carefully-worded shell command
 * bodies and agent tasks. Rewriting those by hand to call a different builder
 * risks silently changing a proof; keeping the authoring calls byte-identical
 * and swapping only what they build does not. So a ported flow reads as its v1
 * self with `workflow(...)` replaced by `specWorkflow(...)`, and every
 * v1-to-v2 translation decision lives here, once, where it can be reviewed.
 *
 * ## What each v1 knob becomes
 *
 * | v1                        | v2                                                  |
 * | ------------------------- | --------------------------------------------------- |
 * | `.timeout(ms)`            | `budget.maxWallclockMs`                             |
 * | `retries: n`              | `maxIterations: n + 1` (the kernel's retry bound)   |
 * | `timeoutMs` (deterministic) | `timeoutMs`, uncapped                             |
 * | `timeoutMs` (agent)       | dropped — `AgentStepSpec` has no timeout            |
 * | `failOnError: false`      | `<command> || true`                                 |
 * | `verification.file_exists`| the `artifact_exists` named gate                    |
 * | `verification.exit_code`  | a `subprocess_gate` — callers supply the command     |
 * | `.pattern('dag'\|'pipeline')` | nothing; `dependsOn` is the only ordering       |
 * | `.maxConcurrency(n)`      | nothing; the kernel schedules the DAG               |
 * | `.onError(...)`           | nothing; a failed step fails the run                |
 * | `.channel(...)`           | nothing; v2 has no relaycast channel                |
 * | `.idleNudge(...)`         | nothing                                             |
 * | `preset` / `role` / `interactive` | nothing; not part of `AgentStepSpec`        |
 *
 * `.pattern('pipeline')` is the one mapping that can change behaviour: v1
 * ordered pipeline steps implicitly, so a flow relying on that rather than on
 * explicit `dependsOn` would lose its ordering. `toSpec()` refuses a pipeline
 * whose steps do not declare their own dependencies rather than emit a spec
 * that runs them all at once.
 */

export type V1Verification =
  | { type: 'output_contains'; value: string }
  | { type: 'file_exists'; value: string }
  | { type: 'exit_code'; value: string }
  | { type: 'json_schema'; value: Record<string, unknown> };

export interface V1AgentOptions {
  cli: string;
  model?: string;
  retries?: number;
  /** Accepted and dropped: not part of `AgentStepSpec`. */
  preset?: string;
  role?: string;
  interactive?: boolean;
  [key: string]: unknown;
}

export interface V1StepOptions {
  type?: 'deterministic';
  agent?: string;
  command?: string;
  task?: string;
  dependsOn?: string[];
  failOnError?: boolean;
  captureOutput?: boolean;
  timeoutMs?: number;
  retries?: number;
  verification?: V1Verification;
  /** v2 `recoveryMode`; defaults to `inspect` for agent steps. */
  recoveryMode?: 'reset' | 'inspect' | 'manual';
  permissions?: Record<string, unknown>;
  /**
   * The command a `verification: { type: 'exit_code' }` implied. v2 has no
   * exit-code gate for agent steps, so the check must be stated rather than
   * assumed.
   */
  exitCodeGateCommand?: string;
  [key: string]: unknown;
}

type SpecStep = Record<string, unknown> & { id: string };

export interface SpecWorkflow {
  description(text: string): SpecWorkflow;
  pattern(value: string): SpecWorkflow;
  channel(value: string): SpecWorkflow;
  maxConcurrency(value: number): SpecWorkflow;
  onError(value: string): SpecWorkflow;
  idleNudge(value: unknown): SpecWorkflow;
  timeout(ms: number): SpecWorkflow;
  agent(name: string, options: V1AgentOptions): SpecWorkflow;
  step(id: string, options: V1StepOptions): SpecWorkflow;
  toSpec(): Record<string, unknown>;
}

function gateFor(step: V1StepOptions, id: string): Record<string, unknown> | undefined {
  const verification = step.verification;
  if (verification === undefined) return undefined;
  switch (verification.type) {
    case 'output_contains':
      return { type: 'output_contains', value: verification.value };
    case 'json_schema':
      return { type: 'json_schema', value: verification.value };
    case 'file_exists':
      // The journal records the artifacts a worker measured, so this reads the
      // recorded verdict on replay instead of re-checking the disk.
      return { type: 'artifact_exists', path: verification.value };
    case 'exit_code': {
      if (!step.exitCodeGateCommand) {
        throw new Error(
          `step ${id} uses an exit_code verification, which v2 has no agent equivalent for; ` +
            'supply exitCodeGateCommand with the check it implied'
        );
      }
      return { type: 'subprocess_gate', command: step.exitCodeGateCommand };
    }
  }
}

export function specWorkflow(name: string): SpecWorkflow {
  let description: string | undefined;
  let maxWallclockMs: number | undefined;
  let pattern: string | undefined;
  // A named agent entry requires BOTH cli and model. A v1 agent that declared
  // no model was running the CLI's own default, so it becomes a step-level
  // `cli` instead of a named agent, which keeps that default rather than
  // inventing a pin.
  const agents: Record<string, { cli: string; model: string }> = {};
  const agentCli = new Map<string, string>();
  const agentRetries = new Map<string, number>();
  const steps: SpecStep[] = [];

  const api: SpecWorkflow = {
    description(text) {
      description = text;
      return api;
    },
    pattern(value) {
      pattern = value;
      return api;
    },
    // Accepted and deliberately dropped; see the table above.
    channel: () => api,
    maxConcurrency: () => api,
    onError: () => api,
    idleNudge: () => api,
    timeout(ms) {
      maxWallclockMs = ms;
      return api;
    },
    agent(agentName, options) {
      agentCli.set(agentName, options.cli);
      if (options.model !== undefined) agents[agentName] = { cli: options.cli, model: options.model };
      if (options.retries !== undefined) agentRetries.set(agentName, options.retries);
      return api;
    },
    step(id, options) {
      const dependsOn = options.dependsOn;
      const gate = gateFor(options, id);
      if (options.agent !== undefined) {
        const retries = options.retries ?? agentRetries.get(options.agent) ?? 0;
        const named = Object.hasOwn(agents, options.agent);
        steps.push({
          id,
          type: 'agent',
          ...(named ? { agent: options.agent } : { cli: agentCli.get(options.agent) ?? options.agent }),
          ...(dependsOn ? { dependsOn } : {}),
          instruction: options.task ?? '',
          maxIterations: retries + 1,
          recoveryMode: options.recoveryMode ?? 'inspect',
          ...(options.permissions ? { permissions: options.permissions } : {}),
          ...(gate ? { verification: gate } : {}),
        });
        return api;
      }
      if (typeof options.command !== 'string' || !options.command.trim()) {
        throw new Error(`step ${id} is neither an agent step nor a command`);
      }
      // v1's `failOnError: false` let a red step flow into whatever was built to
      // answer it. v2 gates every deterministic step on exit code with no
      // opt-out, so the step absorbs its own status and a later explicit gate
      // stays the thing that decides.
      const command = options.failOnError === false ? `${options.command}\n|| true` : options.command;
      const retries = options.retries ?? 0;
      steps.push({
        id,
        type: 'deterministic',
        ...(dependsOn ? { dependsOn } : {}),
        command,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(retries > 0 ? { maxIterations: retries + 1 } : {}),
        ...(gate ? { verification: gate } : {}),
      });
      return api;
    },
    toSpec() {
      if (pattern === 'pipeline') {
        const undeclared = steps.slice(1).filter((step) => !Array.isArray(step.dependsOn));
        if (undeclared.length > 0) {
          throw new Error(
            `pipeline flow ${name} relies on implicit ordering for ${undeclared
              .map((step) => step.id)
              .join(', ')}; v2 orders only by dependsOn, so declare them`
          );
        }
      }
      return {
        version: '0.1.0',
        name,
        ...(description === undefined ? {} : { description }),
        ...(Object.keys(agents).length > 0 ? { agents } : {}),
        ...(maxWallclockMs === undefined ? {} : { budget: { maxWallclockMs } }),
        steps,
      };
    },
  };
  return api;
}
