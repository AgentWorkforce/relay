export interface StepContext {
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  history?: string[];
}

export interface WorkflowStep {
  name: string;
  execute(context: StepContext): Promise<StepContext> | StepContext;
}

export interface LoopStep extends WorkflowStep {
  condition: (context: StepContext) => boolean | Promise<boolean>;
  steps: WorkflowStep[];
  maxIterations?: number;
}

export interface Workflow {
  name: string;
  steps: WorkflowStep[];
}
