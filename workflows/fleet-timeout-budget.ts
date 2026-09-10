export type RelayFlowTimeoutStep = {
  name: string;
  timeoutMs?: number;
  retries?: number;
  agent?: string;
  dependsOn?: string[];
};

export type RelayFlowTimeoutConfig = {
  workflows?: Array<{ steps?: RelayFlowTimeoutStep[] }>;
  agents?: Array<{ name: string; constraints?: { retries?: number } }>;
  errorHandling?: { maxRetries?: number };
};

export type FleetTimeoutBudgetOptions = {
  outerJobTimeoutMs: number;
  consumerSetupReserveMs: number;
  consumerCleanupReserveMs: number;
  guardMs: number;
};

export type FleetTimeoutPlan = FleetTimeoutBudgetOptions & {
  criticalPathMs: number;
  workflowTimeoutMs: number;
  innerWorkflowBudgetMs: number;
  steps: Array<{
    name: string;
    retries: number;
    timeoutMs: number;
    dependsOn: string[];
    criticalPathMs: number;
  }>;
};

export function deriveFleetTimeoutPlan(
  config: RelayFlowTimeoutConfig,
  options: FleetTimeoutBudgetOptions
): FleetTimeoutPlan {
  for (const [name, value] of Object.entries(options)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`timeout budget ${name} is invalid`);
  }
  const definitions = (config.workflows ?? []).flatMap((workflow) => workflow.steps ?? []);
  if (!definitions.length) throw new Error('RelayFlow timeout config has no steps');
  const agents = new Map((config.agents ?? []).map((agent) => [agent.name, agent]));
  const steps = new Map<string, RelayFlowTimeoutStep>();
  for (const step of definitions) {
    if (!step.name || steps.has(step.name)) throw new Error(`RelayFlow timeout config has duplicate step ${step.name}`);
    steps.set(step.name, step);
  }
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const criticalPath = (name: string): number => {
    const cached = memo.get(name);
    if (cached !== undefined) return cached;
    if (visiting.has(name)) throw new Error(`RelayFlow timeout dependency cycle at ${name}`);
    const step = steps.get(name);
    if (!step) throw new Error(`RelayFlow timeout dependency is missing step ${name}`);
    if (!Number.isSafeInteger(step.timeoutMs) || step.timeoutMs < 1) {
      throw new Error(`RelayFlow step ${name} has no positive timeout`);
    }
    const agentRetries = step.agent ? agents.get(step.agent)?.constraints?.retries : undefined;
    const retries = step.retries ?? agentRetries ?? config.errorHandling?.maxRetries ?? 0;
    if (!Number.isSafeInteger(retries) || retries < 0) throw new Error(`RelayFlow step ${name} has invalid retries`);
    visiting.add(name);
    const dependencyBudget = (step.dependsOn ?? []).reduce(
      (max, dependency) => Math.max(max, criticalPath(dependency)),
      0
    );
    visiting.delete(name);
    const total = step.timeoutMs * (retries + 1) + dependencyBudget;
    memo.set(name, total);
    return total;
  };
  const stepPlans = definitions.map((step) => ({
    name: step.name,
    timeoutMs: step.timeoutMs as number,
    dependsOn: step.dependsOn ?? [],
    retries:
      step.retries ??
      (step.agent ? agents.get(step.agent)?.constraints?.retries : undefined) ??
      config.errorHandling?.maxRetries ??
      0,
    criticalPathMs: criticalPath(step.name),
  }));
  const criticalPathMs = Math.max(...stepPlans.map(({ criticalPathMs: value }) => value));
  const workflowTimeoutMs = criticalPathMs + options.guardMs;
  const innerWorkflowBudgetMs =
    options.outerJobTimeoutMs - options.consumerSetupReserveMs - options.consumerCleanupReserveMs;
  if (workflowTimeoutMs > innerWorkflowBudgetMs) {
    throw new Error(
      `Fleet workflow timeout ${workflowTimeoutMs}ms exceeds inner qualification budget ${innerWorkflowBudgetMs}ms`
    );
  }
  return { ...options, criticalPathMs, workflowTimeoutMs, innerWorkflowBudgetMs, steps: stepPlans };
}
